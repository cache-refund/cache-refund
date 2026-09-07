/**
 * Streaming JSONL parser: transcript files -> TurnEvent[].
 *
 * the contract semantics (frozen, matched to the oracle):
 *   - Only usage-bearing lines (`message.usage` present) become TurnEvents.
 *   - Dedup by `message.id` GLOBALLY across all files (first occurrence wins).
 *   - c5/c1 from `usage.cache_creation.ephemeral_{5m,1h}_input_tokens`;
 *     fallback: when `cache_creation` is absent OR its 5m field is null,
 *     keep any known c1 and assign the remaining flat total to c5. Such
 *     fallback counts are marked inferred, not explicit received-TTL evidence.
 *   - read from `usage.cache_read_input_tokens`.
 *   - sessionKey = file basename + ":" + sessionId  (oracle key).
 *   - Malformed / non-JSON / usage-less lines are skipped silently.
 *   - `type:"system", subtype:"compact_boundary"` (or `isCompactSummary`) lines
 *     set a pending flag so the NEXT usage turn in that file is marked
 *     `compactBoundaryBefore`. This never changes the gap buckets.
 *
 * Streaming: files are read line-by-line via a chunked reader (no full-file
 * JSON.parse; only per-line parse), so a multi-GB corpus stays within memory.
 */

import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type { TurnEvent } from "./types.js";

/** Parse an ISO-8601 timestamp to epoch seconds; null on failure. */
export function parseTs(s: unknown): number | null {
  if (typeof s !== "string" || s.length === 0) return null;
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) return null;
  return ms / 1000;
}

/** Coerce a possibly-missing numeric field to a finite number (default 0). */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

export interface ParseOptions {
  /** Only keep turns with ts >= cutoff (epoch seconds). */
  cutoff?: number | null;
  /** Shared dedup set across a multi-file run (message.id). */
  seenIds?: Set<string>;
  /** Project label attached to every event from this file. */
  project?: string;
}

/**
 * Extract a single TurnEvent from a parsed JSON object, or null if the line is
 * not a usage-bearing turn (or is a duplicate / out of window).
 *
 * `pending.compact` carries a compact-boundary flag forward to the next turn.
 */
export function eventFromObject(
  o: unknown,
  fileBasename: string,
  opts: ParseOptions,
  pending: { compact: boolean },
): TurnEvent | null {
  if (o === null || typeof o !== "object") return null;
  const obj = o as Record<string, unknown>;

  // Compact boundary markers are their own (usage-less) lines.
  const subtype = obj["subtype"];
  if (obj["isCompactSummary"] === true || subtype === "compact_boundary") {
    pending.compact = true;
  }

  const msg = obj["message"];
  if (msg === null || typeof msg !== "object") return null;
  const message = msg as Record<string, unknown>;
  const usage = message["usage"];
  if (usage === null || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;

  // Dedup by message.id (global).
  const mid = message["id"];
  if (typeof mid === "string" && mid.length > 0 && opts.seenIds) {
    if (opts.seenIds.has(mid)) return null;
    opts.seenIds.add(mid);
  }

  const ts = parseTs(obj["timestamp"]);
  if (ts === null) return null;
  if (opts.cutoff != null && ts < opts.cutoff) return null;

  // c5/c1 extraction with flat fallback.
  const cc = u["cache_creation"];
  const cacheTtlInferred = cc === null || typeof cc !== "object" ||
    typeof (cc as Record<string, unknown>)["ephemeral_5m_input_tokens"] !== "number" ||
    typeof (cc as Record<string, unknown>)["ephemeral_1h_input_tokens"] !== "number";
  let c5: number;
  let c1: number;
  if (cc !== null && typeof cc === "object") {
    const ccObj = cc as Record<string, unknown>;
    const raw5 = ccObj["ephemeral_5m_input_tokens"];
    if (raw5 === null || raw5 === undefined) {
      // The flat field includes known 1h writes; count them only once.
      c1 = num(ccObj["ephemeral_1h_input_tokens"]);
      c5 = Math.max(0, num(u["cache_creation_input_tokens"]) - c1);
    } else {
      c5 = num(raw5);
      c1 = num(ccObj["ephemeral_1h_input_tokens"]);
    }
  } else {
    // No cache_creation object at all -> flat fallback (all to 5m).
    c5 = num(u["cache_creation_input_tokens"]);
    c1 = 0;
  }
  const read = num(u["cache_read_input_tokens"]);

  const sessionId = obj["sessionId"];
  const sessionKey = fileBasename + ":" + (sessionId === undefined ? "None" : String(sessionId));
  const model = typeof message["model"] === "string" ? (message["model"] as string) : "<unknown>";
  const isSidechain = obj["isSidechain"] === true;

  const compactBoundaryBefore = pending.compact;
  pending.compact = false;

  return {
    ts,
    model,
    sessionKey,
    isSidechain,
    c5,
    c1,
    ...(cacheTtlInferred ? { cacheTtlInferred: true } : {}),
    read,
    compactBoundaryBefore,
    project: opts.project ?? "",
  };
}

/** Parse an already-in-memory JSONL string (used by fixture tests). */
export function parseJsonlString(
  text: string,
  fileBasename: string,
  opts: ParseOptions = {},
): TurnEvent[] {
  const seen = opts.seenIds ?? new Set<string>();
  const localOpts = { ...opts, seenIds: seen };
  const pending = { compact: false };
  const out: TurnEvent[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerate malformed lines
    }
    const ev = eventFromObject(parsed, fileBasename, localOpts, pending);
    if (ev) out.push(ev);
  }
  return out;
}

/**
 * Stream one file from disk into TurnEvents, appending to `out`.
 * Never throws on read/parse errors — unreadable files are skipped.
 *
 * IMPORTANT: we split on `\n` ourselves rather than using `readline`. Node's
 * `readline` also breaks lines on U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH
 * SEPARATOR), which legitimately appear INSIDE JSON string values in real
 * transcripts (e.g. code that manipulates those characters). That would split
 * one valid JSONL record into fragments that all fail to parse, silently
 * dropping the turn — and diverging from the oracle (which splits on `\n`
 * only). Manual `\n` splitting with a cross-chunk carry buffer matches the
 * oracle byte-for-byte while staying streaming (bounded memory).
 */
export async function parseFile(
  filePath: string,
  opts: ParseOptions,
  out: TurnEvent[],
): Promise<void> {
  const fileBasename = basename(filePath);
  const pending = { compact: false };
  let stream: ReturnType<typeof createReadStream>;
  try {
    stream = createReadStream(filePath, { encoding: "utf8" });
  } catch {
    return;
  }
  // No-throw error handler: a mid-read error aborts the async iterator via the
  // try/catch below rather than crashing the process.
  stream.on("error", () => {
    /* swallowed; iteration ends and we keep whatever parsed so far */
  });

  const emit = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return; // tolerate malformed lines
    }
    const ev = eventFromObject(parsed, fileBasename, opts, pending);
    if (ev) out.push(ev);
  };

  let carry = "";
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const text = carry + chunk;
      let start = 0;
      let nl = text.indexOf("\n", start);
      while (nl !== -1) {
        emit(text.slice(start, nl));
        start = nl + 1;
        nl = text.indexOf("\n", start);
      }
      carry = text.slice(start);
    }
  } catch {
    // Read aborted (stream error). Keep whatever we parsed so far.
  }
  // Final line with no trailing newline.
  if (carry.length > 0) emit(carry);
}
