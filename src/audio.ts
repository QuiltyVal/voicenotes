import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
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
  const stderr = await runFfmpeg([
    "-i", input,
    ...mix,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "libmp3lame",
    "-b:a", "32k",
    output,
  ]);
  return parseFfmpegDuration(stderr);
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
  await runFfmpeg([
    "-i", input,
    "-f", "segment",
    "-segment_time", String(partSeconds),
    "-c", "copy",
    path.join(dir, "part-%03d.mp3"),
  ]);
  const files = (await fs.readdir(dir)).filter((f) => /^part-\d{3}\.mp3$/.test(f)).sort();
  return files.map((f) => path.join(dir, f));
}
