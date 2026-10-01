import type { Segment, Transcript } from "./storage.ts";

export interface TranscribeOptions {
  language: string;
  glossary: string[];
}

export interface AudioPart {
  file: string;
  offset: number;
}

export interface TranscriptionResult extends Transcript {
  audioSeconds: number;
  model: string;
}

/** Assigns S1, S2, ... to raw speaker keys in order of first appearance. */
export class SpeakerLabels {
  private labels = new Map<string, string>();

  label(key: string): string {
    let label = this.labels.get(key);
    if (!label) {
      label = `S${this.labels.size + 1}`;
      this.labels.set(key, label);
    }
    return label;
  }
}

/** Adds a segment with absolute timestamps, skipping empty text. */
export function pushSegment(
  segments: Segment[],
  seg: { speaker: string; start: number | null | undefined; end: number | null | undefined; text: string },
  offset: number,
): void {
  const text = seg.text.trim();
  if (!text) return;
  const start = (seg.start ?? 0) + offset;
  segments.push({ speaker: seg.speaker, start, end: (seg.end ?? seg.start ?? 0) + offset, text });
}
