#!/usr/bin/env node
// Claude Code hook (Stop, SessionStart, SessionEnd): leaves the session's in-flight background work on its herdr-core
// terminal as labels, for my-agents. It never stops a session: every failure exits 0 quietly, and `hc` gets 1 s.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LABELS = ["claude.background_tasks", "claude.session_crons"];

// A hook event -> `hc label` pairs, or null for an event it ignores. Stop gives each list's length; a list that is
// empty or missing removes its label (`k=`). A process starting or ending has nothing in flight; /clear ends one
// session and starts the next in the same process, and its background work carries on (Claude Code 2.1.318), as it
// does through a compaction, so neither clears.
export function labelsFor(event) {
  const count = (list) => (Array.isArray(list) && list.length ? String(list.length) : "");
  const name = event?.hook_event_name, cleared = LABELS.map((k) => `${k}=`);
  if (name === "Stop") return [`${LABELS[0]}=${count(event.background_tasks)}`, `${LABELS[1]}=${count(event.session_crons)}`];
  if (name === "SessionStart") return ["startup", "resume"].includes(event.source) ? cleared : null;
  if (name === "SessionEnd") return event.reason === "clear" ? null : cleared;
  return null;
}

function main() {
  // A session moved to the background (`/exit`, "Move to background") no longer owns the terminal it left.
  const terminal = process.env.CLAUDE_CODE_SESSION_KIND === "bg" ? null : process.env.HC_TERMINAL_ID;
  if (!terminal) return;
  try {
    const pairs = labelsFor(JSON.parse(readFileSync(0, "utf8")));
    if (pairs) execFileSync("hc", ["label", terminal, ...pairs], { timeout: 1000, stdio: "ignore" });
  } catch {}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
