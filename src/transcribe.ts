import { config, type TranscriptionProvider } from "./config.ts";
import type { AudioPart, TranscribeOptions, TranscriptionResult } from "./transcription-common.ts";
import { transcribeWithMistral } from "./transcribe-mistral.ts";
import { transcribeWithOpenAI } from "./transcribe-openai.ts";
import { transcribeWithOpenRouter } from "./transcribe-openrouter.ts";
import { defaultTranscriptionChoice, type TranscriptionChoice } from "./transcription-models.ts";

export interface ProviderInfo {
  name: TranscriptionProvider;
  model: string;
  maxPartSeconds: number;
  sourceAudio: boolean;
}
export function transcriptionProvider(choice: TranscriptionChoice = defaultTranscriptionChoice()): ProviderInfo {
  switch (choice) {
    case "openrouter-voxtral":
      // OpenRouter has a 60-second upstream timeout: use the tested two-minute parts.
      return { name: "openrouter", model: "mistralai/voxtral-mini-transcribe", maxPartSeconds: 120, sourceAudio: true };
    case "mistral-voxtral":
      return { name: "mistral", model: config.voxtralModel, maxPartSeconds: 170 * 60, sourceAudio: false };
    case "gpt-transcribe":
      return { name: "openai", model: "gpt-transcribe", maxPartSeconds: 120, sourceAudio: true };
    default:
      return { name: "openai", model: config.openaiTranscribeModel, maxPartSeconds: 20 * 60, sourceAudio: false };
  }
}
export function transcribe(parts: AudioPart[], opts: TranscribeOptions, provider = transcriptionProvider()): Promise<TranscriptionResult> {
  switch (provider.name) {
    case "mistral": return transcribeWithMistral(parts, opts);
    case "openrouter": return transcribeWithOpenRouter(parts, opts);
    case "openai": return transcribeWithOpenAI(parts, opts, provider.model);
  }
}
