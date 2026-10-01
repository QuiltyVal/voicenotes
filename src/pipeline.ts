import fs from "node:fs/promises";
import { config } from "./config.ts";
import { normalizeAudio, splitAudio } from "./audio.ts";
import { generateNotes } from "./structure.ts";
import { transcribe, transcriptionProvider } from "./transcribe.ts";
import {
  getMeeting,
  getTranscript,
  listMeetings,
  meetingPath,
  saveNotes,
  saveTranscript,
  updateMeeting,
  type Meeting,
} from "./storage.ts";

// One meeting at a time: keeps API usage predictable and ffmpeg from hogging a small VPS.
const queue: string[] = [];
let draining = false;

export function enqueue(id: string): void {
  if (!queue.includes(id)) queue.push(id);
  void drain();
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const id = queue.shift()!;
      try {
        await processMeeting(id);
      } catch (err) {
        console.error(`[${id}] unexpected pipeline error`, err);
      }
    }
  } finally {
    draining = false;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function runTranscription(meeting: Meeting): Promise<Meeting> {
  const id = meeting.id;
  meeting = await updateMeeting(id, { status: "transcribing", error: undefined, failedStage: undefined });

  const audio = meetingPath(id, "audio.mp3");
  if (!(await fileExists(audio)) || !meeting.durationSec) {
    console.log(`[${id}] converting audio`);
    let durationSec: number | undefined;
    try {
      durationSec = await normalizeAudio(meetingPath(id, meeting.originalFile), audio);
    } catch (err) {
      console.error(`[${id}]`, err);
      const missing = (err as Error).message.startsWith("Не удалось запустить ffmpeg");
      throw new Error(
        missing
          ? "Не найден ffmpeg. Выполни npm install ещё раз или установи ffmpeg и укажи FFMPEG_PATH в .env."
          : "Не получилось прочитать аудио: файл повреждён или формат не поддерживается.",
      );
    }
    meeting = await updateMeeting(id, { durationSec });
  }

  const provider = transcriptionProvider();
  if (!provider) throw new Error("Не задан ключ для расшифровки: впиши OPENAI_API_KEY или MISTRAL_API_KEY в .env.");

  const duration = meeting.durationSec ?? 0;
  const parts =
    duration > provider.maxPartSeconds
      ? (await splitAudio(audio, provider.maxPartSeconds)).map((file, i) => ({ file, offset: i * provider.maxPartSeconds }))
      : [{ file: audio, offset: 0 }];

  console.log(`[${id}] transcribing ${Math.round(duration / 60)} min in ${parts.length} part(s) with ${provider.name}`);
  try {
    const result = await transcribe(parts, { language: meeting.language, glossary: meeting.glossary });
    if (!result.segments.length) {
      throw new Error("В записи не распознано ни одного слова. Проверь, что микрофон или звук вкладки действительно записывались.");
    }
    await saveTranscript(id, { language: result.language, segments: result.segments });
    return updateMeeting(id, {
      status: "structuring",
      detectedLanguage: result.language ?? undefined,
      usage: {
        ...meeting.usage,
        transcriptionModel: `${provider.name}/${result.model}`,
        transcriptionSeconds: result.audioSeconds || duration,
      },
    });
  } finally {
    if (parts.length > 1) await Promise.all(parts.map((p) => fs.rm(p.file, { force: true })));
  }
}

async function runStructuring(meeting: Meeting): Promise<Meeting> {
  const id = meeting.id;
  meeting = await updateMeeting(id, { status: "structuring", error: undefined, failedStage: undefined });
  const transcript = await getTranscript(id);
  if (!transcript) throw new Error("Нет расшифровки — сначала нужно расшифровать запись.");

  console.log(`[${id}] generating notes with ${config.claudeModel}`);
  const { notes, usage } = await generateNotes(meeting, transcript.segments);
  await saveNotes(id, notes);

  // Pre-fill speaker names Claude could infer, without overriding names the user set.
  const labels = new Set(transcript.segments.map((s) => s.speaker));
  const speakers = { ...meeting.speakers };
  for (const p of notes.participants) {
    if (p.name.trim() && labels.has(p.speaker) && !speakers[p.speaker]?.trim()) speakers[p.speaker] = p.name.trim();
  }

  return updateMeeting(id, {
    status: "done",
    title: meeting.title.trim() || notes.title,
    speakers,
    usage: {
      ...meeting.usage,
      claudeModel: usage.model,
      claudeInputTokens: usage.inputTokens,
      claudeOutputTokens: usage.outputTokens,
    },
  });
}

async function processMeeting(id: string): Promise<void> {
  let meeting = await getMeeting(id);
  if (!meeting) return;
  let stage: "transcribing" | "structuring" = meeting.status === "structuring" ? "structuring" : "transcribing";
  try {
    if (meeting.status === "uploaded" || meeting.status === "transcribing") {
      meeting = await runTranscription(meeting);
    }
    if (meeting.status === "structuring") {
      stage = "structuring";
      meeting = await runStructuring(meeting);
      console.log(`[${id}] done`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${id}] ${stage} failed: ${message}`);
    await updateMeeting(id, { status: "error", error: message, failedStage: stage });
  }
}

export async function retry(id: string): Promise<Meeting> {
  const meeting = await getMeeting(id);
  if (!meeting) throw new Error("Встреча не найдена");
  const updated = await updateMeeting(id, {
    status: meeting.failedStage ?? "transcribing",
    error: undefined,
  });
  enqueue(id);
  return updated;
}

export async function regenerateNotes(id: string): Promise<Meeting> {
  const updated = await updateMeeting(id, { status: "structuring", error: undefined, failedStage: undefined });
  enqueue(id);
  return updated;
}

/** Picks up meetings that were mid-processing when the server stopped. */
export async function resumePending(): Promise<void> {
  for (const m of await listMeetings()) {
    if (m.status === "uploaded" || m.status === "transcribing" || m.status === "structuring") enqueue(m.id);
  }
}
