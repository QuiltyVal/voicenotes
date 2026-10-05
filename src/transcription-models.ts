import { config } from "./config.ts";

export const TRANSCRIPTION_CHOICES = ["openai-default", "gpt-transcribe", "openrouter-voxtral", "mistral-voxtral"] as const;
export type TranscriptionChoice = (typeof TRANSCRIPTION_CHOICES)[number];
export function isTranscriptionChoice(value: unknown): value is TranscriptionChoice {
  return typeof value === "string" && (TRANSCRIPTION_CHOICES as readonly string[]).includes(value);
}
export function defaultTranscriptionChoice(): TranscriptionChoice {
  return config.transcriptionProvider === "openrouter" ? "openrouter-voxtral"
    : config.transcriptionProvider === "mistral" ? "mistral-voxtral" : "openai-default";
}
export function transcriptionModels() {
  return [
    { id: "openai-default", label: config.openaiTranscribeModel.includes("diarize") ? "GPT-4o — с разделением по говорящим" : config.openaiTranscribeModel, available: Boolean(config.openaiApiKey), description: "Текущая модель OpenAI. Разделение по говорящим доступно у версии diarize." },
    { id: "gpt-transcribe", label: "GPT Transcribe", available: Boolean(config.openaiApiKey), description: "Расшифровка исходного аудио. Без таймкодов и разделения по говорящим." },
    { id: "openrouter-voxtral", label: "Voxtral — через OpenRouter", available: Boolean(config.openrouterApiKey), description: "Таймкоды. В проверенном ответе разделение по говорящим отсутствовало. Оплата с баланса OpenRouter." },
    { id: "mistral-voxtral", label: "Voxtral — напрямую через Mistral", available: Boolean(config.mistralApiKey), description: "Нужен отдельный ключ Mistral. Запрашиваются таймкоды и разделение по говорящим." },
  ];
}
