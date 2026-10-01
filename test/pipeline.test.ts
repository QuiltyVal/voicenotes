import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { TranscriptionResponse } from "@mistralai/mistralai/models/components";
import { normalizeAudio, parseFfmpegDuration } from "../src/audio.ts";
import { NotesSchema, formatTimestamp, formatTranscript, mergeTurns } from "../src/structure.ts";
import { toSegments } from "../src/transcribe.ts";

function response(segments: { text: string; start: number; end: number; speakerId: string | null }[]): TranscriptionResponse {
  return {
    model: "voxtral",
    text: segments.map((s) => s.text).join(" "),
    language: "ru",
    usage: {},
    segments: segments.map((s) => ({ type: "transcription_segment" as const, ...s })),
  };
}

test("toSegments labels speakers in order of first appearance", () => {
  const segments = toSegments([
    {
      part: 0,
      offset: 0,
      response: response([
        { text: " Привет ", start: 0, end: 1.5, speakerId: "speaker_7" },
        { text: "Здравствуйте", start: 1.5, end: 3, speakerId: "speaker_2" },
        { text: "   ", start: 3, end: 4, speakerId: "speaker_2" },
        { text: "Начнём", start: 4, end: 5, speakerId: "speaker_7" },
      ]),
    },
  ]);
  assert.deepEqual(
    segments.map((s) => [s.speaker, s.text]),
    [
      ["S1", "Привет"],
      ["S2", "Здравствуйте"],
      ["S1", "Начнём"],
    ],
  );
});

test("toSegments offsets later parts and keeps their speakers separate", () => {
  const segments = toSegments([
    { part: 0, offset: 0, response: response([{ text: "a", start: 1, end: 2, speakerId: "speaker_0" }]) },
    { part: 1, offset: 600, response: response([{ text: "b", start: 1, end: 2, speakerId: "speaker_0" }]) },
  ]);
  assert.deepEqual(
    segments.map((s) => [s.speaker, s.start]),
    [
      ["S1", 1],
      ["S2", 601],
    ],
  );
});

test("toSegments falls back to plain text when there are no segments", () => {
  const segments = toSegments([
    { part: 0, offset: 0, response: { model: "v", text: "Только текст", language: null, usage: {} } },
  ]);
  assert.deepEqual(segments, [{ speaker: "S1", start: 0, end: 0, text: "Только текст" }]);
});

test("mergeTurns joins consecutive segments of one speaker", () => {
  const turns = mergeTurns([
    { speaker: "S1", start: 0, end: 5, text: "Один." },
    { speaker: "S1", start: 5, end: 9, text: "Два." },
    { speaker: "S2", start: 9, end: 12, text: "Три." },
    { speaker: "S2", start: 12, end: 200, text: "Долго." },
  ]);
  assert.deepEqual(
    turns.map((t) => [t.speaker, t.text]),
    [
      ["S1", "Один. Два."],
      ["S2", "Три."],
      ["S2", "Долго."],
    ],
  );
});

test("formatTranscript adds timestamps and known names", () => {
  const text = formatTranscript(
    [
      { speaker: "S1", start: 3725, end: 3730, text: "Привет" },
      { speaker: "S2", start: 3731, end: 3733, text: "Hallo" },
    ],
    { S1: "Анна", S2: " " },
  );
  assert.equal(text, "[01:02:05] S1 (Анна): Привет\n[01:02:11] S2: Hallo");
  assert.equal(formatTimestamp(59.9), "00:00:59");
});

test("parseFfmpegDuration reads the last progress mark", () => {
  const stderr = "size=1kB time=00:00:01.00 bitrate\nsize=9kB time=01:02:03.50 bitrate=32k";
  assert.equal(parseFfmpegDuration(stderr), 3723.5);
  assert.equal(parseFfmpegDuration("no progress"), undefined);
});

test("notes schema converts to a structured-output format", () => {
  const format = betaZodOutputFormat(NotesSchema);
  assert.equal(format.type, "json_schema");
  const schema = format.schema as { properties: Record<string, unknown> };
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "action_items",
    "decisions",
    "open_questions",
    "participants",
    "summary",
    "title",
    "topics",
  ]);
});

test("normalizeAudio converts to mono mp3 and reports duration", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voicenotes-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "in.wav");
  const gen = spawnSync("ffmpeg", ["-hide_banner", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-ac", "2", input]);
  if (gen.status !== 0) {
    t.skip("system ffmpeg not available to generate a test file");
    return;
  }
  const duration = await normalizeAudio(input, path.join(dir, "out.mp3"));
  assert.ok(duration && Math.abs(duration - 3) < 0.2, `duration ${duration}`);
  const stat = await fs.stat(path.join(dir, "out.mp3"));
  assert.ok(stat.size > 1000);
});
