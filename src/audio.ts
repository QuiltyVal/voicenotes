import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.ts";

let ffmpegBinary: Promise<string> | undefined;

function resolveFfmpeg(): Promise<string> {
  ffmpegBinary ??= (async () => {
    if (config.ffmpegPath) return config.ffmpegPath;
    try {
      // Optional dependency; the specifier is a variable so a missing package isn't a type error.
      const pkg = "ffmpeg-static";
      const mod = (await import(pkg)) as { default?: string | null };
      if (mod.default) {
        await fs.access(mod.default);
        return mod.default;
      }
    } catch {
      // Fall back to ffmpeg from PATH.
    }
    return "ffmpeg";
  })();
  return ffmpegBinary;
}

function runFfmpeg(args: string[], { allowFailure = false } = {}): Promise<string> {
  return resolveFfmpeg().then(
    (bin) =>
      new Promise((resolve, reject) => {
        const proc = spawn(bin, ["-hide_banner", "-nostdin", "-y", ...args]);
        let stderr = "";
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
          // ffmpeg prints a progress line per second; keep only the tail.
          if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
        });
        proc.on("error", (err) =>
          reject(new Error(`Не удалось запустить ffmpeg (${bin}): ${err.message}`)),
        );
        proc.on("close", (code) => {
          if (code === 0 || allowFailure) resolve(stderr);
          else reject(new Error(`ffmpeg завершился с кодом ${code}: ${stderr.slice(-800)}`));
        });
      }),
  );
}

export function countAudioStreams(ffmpegInfo: string): number {
  return (ffmpegInfo.match(/^\s*Stream #0:\d+.*: Audio:/gm) ?? []).length;
}

/** Parses the last "time=HH:MM:SS.ss" progress mark that ffmpeg prints. */
export function parseFfmpegDuration(stderr: string): number | undefined {
  const matches = [...stderr.matchAll(/time=(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/g)];
  const last = matches.at(-1);
  if (!last) return undefined;
  return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
}

/**
 * Converts any input (browser webm/mp4, phone m4a, Zoom mp4, ...) to a small mono mp3.
 * The result is what gets transcribed and what the UI plays back (Safari can't play webm).
 */
export async function normalizeAudio(input: string, output: string): Promise<number | undefined> {
  // ffmpeg without an output just describes the file (and exits non-zero).
  const info = await runFfmpeg(["-i", input], { allowFailure: true });
  const audioStreams = countAudioStreams(info);
  // Several audio tracks (e.g. call audio + microphone from the Mac app) are mixed into one.
  const mix =
    audioStreams > 1
      ? ["-filter_complex", `${Array.from({ length: audioStreams }, (_, i) => `[0:a:${i}]`).join("")}amix=inputs=${audioStreams}:duration=longest:normalize=0[a]`, "-map", "[a]"]
      : [];
  // Never expose a growing MP3 to the player: its initial size and duration would be cached.
  const pending = `${output}.${randomUUID()}.pending.mp3`;
  try {
    const stderr = await runFfmpeg([
      "-i", input,
      ...mix,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "libmp3lame",
      "-b:a", "32k",
      pending,
    ]);
    await fs.rename(pending, output);
    return parseFfmpegDuration(stderr);
  } finally {
    await fs.rm(pending, { force: true });
  }
}

/** Peak and mean loudness (dBFS) of every audio track, to tell silence from unrecognised speech. */
export async function trackLoudness(input: string): Promise<{ max: number; mean: number }[]> {
  const count = Math.max(1, countAudioStreams(await runFfmpeg(["-i", input], { allowFailure: true })));
  const result = [];
  for (let i = 0; i < count; i++) {
    const out = await runFfmpeg(["-i", input, "-map", `0:a:${i}`, "-af", "volumedetect", "-f", "null", "-"], { allowFailure: true });
    const max = Number(out.match(/max_volume: (-?[\d.]+|-inf) dB/)?.[1] ?? -Infinity);
    const mean = Number(out.match(/mean_volume: (-?[\d.]+|-inf) dB/)?.[1] ?? -Infinity);
    result.push({ max: Number.isFinite(max) ? max : -100, mean: Number.isFinite(mean) ? mean : -100 });
  }
  return result;
}

/** Cuts a short mono 16 kHz WAV clip (used as a voice sample for speaker matching). */
export async function extractClip(input: string, start: number, duration: number, output: string): Promise<void> {
  await runFfmpeg([
    "-ss", start.toFixed(2),
    "-t", duration.toFixed(2),
    "-i", input,
    "-ac", "1",
    "-ar", "16000",
    output,
  ]);
}

/** Splits audio into parts no longer than `partSeconds`. Returns the part paths in order. */
export async function splitAudio(input: string, partSeconds: number): Promise<string[]> {
  const dir = path.dirname(input);
  const ext = path.extname(input).slice(1);
  await runFfmpeg([
    "-i", input,
    "-f", "segment",
    "-segment_time", String(partSeconds),
    "-c", "copy",
    path.join(dir, `part-%03d.${ext}`),
  ]);
  const files = (await fs.readdir(dir)).filter((f) => /^part-\d{3}\.[a-z0-9]+$/.test(f) && f.endsWith(`.${ext}`)).sort();
  return files.map((f) => path.join(dir, f));
}

/** Lossless mono audio for transcription, mixed from the original recording. */
export async function prepareSourceAudio(input: string, output: string): Promise<void> {
  const streams = countAudioStreams(await runFfmpeg(["-i", input], { allowFailure: true }));
  const mix = streams > 1 ? ["-filter_complex", `${Array.from({ length: streams }, (_, i) => `[0:a:${i}]`).join("")}amix=inputs=${streams}:duration=longest:normalize=0[a]`, "-map", "[a]"] : [];
  await runFfmpeg(["-i", input, ...mix, "-vn", "-ac", "1", "-ar", "48000", "-c:a", "flac", output]);
}
