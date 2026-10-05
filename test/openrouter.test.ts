import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { config } from "../src/config.ts";
import { transcribeWithOpenRouter, openrouterSegments } from "../src/transcribe-openrouter.ts";
import { transcriptionProvider } from "../src/transcribe.ts";
import { prepareSourceAudio, splitAudio } from "../src/audio.ts";

test("OpenRouter timestamps stay absolute, absent speakers are not invented, speaker zero is retained", () => {
  assert.deepEqual(openrouterSegments([
    { offset: 0, response: { text: "a", segments: [{ start: 1, end: 2, text: "a" }] } },
    { offset: 120, response: { text: "b", segments: [{ start: 1, end: 2, text: "b", speaker: 0 }] } },
    { offset: 240, response: { text: "c", segments: [{ start: 1, end: 2, text: "c", speaker: 0 }] } },
  ]), [
    { start: 1, end: 2, text: "a", speaker: "" },
    { start: 121, end: 122, text: "b", speaker: "S1" },
    { start: 241, end: 242, text: "c", speaker: "S2" },
  ]);
  assert.equal(transcriptionProvider("openrouter-voxtral").name, "openrouter");
  assert.equal(transcriptionProvider("gpt-transcribe").model, "gpt-transcribe");
});

test("OpenRouter adapter sends source format, normalizes timed responses and never retries quota failures", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voicenotes-or-test-"));
  const file = path.join(dir, "source.flac");
  await fs.writeFile(file, "test audio fixture");
  const requests: Record<string, any>[] = [];
  let code = 200;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/audio/transcriptions");
    assert.equal(req.headers.authorization, "Bearer test-only");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(code === 200 ? { text: "Привет", segments: [{ start: 1, end: 2, text: "Привет" }], usage: { seconds: 120 } } : { error: "quota" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const old = { key: config.openrouterApiKey, base: config.openrouterBaseUrl };
  const address = server.address() as { port: number };
  config.openrouterApiKey = "test-only";
  config.openrouterBaseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { config.openrouterApiKey = old.key; config.openrouterBaseUrl = old.base; server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(dir, { recursive: true, force: true }); });
  const result = await transcribeWithOpenRouter([{ file, offset: 0 }, { file, offset: 120 }], { language: "ru", glossary: ["VoiceNotes"] });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].model, "mistralai/voxtral-mini-transcribe");
  assert.equal(requests[0].input_audio.format, "flac");
  assert.equal(requests[0].language, undefined);
  assert.equal(requests[0].provider.options.mistral.diarize, true);
  assert.deepEqual(requests[0].provider.options.mistral.context_bias, ["VoiceNotes"]);
  assert.equal(result.audioSeconds, 240);
  assert.equal(result.segments[1].start, 121);
  assert.equal(result.speakerDiarization, false);
  code = 402;
  await assert.rejects(transcribeWithOpenRouter([{ file, offset: 0 }], { language: "", glossary: [] }), /недостаточно кредитов/);
  assert.equal(requests.length, 3);
});

test("lossless source conversion mixes both tracks and splitAudio produces decodable FLAC parts", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voicenotes-flac-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "in.mka"); const source = path.join(dir, "source.flac");
  const generated = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=400:duration=5", "-f", "lavfi", "-i", "sine=frequency=800:duration=5", "-map", "0:a", "-map", "1:a", input]);
  assert.equal(generated.status, 0);
  await prepareSourceAudio(input, source);
  const parts = await splitAudio(source, 2);
  assert.equal(parts.length, 3);
  for (const part of parts) assert.equal(spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", part, "-f", "null", "-"]).status, 0);
});
