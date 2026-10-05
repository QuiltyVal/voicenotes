import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import type { TranscriptionDiarized } from "openai/resources/audio/transcriptions";
import { extractClip } from "./audio.ts";
import { config } from "./config.ts";
import type { Segment } from "./storage.ts";
import {
  SpeakerLabels,
  pushSegment,
  type AudioPart,
  type TranscribeOptions,
  type TranscriptionResult,
} from "./transcription-common.ts";

let client: OpenAI | undefined;

function openai(): OpenAI {
  if (!config.openaiApiKey) {
    throw new Error("Не задан OPENAI_API_KEY в .env — расшифровка через OpenAI невозможна.");
  }
  client ??= new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 4, timeout: 20 * 60 * 1000 });
  return client;
}

function isDiarizeModel(model: string): boolean {
  return model.includes("diarize");
}

/** Voice samples of speakers from the first part, so later parts keep the same labels. */
interface KnownSpeakers {
  names: string[];
  references: string[];
}

interface RawSegment {
  speaker: string | null;
  start: number;
  end: number;
  text: string;
}

async function requestPart(
  file: string,
  opts: TranscribeOptions,
  known: KnownSpeakers | null,
  model: string,
): Promise<{ segments: RawSegment[]; seconds: number }> {
  const upload = await toFile(await fs.readFile(file), path.basename(file), { type: path.extname(file) === ".flac" ? "audio/flac" : "audio/mpeg" });
  const language = opts.language ? { language: opts.language } : {};

  if (!isDiarizeModel(model)) {
    // Models without diarization: plain text, one speaker, no timestamps.
    const res = await openai().audio.transcriptions.create({
      model,
      file: upload,
      response_format: "json",
      ...language,
    });
    return { segments: [{ speaker: null, start: 0, end: 0, text: res.text }], seconds: 0 };
  }

  // The SDK's overloads don't cover diarized_json, hence the cast.
  const res = (await openai().audio.transcriptions.create({
    model,
    file: upload,
    response_format: "diarized_json",
    chunking_strategy: "auto",
    ...language,
    ...(known ? { known_speaker_names: known.names, known_speaker_references: known.references } : {}),
  })) as unknown as TranscriptionDiarized;

  return {
    segments: res.segments.map((s) => ({ speaker: s.speaker, start: s.start, end: s.end, text: s.text })),
    seconds: res.duration ?? 0,
  };
}

async function transcribePart(file: string, opts: TranscribeOptions, known: KnownSpeakers | null, model: string) {
  try {
    return await requestPart(file, opts, known, model);
  } catch (err) {
    // A rejected language code or voice sample shouldn't fail the whole meeting.
    const hinted = Boolean(opts.language || known);
    if (!(err instanceof OpenAI.BadRequestError) || !hinted) throw err;
    console.warn(`OpenAI rejected language/speaker hints (${err.message}); retrying without them.`);
    return requestPart(file, { ...opts, language: "" }, null, model);
  }
}

/** Cuts a 2-10 s sample of each of the (up to 4) most talkative speakers. */
async function buildReferences(segments: Segment[], part: AudioPart): Promise<KnownSpeakers | null> {
  const bySpeaker = new Map<string, { total: number; best: Segment | null }>();
  for (const seg of segments) {
    const duration = seg.end - seg.start;
    const entry = bySpeaker.get(seg.speaker) ?? { total: 0, best: null };
    entry.total += duration;
    if (duration >= 2 && (!entry.best || duration > entry.best.end - entry.best.start)) entry.best = seg;
    bySpeaker.set(seg.speaker, entry);
  }
  const top = [...bySpeaker.entries()]
    .filter(([, e]) => e.best)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 4);
  if (!top.length) return null;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voicenotes-ref-"));
  try {
    const known: KnownSpeakers = { names: [], references: [] };
    for (const [label, { best }] of top) {
      const clip = path.join(dir, `${label}.wav`);
      await extractClip(part.file, best!.start - part.offset, Math.min(10, best!.end - best!.start), clip);
      known.names.push(label);
      known.references.push(`data:audio/wav;base64,${(await fs.readFile(clip)).toString("base64")}`);
    }
    return known;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

export async function transcribeWithOpenAI(parts: AudioPart[], opts: TranscribeOptions, model = config.openaiTranscribeModel): Promise<TranscriptionResult> {
  const labels = new SpeakerLabels();
  const segments: Segment[] = [];
  let known: KnownSpeakers | null = null;
  let audioSeconds = 0;

  try {
    for (const [i, part] of parts.entries()) {
      const result = await transcribePart(part.file, opts, known, model);
      audioSeconds += result.seconds;
      const knownNames = new Set(known?.names);
      const partSegments: Segment[] = [];
      for (const seg of result.segments) {
        // Known speakers come back under the label we gave them; others are A, B, ... per request.
        const speaker =
          !isDiarizeModel(model) ? "" : seg.speaker && knownNames.has(seg.speaker) ? seg.speaker : labels.label(`${i}:${seg.speaker ?? "unknown"}`);
        pushSegment(partSegments, { ...seg, speaker }, part.offset);
      }
      segments.push(...partSegments);

      if (i === 0 && parts.length > 1 && isDiarizeModel(model)) {
        known = await buildReferences(partSegments, part).catch((err) => {
          console.warn("Could not build speaker samples; parts will be labelled separately.", err);
          return null;
        });
      }
    }
  } catch (err) {
    if (err instanceof OpenAI.AuthenticationError) throw new Error("OpenAI: неверный OPENAI_API_KEY.");
    if (err instanceof OpenAI.RateLimitError) throw new Error("OpenAI: превышен лимит запросов или закончились деньги на балансе.");
    if (err instanceof OpenAI.APIError) throw new Error(`OpenAI API ${err.status ?? ""}: ${err.message}`);
    throw err;
  }

  return { language: opts.language || null, segments, audioSeconds, model, speakerDiarization: isDiarizeModel(model), timestamps: isDiarizeModel(model) };
}
