import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config, type NotesLanguage } from "./config.ts";
import { getSettings } from "./settings.ts";
import type { Meeting, Segment } from "./storage.ts";

export const NotesSchema = z.object({
  title: z.string().describe("Short descriptive meeting title, at most ~8 words"),
  summary: z
    .string()
    .describe("3-6 sentences: what the meeting was for, the main outcome, and what happens next"),
  participants: z.array(
    z.object({
      speaker: z.string().describe("Speaker label exactly as in the transcript, e.g. S1"),
      name: z
        .string()
        .describe("Real name if clearly evident from the conversation, otherwise an empty string"),
      role: z.string().describe("Role or relation to the meeting if clear, otherwise an empty string"),
    }),
  ),
  topics: z.array(
    z.object({
      title: z.string(),
      start: z.string().describe("Timestamp where the topic starts, copied from the transcript, e.g. 00:12:34"),
      points: z.array(z.string()),
    }),
  ),
  decisions: z.array(z.string()),
  action_items: z.array(
    z.object({
      task: z.string(),
      owner: z.string().describe("Responsible person (name or speaker label), or an empty string"),
      due: z.string().describe("Deadline as stated in the meeting, or an empty string"),
    }),
  ),
  open_questions: z.array(z.string()),
});

export type Notes = z.infer<typeof NotesSchema>;

const LANGUAGE_NAMES: Record<Exclude<NotesLanguage, "auto">, string> = {
  ru: "Russian",
  de: "German",
  en: "English",
};

// Models that accept the server-side refusal fallback (`fallbacks: "default"`).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

function systemPrompt(language: NotesLanguage): string {
  const languageRule =
    language === "auto"
      ? "Write all notes in the main language spoken in the meeting."
      : `Write all notes in ${LANGUAGE_NAMES[language]}, whatever language the meeting was held in.`;

  return `You turn raw meeting transcripts into clear, faithful meeting notes for someone who needs to act on them or who missed the meeting.

The transcript comes from automatic speech recognition with automatic speaker separation, so expect misheard words, odd punctuation and occasionally mixed-up speakers. Use context and the glossary (if given) to read through obvious recognition errors, but never add content the transcript doesn't support. When something is unclear, leave it out or list it under open questions instead of guessing.

How to fill the fields:
- title: what the meeting was actually about, not a generic "Meeting".
- summary: purpose, main outcome, next steps — readable on its own.
- participants: one entry per speaker label in the transcript. Fill in a name only with clear evidence (introductions, people addressing each other by name, or a name the user already attached to the label).
- topics: in chronological order, usually 2-8. Each point should carry substance — arguments, facts, numbers, dates, concerns and conclusions — rather than "they discussed X". Skip small talk.
- decisions: only what was explicitly agreed or decided.
- action_items: concrete follow-ups someone committed to or was asked to do, with owner and deadline when stated.
- open_questions: unresolved issues and things left to clarify.

If the user took their own notes during the meeting (<user_notes>), they show what mattered most to them: make sure every one of their points is covered and expanded with details from the transcript, and keep their wording where it fits. If a note contradicts the transcript, trust the transcript and mention the discrepancy under open questions.

${languageRule} Keep people's names, product names and technical terms in their original form. Prefer short, information-dense bullet points. Empty lists are fine when the meeting had none.`;
}

export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Joins consecutive segments of the same speaker into turns of at most ~90 seconds. */
export function mergeTurns(segments: Segment[], maxTurnSeconds = 90): Segment[] {
  const turns: Segment[] = [];
  for (const seg of segments) {
    const last = turns.at(-1);
    if (last && last.speaker === seg.speaker && seg.end - last.start <= maxTurnSeconds) {
      last.text = `${last.text} ${seg.text}`;
      last.end = seg.end;
    } else {
      turns.push({ ...seg });
    }
  }
  return turns;
}

export function formatTranscript(segments: Segment[], speakers: Record<string, string>): string {
  return mergeTurns(segments)
    .map((t) => {
      const name = speakers[t.speaker]?.trim();
      const who = name ? `${t.speaker} (${name})` : t.speaker;
      return `[${formatTimestamp(t.start)}] ${who}: ${t.text}`;
    })
    .join("\n");
}

function meetingInfo(meeting: Meeting): string {
  const lines = [`Recorded: ${new Date(meeting.createdAt).toISOString().slice(0, 16).replace("T", " ")} UTC`];
  if (meeting.durationSec) lines.push(`Duration: ${Math.max(1, Math.round(meeting.durationSec / 60))} min`);
  if (meeting.context.trim()) lines.push(`What the user says the meeting is about: ${meeting.context.trim()}`);
  if (meeting.glossary.length) lines.push(`Glossary (correct spellings of names and terms): ${meeting.glossary.join(", ")}`);
  return lines.join("\n");
}

let client: Anthropic | undefined;

export async function generateNotes(
  meeting: Meeting,
  segments: Segment[],
): Promise<{ notes: Notes; usage: { model: string; inputTokens: number; outputTokens: number } }> {
  client ??= new Anthropic({ maxRetries: 4 });
  const model = (await getSettings()).claudeModel;
  const useFallbacks = FALLBACK_MODELS.has(model);

  const stream = client.beta.messages.stream({
    model,
    max_tokens: 32000,
    ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    output_config: {
      ...(model.startsWith("claude-haiku") ? {} : { effort: config.claudeEffort }),
      format: betaZodOutputFormat(NotesSchema),
    },
    system: systemPrompt(meeting.notesLanguage),
    messages: [
      {
        role: "user",
        content:
          `<meeting_info>\n${meetingInfo(meeting)}\n</meeting_info>\n\n` +
          (meeting.userNotes?.trim() ? `<user_notes>\n${meeting.userNotes.trim()}\n</user_notes>\n\n` : "") +
          `<transcript>\n${formatTranscript(segments, meeting.speakers)}\n</transcript>`,
      },
    ],
  });

  let message;
  try {
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new Error("Claude: неверный или не заданный ANTHROPIC_API_KEY.");
    }
    if (err instanceof Anthropic.RateLimitError) {
      throw new Error("Claude: превышен лимит запросов, попробуй позже.");
    }
    if (err instanceof Anthropic.APIError) {
      throw new Error(`Claude API ${err.status ?? ""}: ${err.message}`);
    }
    throw err;
  }

  if (message.stop_reason === "refusal") {
    throw new Error("Claude отказался обрабатывать эту расшифровку.");
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("Конспект не поместился в лимит ответа — попробуй ещё раз.");
  }
  if (!message.parsed_output) {
    throw new Error("Claude вернул ответ не в том формате — попробуй пересобрать конспект.");
  }

  return {
    notes: message.parsed_output,
    usage: {
      model: message.model,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}
