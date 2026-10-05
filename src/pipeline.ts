import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "./config.ts";
import { normalizeAudio, splitAudio, trackLoudness, prepareSourceAudio } from "./audio.ts";
import { generateNotes } from "./structure.ts";
import { transcribe, transcriptionProvider } from "./transcribe.ts";
import { getSettings } from "./settings.ts";
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

/** Explains an empty transcript: which track was silent, or that there was sound but no speech. */
async function emptyRecordingMessage(file: string): Promise<string> {
  let tracks: { max: number; mean: number }[] = [];
  try {
    tracks = await trackLoudness(file);
  } catch {
    // Fall through to the generic message.
  }
  const names = tracks.length === 2 ? ["звук созвона", "микрофон"] : tracks.map((_, i) => `дорожка ${i + 1}`);
  const describe = (t: { max: number }, i: number) =>
    `${names[i]}: ${t.max <= -60 ? "тишина" : t.max <= -35 ? `очень тихо (${Math.round(t.max)} дБ)` : `звук есть (${Math.round(t.max)} дБ)`}`;
  const details = tracks.map(describe).join("; ");
  if (tracks.length && tracks.every((t) => t.max <= -60)) {
    return `Запись пустая — в файле тишина (${details}). Звук не захватывался: проверь разрешения на микрофон и запись системного звука.`;
  }
  return `Речь не распознана${details ? ` (${details})` : ""}. Послушай запись ниже: если там тишина или шум — звук не захватывался.`;
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

  const provider = transcriptionProvider(meeting.transcriptionChoice ?? (await getSettings()).transcriptionChoice);
  const duration = meeting.durationSec ?? 0;
  const temp = provider.sourceAudio ? await fs.mkdtemp(path.join(os.tmpdir(), "voicenotes-source-")) : null;
  let parts = [{ file: audio, offset: 0 }];
  try {
    if (temp) {
      const source = path.join(temp, "source.flac");
      await prepareSourceAudio(meetingPath(id, meeting.originalFile), source);
      parts = [{ file: source, offset: 0 }];
    }
    if (duration > provider.maxPartSeconds) {
      parts = (await splitAudio(parts[0]!.file, provider.maxPartSeconds)).map((file, i) => ({ file, offset: i * provider.maxPartSeconds }));
    }
    console.log(`[${id}] transcribing ${Math.round(duration / 60)} min in ${parts.length} part(s) with ${provider.name}`);
    const result = await transcribe(parts, { language: meeting.language, glossary: meeting.glossary }, provider);
    if (!result.segments.length) {
      throw new Error(await emptyRecordingMessage(meetingPath(id, meeting.originalFile)));
    }
    await saveTranscript(id, { language: result.language, segments: result.segments, speakerDiarization: result.speakerDiarization, timestamps: result.timestamps });
    return updateMeeting(id, {
      // With auto notes off, notes are made later: from the UI button or from Claude via MCP.
      status: (await getSettings()).autoNotes ? "structuring" : "done",
      detectedLanguage: result.language ?? undefined,
      usage: {
        ...meeting.usage,
        transcriptionModel: `${provider.name}/${result.model}`,
        transcriptionSeconds: result.audioSeconds || duration,
      },
    });
  } finally {
    if (temp) await fs.rm(temp, { recursive: true, force: true });
    if (!temp && parts.length > 1) await Promise.all(parts.map((p) => fs.rm(p.file, { force: true })));
  }
}

async function runStructuring(meeting: Meeting): Promise<Meeting> {
  const id = meeting.id;
  meeting = await updateMeeting(id, { status: "structuring", error: undefined, failedStage: undefined });
  const transcript = await getTranscript(id);
  if (!transcript) throw new Error("Нет расшифровки — сначала нужно расшифровать запись.");

  console.log(`[${id}] generating notes`);
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
