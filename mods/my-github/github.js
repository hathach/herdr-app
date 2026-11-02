// Pure helpers for the Issues and PRs panels: no herdr imports, so `node --test` can load them.

const NAME = /^[\w.-]+\/[\w.-]+$/;

// "git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://github.com/o/r.git" -> { host, repo: "o/r" }.
export function parseRemote(url) {
  const m = /^(?:[\w+]+:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m && NAME.test(m[2]) ? { host: m[1].toLowerCase(), repo: m[2] } : null;
}

// `git config --get-regexp '^remote\..*\.(url|gh-resolved)$'` lines -> [{ remote, host, repo, resolved? }].
// `gh repo set-default` stores its choice as `remote.<name>.gh-resolved`: "base" (that remote) or "owner/repo" on
// that remote's host (gh 2.103.3 context/context.go BaseRepo).
export function parseRemotes(text) {
  const remotes = new Map(), resolved = new Map();
  for (const line of text.split("\n")) {
    const m = /^remote\.(.+)\.(url|gh-resolved)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    if (m[2] === "gh-resolved") { resolved.set(m[1], m[3]); continue; }
    const parsed = parseRemote(m[3]);
    if (parsed) remotes.set(m[1], { remote: m[1], ...parsed });
  }
  for (const [name, value] of resolved) if (remotes.has(name)) remotes.get(name).resolved = value;
  return [...remotes.values()];
}

// The repo `gh repo set-default` chose -> { host, repo } or null.
export function ghDefault(remotes) {
  const r = remotes.find((r) => r.resolved);
  if (!r) return null;
  const repo = r.resolved === "base" ? r.repo : r.resolved.split("/").slice(-2).join("/");
  return NAME.test(repo) ? { host: r.host, repo } : null;
}

// Only the `upstream` and `origin` remotes count; other remotes are forks the panels never show.
// Precedence: saved choice > gh default > upstream > origin. -> { repo, choices } or { error }. `choices` are the
// github.com repos to switch between, upstream first.
const UNSUPPORTED = "Only github.com is supported in v1";

export function pickRepo({ saved, remotes }) {
  const named = ["upstream", "origin"].map((name) => remotes.find((r) => r.remote === name)).filter(Boolean);
  if (!named.length) return { error: "No origin or upstream remote" };
  const choices = [...new Set(named.filter((r) => r.host === "github.com").map((r) => r.repo))];
  if (!choices.length) return { error: UNSUPPORTED };
  const def = ghDefault(remotes);
  const repo = [saved, def?.host === "github.com" && def.repo].find((c) => choices.includes(c)) ?? choices[0];
  return { repo, choices };
}

// A failed `gh` run -> { kind, message }. Kinds: auth, rate, access, other. Exit code 4 is gh's "authentication
// required"; a bare 403 is access, not rate.
export function classifyError(output, code) {
  const text = output.trim(), message = text.split("\n").find(Boolean) ?? "gh failed";
  if (code === 4 || /gh auth login|not logged in|authentication required|HTTP 401|bad credentials/i.test(text)) return { kind: "auth", message };
  if (/rate limit|HTTP 429/i.test(text)) return { kind: "rate", message };
  if (/HTTP 40[34]|Could not resolve to a Repository|not found/i.test(text)) return { kind: "access", message };
  return { kind: "other", message };
}

export const ghFailure = (r) => classifyError(r.stderr || r.stdout || `exit ${r.code}`, r.code);

// `exec` rejects when the program can't start, the machine is unreachable or the 30 s limit passes.
export function classifyRejection(error, on) {
  const message = error?.message ?? String(error);
  if (/cannot start gh/i.test(message)) return { kind: "missing", message: `gh is not installed${on ? ` on ${on}` : ""}` };
  return { kind: /timed? ?out/i.test(message) ? "timeout" : "other", message };
}

// Check buckets in display order, with their summary word and theme colour.
export const BUCKETS = [["fail", "failing", "ansi1"], ["pending", "pending", "ansi3"], ["cancel", "cancelled", "dim"], ["pass", "passed", "ansi2"], ["skipping", "skipped", "dim"]];
const order = (bucket) => BUCKETS.findIndex(([b]) => b === bucket);

// `gh pr checks --json name,state,bucket,link,workflow` -> checks, failing first. JSON is the answer whatever the exit
// code; zero checks is an error whose text says so.
export function parseChecks(r) {
  if (r.stdout.trim().startsWith("[")) return JSON.parse(r.stdout).sort((a, b) => order(a.bucket) - order(b.bucket));
  if (/no checks reported/i.test(r.stderr)) return [];
  throw Object.assign(new Error("gh pr checks failed"), ghFailure(r));
}

// A write's exec result (or `{ error }` when exec rejected) -> { outcome, kind, message }. "failed": GitHub refused it
// or gh never started, so nothing changed; "unknown": it may have landed (timeout, lost machine, other gh failure).
export function writeOutcome(result, on) {
  if (result.error) {
    const error = classifyRejection(result.error, on);
    return { outcome: error.kind === "missing" ? "failed" : "unknown", ...error };
  }
  if (result.code === 0) return { outcome: "done" };
  const error = ghFailure(result);
  return { outcome: ["auth", "access", "rate"].includes(error.kind) ? "failed" : "unknown", ...error };
}

// The viewer's comments with this body; taken before posting, a later id not among them is the posted one.
export const matchingIds = (comments, body) => comments.filter((c) => c.viewerDidAuthor && c.body.trim() === body.trim()).map((c) => c.id);
export const commentLanded = (baseline, comments, body) => matchingIds(comments, body).some((id) => !baseline.includes(id));

export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  for (const [unit, size] of [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]]) {
    if (s >= size) return `${Math.floor(s / size)}${unit}`;
  }
  return "now";
}
