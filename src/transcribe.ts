import fs from "node:fs/promises";
import path from "node:path";
import { Mistral } from "@mistralai/mistralai";
import { MistralError } from "@mistralai/mistralai/models/errors";
import type { TranscriptionResponse } from "@mistralai/mistralai/models/components";
import { config } from "./config.ts";
import type { Segment, Transcript } from "./storage.ts";

let client: Mistral | undefined;

function mistral(): Mistral {
  if (!config.mistralApiKey) {
    throw new Error("Не задан MISTRAL_API_KEY в .env — расшифровка невозможна.");
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

interface TranscribeOptions {
  language: string;
  glossary: string[];
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

/** Maps raw Voxtral speaker ids to S1, S2, ... in order of first appearance. */
export function toSegments(responses: { response: TranscriptionResponse; offset: number; part: number }[]): Segment[] {
  const labels = new Map<string, string>();
  const segments: Segment[] = [];
  const multipart = responses.length > 1;

  for (const { response, offset, part } of responses) {
    const raw = response.segments?.length
      ? response.segments
      : [{ text: response.text, start: 0, end: 0, speakerId: null }];
    for (const seg of raw) {
      const text = seg.text.trim();
      if (!text) continue;
      // Speaker ids are only consistent within one request, so parts get their own labels.
      const rawId = `${multipart ? `${part}:` : ""}${seg.speakerId ?? "unknown"}`;
      let label = labels.get(rawId);
      if (!label) {
        label = `S${labels.size + 1}`;
        labels.set(rawId, label);
      }
      segments.push({
        speaker: label,
        start: (seg.start ?? 0) + offset,
        end: (seg.end ?? seg.start ?? 0) + offset,
        text,
      });
    }
  }
  return segments;
}

export async function transcribe(
  parts: { file: string; offset: number }[],
  opts: TranscribeOptions,
): Promise<Transcript & { audioSeconds: number }> {
  const responses = [];
  let audioSeconds = 0;
  for (const [i, part] of parts.entries()) {
    const response = await transcribeFile(part.file, opts);
    audioSeconds += Number(response.usage?.promptAudioSeconds ?? 0);
    responses.push({ response, offset: part.offset, part: i });
  }
  return {
    language: responses[0]?.response.language ?? null,
    segments: toSegments(responses),
    audioSeconds,
  };
}
