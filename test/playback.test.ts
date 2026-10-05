import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";

test("playback replaces the early audio element when conversion finishes, but keeps it across polls", async () => {
  const source = await fs.readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("const audioCache ="), source.indexOf("function seek("));
  const audioFor = runInNewContext(code + "\naudioFor", { h: (_tag: string, attrs: object) => ({ ...attrs }) });
  const original = audioFor({ id: "test" });
  assert.equal(original.src, "/api/meetings/test/audio?v=original");
  assert.equal(audioFor({ id: "test" }), original);
  const ready = audioFor({ id: "test", durationSec: 2261.19 });
  assert.notEqual(ready, original);
  assert.equal(ready.src, "/api/meetings/test/audio?v=mp3");
  assert.equal(audioFor({ id: "test", durationSec: 2261.19 }), ready);
});

test("conversion publishes a complete MP3 atomically and preserves it if a later conversion fails", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "voicenotes-playback-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "in.wav");
  const output = path.join(dir, "audio.mp3");
  assert.equal(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", input]).status, 0);
  const binary = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();
  const wrapper = path.join(dir, "ffmpeg");
  await fs.writeFile(wrapper, `#!/bin/sh\nexec '${binary.replaceAll("'", "'\\''")}' -re "$@"\n`, { mode: 0o700 });
  const module = fileURLToPath(new URL("../src/audio.ts", import.meta.url));
  const script = `import {normalizeAudio} from ${JSON.stringify(module)}; await normalizeAudio(process.argv[1], process.argv[2]);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, input, output], { env: { ...process.env, FFMPEG_PATH: wrapper }, stdio: "ignore" });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const finished = once(child, "exit");
  let sawPending = false;
  for (let i = 0; i < 100; i++) {
    const files = await fs.readdir(dir);
    if (files.some(f => f.endsWith(".pending.mp3"))) {
      sawPending = true;
      await assert.rejects(fs.stat(output), { code: "ENOENT" });
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(sawPending, true);
  assert.equal((await finished)[0], 0);
  const before = await fs.readFile(output);
  assert.equal(spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"]).status, 0);
  const failed = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, path.join(dir, "missing.wav"), output], { env: { ...process.env, FFMPEG_PATH: wrapper }, stdio: "ignore" });
  assert.notEqual(failed.status, 0);
  assert.deepEqual(await fs.readFile(output), before);
  assert.equal((await fs.readdir(dir)).filter(f => f.endsWith(".pending.mp3")).length, 0);
});
