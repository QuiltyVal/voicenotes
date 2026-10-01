import fs from "node:fs/promises";
import path from "node:path";
import { Mistral } from "@mistralai/mistralai";
import { MistralError } from "@mistralai/mistralai/models/errors";
import type { TranscriptionResponse } from "@mistralai/mistralai/models/components";
import { config } from "./config.ts";
import type { Segment } from "./storage.ts";
import {
  SpeakerLabels,
  pushSegment,
  type AudioPart,
  type TranscribeOptions,
  type TranscriptionResult,
} from "./transcription-common.ts";

let client: Mistral | undefined;

function mistral(): Mistral {
  if (!config.mistralApiKey) {
    throw new Error("Не задан MISTRAL_API_KEY в .env — расшифровка через Mistral невозможна.");
  }
  client ??= new Mistral({
    apiKey: config.mistralApiKey,
    ...(config.mistralBaseUrl ? { serverURL: config.mistralBaseUrl } : {}),
    timeoutMs: 20 * 60 * 1000,
    retryConfig: {
      strategy: "backoff",
      backoff: { initialInterval: 2000, maxInterval: 60_000, exponent: 2, maxElapsedTime: 10 * 60 * 1000 },
      retryConnectionErrors: true,
    },
  });
  return client;
}

async function transcribeFile(file: string, opts: TranscribeOptions): Promise<TranscriptionResponse> {
  const content = new Uint8Array(await fs.readFile(file));
  const request = {
    model: config.voxtralModel,
    file: { fileName: path.basename(file), content },
    diarize: true,
    timestampGranularities: ["segment" as const],
  };
  const hints = {
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.glossary.length ? { contextBias: opts.glossary.slice(0, 100) } : {}),
  };
  try {
    return await mistral().audio.transcriptions.complete({ ...request, ...hints });
  } catch (err) {
    // Some option combinations (e.g. language + timestamps, or glossary entries the API
    // rejects) come back as 400/422. Retry once without the optional hints.
    const rejected = err instanceof MistralError && (err.statusCode === 400 || err.statusCode === 422);
    if (!rejected || Object.keys(hints).length === 0) throw err;
    console.warn(`Voxtral rejected language/glossary hints (${err.message}); retrying without them.`);
    return mistral().audio.transcriptions.complete(request);
  }
}

/** Converts Voxtral responses to segments. Speaker ids are only consistent within one request. */
export function mistralSegments(responses: { response: TranscriptionResponse; offset: number }[]): Segment[] {
  const labels = new SpeakerLabels();
  const segments: Segment[] = [];
  for (const [part, { response, offset }] of responses.entries()) {
    const raw = response.segments?.length
      ? response.segments
      : [{ text: response.text, start: 0, end: 0, speakerId: null }];
    for (const seg of raw) {
      const key = `${responses.length > 1 ? `${part}:` : ""}${seg.speakerId ?? "unknown"}`;
      pushSegment(segments, { ...seg, speaker: labels.label(key) }, offset);
    }
  }
  return segments;
}

export async function transcribeWithMistral(parts: AudioPart[], opts: TranscribeOptions): Promise<TranscriptionResult> {
  const responses = [];
  let audioSeconds = 0;
  for (const part of parts) {
    const response = await transcribeFile(part.file, opts);
    audioSeconds += Number(response.usage?.promptAudioSeconds ?? 0);
    responses.push({ response, offset: part.offset });
  }
  return {
    language: responses[0]?.response.language ?? null,
    segments: mistralSegments(responses),
    audioSeconds,
    model: config.voxtralModel,
  };
}
