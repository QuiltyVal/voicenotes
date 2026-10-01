// MCP server, so Claude (claude.ai / desktop, on the user's subscription) can read meetings
// and write notes back. Connector URL: https://<host>/mcp/<token>, token from settings.
import crypto from "node:crypto";
import express, { type Router } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getSettings } from "./settings.ts";
import { NotesSchema, formatTimestamp, formatTranscript, mergeTurns, type Notes } from "./structure.ts";
import {
  getMeeting,
  getNotes,
  getTranscript,
  isValidId,
  listMeetings,
  saveNotes,
  updateMeeting,
  type Meeting,
} from "./storage.ts";

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

function meetingLine(m: Meeting): string {
  const minutes = m.durationSec ? `, ${Math.max(1, Math.round(m.durationSec / 60))} min` : "";
  return `- ${m.id} | ${m.createdAt.slice(0, 16).replace("T", " ")} UTC${minutes} | ${m.title || "(untitled)"} | status: ${m.status}`;
}

export function notesToMarkdown(notes: Notes, speakers: Record<string, string>): string {
  const who = (label: string) => (/^S\d+$/.test(label) ? speakers[label]?.trim() || label : label);
  const lines = [`## ${notes.title}`, "", notes.summary, ""];
  if (notes.decisions.length) lines.push("### Decisions", ...notes.decisions.map((d) => `- ${d}`), "");
  if (notes.action_items.length) {
    lines.push("### Action items");
    for (const t of notes.action_items) {
      lines.push(`- ${t.task}${t.owner ? ` — ${who(t.owner)}` : ""}${t.due ? ` (due: ${t.due})` : ""}`);
    }
    lines.push("");
  }
  for (const topic of notes.topics) lines.push(`### [${topic.start}] ${topic.title}`, ...topic.points.map((p) => `- ${p}`), "");
  if (notes.open_questions.length) lines.push("### Open questions", ...notes.open_questions.map((q) => `- ${q}`));
  return lines.join("\n");
}

async function requireMeeting(id: string): Promise<Meeting> {
  const meeting = isValidId(id) ? await getMeeting(id) : null;
  if (!meeting) throw new Error(`Meeting not found: ${id}. Use list_meetings to get valid ids.`);
  return meeting;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "voicenotes", version: "0.1.0" });

  server.registerTool(
    "list_meetings",
    {
      title: "List meetings",
      description:
        "Lists recorded meetings, newest first: id, date, duration, title, processing status. " +
        "Optionally filter by a word in the title.",
      inputSchema: {
        query: z.string().optional().describe("Only meetings whose title contains this text"),
        limit: z.number().int().min(1).max(200).optional().describe("Default 30"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      let meetings = await listMeetings();
      if (query) meetings = meetings.filter((m) => m.title.toLowerCase().includes(query.toLowerCase()));
      const shown = meetings.slice(0, limit ?? 30);
      return text(shown.length ? shown.map(meetingLine).join("\n") : "No meetings found.");
    },
  );

  server.registerTool(
    "get_meeting",
    {
      title: "Get meeting transcript",
      description:
        "Returns a meeting's details, its full transcript ([hh:mm:ss] speaker: text, speakers labelled S1, S2… " +
        "with names where known) and existing notes if any. The transcript comes from speech recognition, " +
        "so expect some misheard words and occasionally mixed-up speakers.",
      inputSchema: { meeting_id: z.string().describe("Id from list_meetings") },
      annotations: { readOnlyHint: true },
    },
    async ({ meeting_id }) => {
      const meeting = await requireMeeting(meeting_id);
      const [transcript, notes] = await Promise.all([getTranscript(meeting.id), getNotes(meeting.id)]);
      const parts = [meetingLine(meeting)];
      if (meeting.context) parts.push(`User's description: ${meeting.context}`);
      if (meeting.glossary.length) parts.push(`Glossary: ${meeting.glossary.join(", ")}`);
      parts.push("", transcript ? `<transcript>\n${formatTranscript(transcript.segments, meeting.speakers)}\n</transcript>` : "No transcript yet.");
      if (notes) parts.push("", "<existing_notes>", notesToMarkdown(notes, meeting.speakers), "</existing_notes>");
      return text(parts.join("\n"));
    },
  );

  server.registerTool(
    "search_meetings",
    {
      title: "Search meeting transcripts",
      description:
        "Full-text search across all transcripts (case-insensitive). Returns matching lines with meeting id and " +
        "timestamp — use it to answer questions spanning several meetings, then get_meeting for context.",
      inputSchema: { query: z.string().min(2).describe("Word or phrase to find") },
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      const needle = query.toLowerCase();
      const hits: string[] = [];
      for (const meeting of await listMeetings()) {
        const transcript = await getTranscript(meeting.id);
        if (!transcript) continue;
        for (const turn of mergeTurns(transcript.segments)) {
          if (!turn.text.toLowerCase().includes(needle)) continue;
          const who = meeting.speakers[turn.speaker]?.trim() || turn.speaker;
          hits.push(`${meeting.id} "${meeting.title}" [${formatTimestamp(turn.start)}] ${who}: ${turn.text}`);
          if (hits.length >= 40) break;
        }
        if (hits.length >= 40) break;
      }
      return text(hits.length ? hits.join("\n") : `Nothing found for "${query}".`);
    },
  );

  server.registerTool(
    "save_notes",
    {
      title: "Save meeting notes",
      description:
        "Saves structured notes for a meeting so they appear in the Voicenotes app (replaces existing notes). " +
        "Read the transcript with get_meeting first. Write in the language the user wants (Russian unless told " +
        "otherwise); be faithful to the transcript and leave unknown fields as empty strings or empty lists.",
      inputSchema: { meeting_id: z.string(), ...NotesSchema.shape },
    },
    async ({ meeting_id, ...notes }) => {
      const meeting = await requireMeeting(meeting_id);
      await saveNotes(meeting.id, notes);
      const speakers = { ...meeting.speakers };
      for (const p of notes.participants) {
        if (p.name.trim() && /^S\d+$/.test(p.speaker) && !speakers[p.speaker]?.trim()) speakers[p.speaker] = p.name.trim();
      }
      await updateMeeting(meeting.id, {
        title: meeting.title.trim() || notes.title,
        speakers,
        ...(meeting.status === "error" ? {} : { status: "done" as const }),
      });
      return text(`Notes saved for "${meeting.title || notes.title}".`);
    },
  );

  return server;
}

function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Mounted before the password check: the token in the URL is the credential. */
export function mcpRouter(): Router {
  const router = express.Router();
  router.use(express.json({ limit: "5mb" }));

  router.all("/:token", async (req, res) => {
    const { mcpToken } = await getSettings();
    if (!sameSecret(String(req.params.token), mcpToken)) {
      res.status(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").end();
      return;
    }
    // Stateless: a fresh server per request, nothing to clean up between calls.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  return router;
}
