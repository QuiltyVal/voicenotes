import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline as pipeStreams } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, type NotesLanguage } from "./config.ts";
import { enqueue, regenerateNotes, resumePending, retry } from "./pipeline.ts";
import { transcriptionProvider } from "./transcribe.ts";
import { mcpRouter } from "./mcp.ts";
import { transcriptionModels } from "./transcription-models.ts";
import { CLAUDE_MODELS, getSettings, updateSettings } from "./settings.ts";
import {
  createMeetingDir,
  deleteMeeting,
  getMeeting,
  getNotes,
  getTranscript,
  isValidId,
  listMeetings,
  meetingDir,
  meetingPath,
  newMeetingId,
  saveMeeting,
  updateMeeting,
  type Meeting,
} from "./storage.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");

const app = express();
app.disable("x-powered-by");

function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// MCP connector for Claude: protected by the secret token in its URL, not by the password.
app.use("/mcp", mcpRouter());

// Optional HTTP Basic auth: any username, the password must match APP_PASSWORD.
app.use((req, res, next) => {
  if (!config.appPassword) return next();
  const [scheme, encoded] = (req.headers.authorization ?? "").split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    if (sameSecret(decoded.slice(decoded.indexOf(":") + 1), config.appPassword)) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Voicenotes", charset="UTF-8"');
  res.status(401).send("Нужен пароль");
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir, { index: "index.html" }));

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac",
};

function extensionFor(contentType: string | undefined, filename: string): string {
  const mime = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (EXTENSIONS[mime]) return EXTENSIONS[mime];
  const ext = path.extname(filename).slice(1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : "bin";
}

function queryString(value: unknown, maxLength = 2000): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function parseGlossary(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
  return [...new Set(raw.split(/[\n,;]/).map((t) => t.trim()).filter(Boolean))].slice(0, 100);
}

function parseNotesLanguage(value: unknown): NotesLanguage {
  return value === "ru" || value === "de" || value === "en" || value === "auto" ? value : config.notesLanguage;
}

function parseLanguage(value: unknown): string {
  return typeof value === "string" && /^[a-z]{2}$/.test(value) ? value : "";
}

async function loadMeeting(req: Request, res: Response): Promise<Meeting | null> {
  const id = String(req.params.id);
  const meeting = isValidId(id) ? await getMeeting(id) : null;
  if (!meeting) res.status(404).json({ error: "Встреча не найдена" });
  return meeting;
}

function transcriptionConfigured(choice?: string): boolean {
  return transcriptionModels().some((m) => m.id === choice && m.available);
}

app.get("/api/status", async (_req, res) => {
  const settings = await getSettings();
  const provider = transcriptionProvider(settings.transcriptionChoice);
  res.json({
    // Clients check this: the Mac app sends call audio and microphone as two tracks.
    multitrack: true,
    transcriptionConfigured: transcriptionConfigured(settings.transcriptionChoice),
    transcriptionChoice: settings.transcriptionChoice,
    transcriptionModels: transcriptionModels(),
    transcriptionModel: provider ? `${provider.name}/${provider.model}` : null,
    anthropicConfigured: config.anthropicConfigured,
    notesLanguage: config.notesLanguage,
    autoNotes: settings.autoNotes,
    claudeModel: settings.claudeModel,
    claudeModels: CLAUDE_MODELS,
    mcpPath: `/mcp/${settings.mcpToken}`,
  });
});

app.put("/api/settings", async (req, res) => {
  try {
    const settings = await updateSettings((req.body ?? {}) as Record<string, unknown>);
    const provider = transcriptionProvider(settings.transcriptionChoice);
    res.json({ autoNotes: settings.autoNotes, claudeModel: settings.claudeModel, transcriptionChoice: settings.transcriptionChoice, transcriptionModel: `${provider.name}/${provider.model}`, transcriptionConfigured: transcriptionConfigured(settings.transcriptionChoice) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get("/api/meetings", async (_req, res) => {
  res.json(await listMeetings());
});

// Upload: the request body is the raw audio file, metadata comes in the query string.
app.post("/api/meetings", async (req, res) => {
  const id = newMeetingId();
  const filename = queryString(req.query.filename, 200);
  const originalFile = `original.${extensionFor(req.headers["content-type"], filename)}`;
  await createMeetingDir(id);
  try {
    await pipeStreams(req, fs.createWriteStream(meetingPath(id, originalFile)));
    if (fs.statSync(meetingPath(id, originalFile)).size === 0) throw new Error("Пустой файл");
  } catch (err) {
    await deleteMeeting(id);
    res.status(400).json({ error: `Не удалось сохранить запись: ${(err as Error).message}` });
    return;
  }

  const recordedAt = new Date(queryString(req.query.recordedAt, 40));
  const meeting: Meeting = {
    id,
    title: queryString(req.query.title, 200).trim(),
    createdAt: (Number.isNaN(recordedAt.getTime()) ? new Date() : recordedAt).toISOString(),
    status: "uploaded",
    originalFile,
    transcriptionChoice: (await getSettings()).transcriptionChoice,
    context: queryString(req.query.context).trim(),
    glossary: parseGlossary(req.query.glossary),
    language: parseLanguage(req.query.language),
    notesLanguage: parseNotesLanguage(req.query.notesLanguage),
    speakers: {},
  };
  await saveMeeting(meeting);
  enqueue(id);
  res.status(201).json(meeting);
});

app.get("/api/meetings/:id", async (req, res) => {
  const meeting = await loadMeeting(req, res);
  if (!meeting) return;
  const [transcript, notes] = await Promise.all([getTranscript(meeting.id), getNotes(meeting.id)]);
  res.json({ meeting, transcript, notes });
});

app.patch("/api/meetings/:id", async (req, res) => {
  const meeting = await loadMeeting(req, res);
  if (!meeting) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<Meeting> = {};
  if (typeof body.title === "string") patch.title = body.title.slice(0, 200).trim();
  if (typeof body.context === "string") patch.context = body.context.slice(0, 2000).trim();
  if (typeof body.userNotes === "string") patch.userNotes = body.userNotes.slice(0, 50_000);
  if (body.glossary !== undefined) patch.glossary = parseGlossary(body.glossary);
  if (body.notesLanguage !== undefined) patch.notesLanguage = parseNotesLanguage(body.notesLanguage);
  if (body.speakers && typeof body.speakers === "object") {
    patch.speakers = Object.fromEntries(
      Object.entries(body.speakers as Record<string, unknown>)
        .filter(([label, name]) => /^S\d+$/.test(label) && typeof name === "string")
        .map(([label, name]) => [label, (name as string).slice(0, 100).trim()]),
    );
  }
  res.json(await updateMeeting(meeting.id, patch));
});

app.post("/api/meetings/:id/retry", async (req, res) => {
  const meeting = await loadMeeting(req, res);
  if (!meeting) return;
  if (meeting.status !== "error") {
    res.status(409).json({ error: "Встреча не в состоянии ошибки" });
    return;
  }
  res.json(await retry(meeting.id));
});

app.post("/api/meetings/:id/regenerate", async (req, res) => {
  const meeting = await loadMeeting(req, res);
  if (!meeting) return;
  if (!(await getTranscript(meeting.id))) {
    res.status(409).json({ error: "Ещё нет расшифровки" });
    return;
  }
  if (meeting.status === "transcribing" || meeting.status === "structuring" || meeting.status === "uploaded") {
    res.status(409).json({ error: "Встреча ещё обрабатывается" });
    return;
  }
  res.json(await regenerateNotes(meeting.id));
});

app.delete("/api/meetings/:id", async (req, res) => {
  const meeting = await loadMeeting(req, res);
  if (!meeting) return;
  await deleteMeeting(meeting.id);
  res.status(204).end();
});

app.get("/api/meetings/:id/audio", async (req, res) => {
  const meeting = await loadMeeting(req, res);
  if (!meeting) return;
  const file = fs.existsSync(meetingPath(meeting.id, "audio.mp3")) ? "audio.mp3" : meeting.originalFile;
  // Relative to the meeting folder, so a dot-directory in DATA_DIR can't trip the dotfile check.
  res.sendFile(file, { root: meetingDir(meeting.id) }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: err instanceof Error ? err.message : "Ошибка сервера" });
});

fs.mkdirSync(path.join(config.dataDir, "meetings"), { recursive: true });

app.listen(config.port, config.host, async () => {
  console.log(`Voicenotes: http://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}`);
  console.log(`Данные: ${config.dataDir}`);
  const settings = await getSettings();
  const provider = transcriptionProvider(settings.transcriptionChoice);
  if (transcriptionConfigured(settings.transcriptionChoice)) console.log(`Расшифровка: ${provider!.name} (${provider!.model})`);
  else console.warn("⚠ Не задан ключ для расшифровки (OPENAI_API_KEY или MISTRAL_API_KEY) — расшифровка работать не будет.");
  if (!config.anthropicConfigured) console.warn("⚠ ANTHROPIC_API_KEY не задан — конспекты работать не будут.");
  if (!config.appPassword && config.host !== "127.0.0.1" && config.host !== "localhost") {
    console.warn("⚠ Сервер доступен из сети без пароля. Задай APP_PASSWORD в .env.");
  }
  void resumePending();
});
