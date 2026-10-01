import { config, type TranscriptionProvider } from "./config.ts";
import type { AudioPart, TranscribeOptions, TranscriptionResult } from "./transcription-common.ts";
import { transcribeWithMistral } from "./transcribe-mistral.ts";
import { transcribeWithOpenAI } from "./transcribe-openai.ts";

export interface ProviderInfo {
  name: TranscriptionProvider;
  model: string;
  /** Longest audio sent in one request; longer recordings are split into parts. */
  maxPartSeconds: number;
}

export function transcriptionProvider(): ProviderInfo | null {
  switch (config.transcriptionProvider) {
    case "mistral":
      // Voxtral accepts up to ~3 hours per request.
      return { name: "mistral", model: config.voxtralModel, maxPartSeconds: 170 * 60 };
    case "openai":
      // Files must stay under 25 MB and long requests get slow; 20-minute parts are safe.
      return { name: "openai", model: config.openaiTranscribeModel, maxPartSeconds: 20 * 60 };
    default:
      return null;
  }
}

export function transcribe(parts: AudioPart[], opts: TranscribeOptions): Promise<TranscriptionResult> {
  switch (config.transcriptionProvider) {
    case "mistral":
      return transcribeWithMistral(parts, opts);
    case "openai":
      return transcribeWithOpenAI(parts, opts);
    default:
      throw new Error("Не задан ключ для расшифровки: впиши OPENAI_API_KEY или MISTRAL_API_KEY в .env.");
  }
}
