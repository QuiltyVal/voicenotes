import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config, type NotesLanguage } from "./config.ts";
import type { Notes } from "./structure.ts";

export type MeetingStatus = "uploaded" | "transcribing" | "structuring" | "done" | "error";

export interface Meeting {
  id: string;
  title: string;
  createdAt: string;
  status: MeetingStatus;
  error?: string;
  /** Stage to resume from when retrying after an error. */
  failedStage?: "transcribing" | "structuring";
  originalFile: string;
  durationSec?: number;
  /** Optional description of what the meeting is about, given by the user. */
  context: string;
  /** Names, product terms and jargon that help both transcription and notes. */
  glossary: string[];
  /** Spoken language hint for transcription ("" = auto-detect). */
  language: string;
  notesLanguage: NotesLanguage;
  detectedLanguage?: string;
  /** Speaker label (S1, S2, ...) -> display name. */
  speakers: Record<string, string>;
  usage?: {
    transcriptionModel?: string;
    transcriptionSeconds?: number;
    claudeModel?: string;
    claudeInputTokens?: number;
    claudeOutputTokens?: number;
  };
}

export interface Segment {
  speaker: string;
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  language: string | null;
  segments: Segment[];
}

const ID_RE = /^[a-z0-9-]+$/;

export function isValidId(id: string): boolean {
  return ID_RE.test(id);
}

export function meetingDir(id: string): string {
  if (!isValidId(id)) throw new Error(`Invalid meeting id: ${id}`);
  return path.join(config.dataDir, "meetings", id);
}

export function meetingPath(id: string, file: string): string {
  return path.join(meetingDir(id), file);
}

export function newMeetingId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  // Write to a temp file first so a crash never leaves half-written JSON behind.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

export async function createMeetingDir(id: string): Promise<void> {
  await fs.mkdir(meetingDir(id), { recursive: true });
}

export function getMeeting(id: string): Promise<Meeting | null> {
  return readJson<Meeting>(meetingPath(id, "meeting.json"));
}

export function saveMeeting(meeting: Meeting): Promise<void> {
  return writeJson(meetingPath(meeting.id, "meeting.json"), meeting);
}

export async function updateMeeting(id: string, patch: Partial<Meeting>): Promise<Meeting> {
  const meeting = await getMeeting(id);
  if (!meeting) throw new Error(`Meeting not found: ${id}`);
  const updated = { ...meeting, ...patch };
  await saveMeeting(updated);
  return updated;
}

export function getTranscript(id: string): Promise<Transcript | null> {
  return readJson<Transcript>(meetingPath(id, "transcript.json"));
}

export function saveTranscript(id: string, transcript: Transcript): Promise<void> {
  return writeJson(meetingPath(id, "transcript.json"), transcript);
}

export function getNotes(id: string): Promise<Notes | null> {
  return readJson<Notes>(meetingPath(id, "notes.json"));
}

export function saveNotes(id: string, notes: Notes): Promise<void> {
  return writeJson(meetingPath(id, "notes.json"), notes);
}

export async function listMeetings(): Promise<Meeting[]> {
  const root = path.join(config.dataDir, "meetings");
  let ids: string[];
  try {
    ids = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const meetings = await Promise.all(ids.filter(isValidId).map((id) => getMeeting(id)));
  return meetings
    .filter((m): m is Meeting => m !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function deleteMeeting(id: string): Promise<void> {
  await fs.rm(meetingDir(id), { recursive: true, force: true });
}
