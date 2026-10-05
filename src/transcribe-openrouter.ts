import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";
import type { Segment } from "./storage.ts";
import { SpeakerLabels, pushSegment, type AudioPart, type TranscribeOptions, type TranscriptionResult } from "./transcription-common.ts";

interface OpenRouterResponse {
  text: string;
  language?: string;
  segments?: { start: number; end: number; text: string; speaker?: string | number | null }[];
  usage?: { seconds?: number; cost?: number };
}
/** Speakers returned for separate requests cannot be assumed to identify the same person. */
export function openrouterSegments(responses: { response: OpenRouterResponse; offset: number }[]): Segment[] {
  const labels = new SpeakerLabels();
  const segments: Segment[] = [];
  for (const [part, { response, offset }] of responses.entries()) {
    const raw = response.segments?.length ? response.segments : [{ text: response.text, start: 0, end: 0 }];
    for (const seg of raw) {
      const hasSpeaker = seg.speaker !== undefined && seg.speaker !== null;
      const speaker = hasSpeaker ? labels.label(`${part}:${seg.speaker}`) : "";
      pushSegment(segments, { ...seg, speaker }, offset);
    }
  }
  return segments;
}
export async function transcribeWithOpenRouter(parts: AudioPart[], opts: TranscribeOptions): Promise<TranscriptionResult> {
  if (!config.openrouterApiKey) throw new Error("Не задан OPENROUTER_API_KEY на сервере.");
  const responses: { response: OpenRouterResponse; offset: number }[] = [];
  let audioSeconds = 0;
  for (const part of parts) {
    const audio = await fs.readFile(part.file);
    if (audio.length > 25 * 1024 * 1024) throw new Error("Фрагмент аудио превышает лимит OpenRouter 25 МБ.");
    const options = { diarize: true, ...(opts.glossary.length ? { context_bias: opts.glossary.slice(0, 100) } : {}) };
    // Language and timestamps cannot be combined on Voxtral: leave language detection automatic.
    let res: Response;
    try {
      res = await fetch(`${config.openrouterBaseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openrouterApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "mistralai/voxtral-mini-transcribe",
          input_audio: { data: audio.toString("base64"), format: path.extname(part.file).slice(1) },
          response_format: "verbose_json", timestamp_granularities: ["segment"],
          provider: { options: { mistral: options, "mistral/eu": options } },
        }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      // No automatic retries: an interrupted request might already have been billed.
      throw new Error("OpenRouter: ответ не получен. Проверь историю запросов перед повтором, запрос мог быть оплачен.");
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401 || res.status === 403) throw new Error("OpenRouter: проверь API-ключ и его доступ.");
      if (res.status === 402) throw new Error("OpenRouter: недостаточно кредитов.");
      if (res.status === 429) throw new Error("OpenRouter: превышен лимит запросов.");
      throw new Error(`OpenRouter: ошибка API ${res.status}.`);
    }
    const response = await res.json() as OpenRouterResponse;
    if (typeof response.text !== "string") throw new Error("OpenRouter вернул ответ без текста расшифровки.");
    responses.push({ response, offset: part.offset });
    audioSeconds += Number(response.usage?.seconds ?? 0);
  }
  return {
    language: responses[0]?.response.language ?? null,
    segments: openrouterSegments(responses), audioSeconds,
    model: "mistralai/voxtral-mini-transcribe",
    speakerDiarization: responses.some(({ response }) => response.segments?.some((s) => s.speaker !== undefined && s.speaker !== null)) ,
    timestamps: responses.every(({ response }) => Boolean(response.segments?.length)),
  };
}
