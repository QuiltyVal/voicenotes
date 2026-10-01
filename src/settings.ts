import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.ts";

/** Settings changed from the UI; stored in DATA_DIR/settings.json and override .env defaults. */
export interface Settings {
  /** Generate notes with the Claude API right after transcription. */
  autoNotes: boolean;
  claudeModel: string;
  /** Secret part of the MCP connector URL (/mcp/<token>). */
  mcpToken: string;
}

export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"];

const file = () => path.join(config.dataDir, "settings.json");
let cached: Settings | undefined;

export async function getSettings(): Promise<Settings> {
  if (cached) return cached;
  let stored: Partial<Settings> = {};
  try {
    stored = JSON.parse(await fs.readFile(file(), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  cached = {
    autoNotes: stored.autoNotes ?? true,
    claudeModel: CLAUDE_MODELS.includes(stored.claudeModel ?? "") ? stored.claudeModel! : "claude-sonnet-5-5",
    mcpToken: stored.mcpToken || crypto.randomBytes(24).toString("base64url"),
  };
  if (!stored.mcpToken) await saveSettings(cached);
  return cached;
}

export async function saveSettings(settings: Settings): Promise<void> {
  cached = settings;
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = `${file()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file());
}

export async function updateSettings(patch: { autoNotes?: unknown; claudeModel?: unknown }): Promise<Settings> {
  const current = await getSettings();
  const next = { ...current };
  if (typeof patch.autoNotes === "boolean") next.autoNotes = patch.autoNotes;
  if (typeof patch.claudeModel === "string" && CLAUDE_MODELS.includes(patch.claudeModel)) {
    next.claudeModel = patch.claudeModel;
  }
  await saveSettings(next);
  return next;
}
