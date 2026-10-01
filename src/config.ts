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

export const config = {
  port: Number(env("PORT", "3000")),
  host: env("HOST", "127.0.0.1"),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  appPassword: env("APP_PASSWORD"),
  mistralApiKey: env("MISTRAL_API_KEY"),
  // Optional override of the Mistral API address (proxies, local tests).
  mistralBaseUrl: env("MISTRAL_BASE_URL"),
  anthropicConfigured: Boolean(env("ANTHROPIC_API_KEY") || env("ANTHROPIC_AUTH_TOKEN")),
  notesLanguage: notesLanguage(env("NOTES_LANGUAGE", "ru")),
  claudeModel: env("CLAUDE_MODEL", "claude-opus-5-5"),
  claudeEffort: effort(env("CLAUDE_EFFORT", "medium")),
  voxtralModel: env("VOXTRAL_MODEL", "voxtral-mini-2602"),
  ffmpegPath: env("FFMPEG_PATH"),
  // Voxtral accepts up to ~3 hours per request; longer audio is split into parts.
  maxPartSeconds: 170 * 60,
};
