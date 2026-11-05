// Agent ranks and what a Claude Code session still has in flight once its turn ended. Pure (no herdr imports) so
// `node --test` loads it.

export const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

// The counts hooks/claude-background.mjs leaves on a session's terminal: { tasks, crons }. Trusted only while claude
// is the terminal's foreground program (a killed one leaves its last labels behind) and its turn has ended (during a
// turn they are the previous turn's).
export function background(status, term) {
  const none = { tasks: 0, crons: 0 };
  const fg = term?.foreground, claude = fg?.name === "claude" || /^claude(-ada)?$/.test(fg?.argv?.[0] ?? "");
  if ((status !== "done" && status !== "idle") || !claude) return none;
  const count = (v) => (/^[1-9]\d{0,5}$/.test(v ?? "") ? Number(v) : 0);
  return { tasks: count(term.labels?.["claude.background_tasks"]), crons: count(term.labels?.["claude.session_crons"]) };
}

// An agent's place in the list. A done agent you are looking at turns idle but stays with Done until you leave it
// (`heldDone`); an idle one still running background tasks sorts with Working. Scheduled prompts alone don't count.
export function rankOf(status, { heldDone = false, tasks = 0 } = {}) {
  if (status === "idle" && heldDone) return RANK.done;
  if (status === "idle" && tasks > 0) return RANK.working;
  return RANK[status] ?? 0;
}
