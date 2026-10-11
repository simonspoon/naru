// Pure logic for the run view (naru task 1831): `GET /api/runs/{id}?tail=N`
// answers `{job, events}` where `events` is events.jsonl line by line —
// claude's stream-json stdout verbatim plus the runner's own `naru_runner`
// lines (src/core/runner.rs). The runner's views are `serde_json::Value`, not
// ts-rs types, so the shapes here are declared by hand and every read is
// defensive: a line that does not parse arrives as a bare string, and a field
// that is not the type expected is treated as absent. Everything in an entry
// is untrusted plain text — render it as text, never as HTML.
import { chatToolTarget } from "./agentChat";

/** The job fields the run view reads (`runner::Job` + `view()`'s derived keys). */
export type RunStatus = "running" | "idle" | "finished" | "failed" | "stopped";

export type RunJob = {
  job_id: string;
  session_id?: string;
  name?: string;
  model?: string;
  cwd?: string;
  status: RunStatus;
  runner_alive?: boolean;
  pending_messages?: number;
  last_result?: string | null;
  last_subtype?: string | null;
  last_is_error?: boolean | null;
};

/** `GET /api/runs/{id}?tail=N`. */
export type RunShown = { job: RunJob; events: unknown[] };

export type RunEntry =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; target: string }
  | {
      kind: "tool_result";
      toolId: string;
      text: string;
      isError: boolean;
      truncated: boolean;
    }
  | { kind: "user"; text: string }
  | {
      kind: "result";
      subtype: string;
      isError: boolean;
      costUsd: number | null;
      text: string;
    }
  | { kind: "lifecycle"; event: string; label: string }
  | { kind: "raw"; text: string };

export type RunControls = { send: boolean; interrupt: boolean; stop: boolean };

/** A tool result's text is cut here; `truncated` tells the row to say so. */
export const RUN_RESULT_MAX = 600;
const TARGET_MAX = 200;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** A tool_use input's one-line target: the field an agent would name first. */
function toolTarget(input: unknown): string {
  if (!isRecord(input)) return "";
  for (const key of [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "description",
    "query",
  ]) {
    const v = str(input[key]);
    if (v) return chatToolTarget(cut(v.split("\n")[0], TARGET_MAX));
  }
  for (const v of Object.values(input)) {
    const s = str(v);
    if (s) return cut(s.split("\n")[0], TARGET_MAX);
  }
  return "";
}

/** A tool_result's `content` is a string or a list of `{type:'text'}` blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isRecord(b) ? (str(b.text) ?? "") : ""))
      .filter((t) => t !== "")
      .join("\n");
  }
  return "";
}

function lifecycleLabel(ev: Record<string, unknown>): string {
  const event = str(ev.event) ?? "event";
  switch (event) {
    case "claude_started":
      return ev.resume === true ? "claude resumed" : "claude started";
    case "message_delivered":
      return ev.source === "resume"
        ? "continue prompt delivered"
        : "message delivered";
    case "interrupt_requested":
      return "interrupt requested";
    case "stop_requested":
      return "stop requested";
    case "idle_timeout":
      return typeof ev.secs === "number"
        ? `idle timeout (${ev.secs}s)`
        : "idle timeout";
    case "resumed":
      return "run resumed";
    case "exited":
      return `exited${str(ev.status) ? ` · ${str(ev.status)}` : ""}${
        typeof ev.exit_code === "number" ? ` (code ${ev.exit_code})` : ""
      }`;
    case "failed":
      return `failed${str(ev.error) ? ` · ${cut(str(ev.error) as string, TARGET_MAX)}` : ""}`;
    case "stopped":
      return `stopped${str(ev.by) ? ` · ${str(ev.by)}` : ""}`;
    default:
      return event.replace(/_/g, " ");
  }
}

function contentBlocks(ev: Record<string, unknown>): unknown[] {
  const message = ev.message;
  if (!isRecord(message)) return [];
  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? content : [];
}

function entriesOf(ev: unknown): RunEntry[] {
  if (typeof ev === "string")
    return ev.trim() ? [{ kind: "raw", text: cut(ev, RUN_RESULT_MAX) }] : [];
  if (!isRecord(ev)) return [];
  switch (ev.type) {
    case "naru_runner": {
      const event = str(ev.event);
      return event
        ? [{ kind: "lifecycle", event, label: lifecycleLabel(ev) }]
        : [];
    }
    case "assistant": {
      const out: RunEntry[] = [];
      for (const b of contentBlocks(ev)) {
        if (!isRecord(b)) continue;
        if (b.type === "text") {
          const text = str(b.text);
          if (text && text.trim()) out.push({ kind: "text", text });
        } else if (b.type === "tool_use") {
          out.push({
            kind: "tool",
            id: str(b.id) ?? "",
            name: str(b.name) ?? "tool",
            target: toolTarget(b.input),
          });
        }
      }
      return out;
    }
    case "user": {
      const out: RunEntry[] = [];
      for (const b of contentBlocks(ev)) {
        if (!isRecord(b)) continue;
        if (b.type === "tool_result") {
          const full = resultText(b.content);
          out.push({
            kind: "tool_result",
            toolId: str(b.tool_use_id) ?? "",
            text: cut(full, RUN_RESULT_MAX),
            isError: b.is_error === true,
            truncated: full.length > RUN_RESULT_MAX,
          });
        } else if (b.type === "text") {
          const text = str(b.text);
          if (text && text.trim()) out.push({ kind: "user", text });
        }
      }
      return out;
    }
    case "result":
      return [
        {
          kind: "result",
          subtype: str(ev.subtype) ?? "result",
          isError: ev.is_error === true,
          costUsd:
            typeof ev.total_cost_usd === "number" ? ev.total_cost_usd : null,
          text: str(ev.result) ?? "",
        },
      ];
    // system (hooks, init, titles, thinking_tokens), control_response,
    // rate_limit_event and anything unknown are protocol noise.
    default:
      return [];
  }
}

/** events.jsonl lines -> the ordered, readable entries of a run. */
export function runEntries(events: readonly unknown[]): RunEntry[] {
  return events.flatMap(entriesOf);
}

/** The run's controls: send and stop until it is over, interrupt only mid-turn. */
export function runControls(
  job: Pick<RunJob, "status"> | null | undefined,
): RunControls {
  const status = job?.status;
  const live = status === "running" || status === "idle";
  return { send: live, interrupt: status === "running", stop: live };
}

/** Splits a raw events.jsonl body into the shape the API's `events` has. */
export function parseEventLines(body: string): unknown[] {
  return body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l) as unknown;
      } catch {
        return l;
      }
    });
}
