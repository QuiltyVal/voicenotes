import path from "node:path";

try {
  process.loadEnvFile();
} catch {
  // .env is optional; variables may come from the real environment.
}

function env(name: string, fallback = ""): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export type NotesLanguage = "ru" | "de" | "en" | "auto";

function notesLanguage(value: string): NotesLanguage {
  return ["ru", "de", "en", "auto"].includes(value) ? (value as NotesLanguage) : "ru";
}

function effort(value: string): "low" | "medium" | "high" {
  return value === "low" || value === "high" ? value : "medium";
}

export type TranscriptionProvider = "mistral" | "openai";

/** Explicit TRANSCRIPTION_PROVIDER wins; otherwise whichever key is set (Mistral first: EU processing). */
function transcriptionProvider(): TranscriptionProvider | null {
  const explicit = env("TRANSCRIPTION_PROVIDER").toLowerCase();
  if (explicit === "mistral" || explicit === "openai") return explicit;
  if (env("MISTRAL_API_KEY")) return "mistral";
  if (env("OPENAI_API_KEY")) return "openai";
  return null;
}

export const config = {
  port: Number(env("PORT", "3000")),
  host: env("HOST", "127.0.0.1"),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  appPassword: env("APP_PASSWORD"),
  transcriptionProvider: transcriptionProvider(),
  mistralApiKey: env("MISTRAL_API_KEY"),
  // Optional override of the Mistral API address (proxies, local tests).
  mistralBaseUrl: env("MISTRAL_BASE_URL"),
  voxtralModel: env("VOXTRAL_MODEL", "voxtral-mini-2602"),
  // The OpenAI SDK also reads OPENAI_BASE_URL (e.g. https://eu.api.openai.com/v1 for EU projects).
  openaiApiKey: env("OPENAI_API_KEY"),
  openaiTranscribeModel: env("OPENAI_TRANSCRIBE_MODEL", "gpt-4o-transcribe-diarize"),
  anthropicConfigured: Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN")),
  notesLanguage: notesLanguage(env("NOTES_LANGUAGE", "ru")),
  claudeEffort: effort(env("CLAUDE_EFFORT", "medium")),
  ffmpegPath: env("FFMPEG_PATH"),
};
