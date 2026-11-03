// Git reads for the Git panel. Pure (no herdr imports) so `node --test` loads it; `git` is (args) -> {code, stdout, stderr}.

// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie) and never fetch a partial clone's
// missing objects.
export const READ = ["--no-optional-locks", "--no-lazy-fetch", "--no-pager", "--literal-pathspecs",
  "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
export const PAGE = 100;

// A failed read's message; one about --no-lazy-fetch means this Git predates it.
export function failure(r) {
  const text = (r.stderr || r.stdout || `git exited ${r.code}`).trim();
  return new Error(/unknown option.*no-lazy-fetch/.test(text) ? "This machine's Git does not support --no-lazy-fetch" : text);
}

async function read(git, args) {
  const r = await git(args);
  if (r.code !== 0) throw failure(r);
  return r.stdout;
}

// for-each-ref lines (refname NUL objectname NUL HEAD-mark NUL symref) -> local and remote-tracking branches, newest
// commit first; symbolic refs (origin/HEAD) are left out.
export function parseRefs(text) {
  const local = [], remote = [];
  for (const line of text.split("\n")) {
    const [ref, id, head, symref] = line.split("\0");
    if (!id || symref) continue;
    if (ref.startsWith("refs/heads/")) local.push({ ref, id, name: ref.slice(11), head: head === "*" });
    else if (ref.startsWith("refs/remotes/")) remote.push({ ref, id, name: ref.slice(13), head: false });
  }
  return { local, remote };
}

// The checkout and its branches. `head`: the checked-out commit (null while unborn); `branch`: its branch ref, null
// when detached. A checked-out branch answers both; only a detached or unborn HEAD needs asking.
export async function loadRefs(git) {
  const refs = parseRefs(await read(git, ["for-each-ref", "--sort=-committerdate", "--format=%(refname)%00%(objectname)%00%(HEAD)%00%(symref)", "refs/heads/", "refs/remotes/"]));
  const current = refs.local.find((b) => b.head);
  if (current) return { ...refs, branch: current.ref, head: current.id };
  const [symbolic, head] = await Promise.all([git(["symbolic-ref", "-q", "HEAD"]), git(["rev-parse", "--verify", "-q", "HEAD^{commit}"])]);
  if (symbolic.code > 1) throw failure(symbolic);
  if (head.code > 1) throw failure(head);
  return { ...refs, branch: symbolic.code === 0 ? symbolic.stdout.trim() : null, head: head.code === 0 ? head.stdout.trim() : null };
}

// `log -z` with five NUL-separated fields per commit -> commits; `more` when the page asked one past PAGE got it.
export function parseLog(text, page = PAGE) {
  const parts = text.split("\0");
  if (parts.length % 5 === 1 && parts.at(-1) === "") parts.pop();
  const commits = [];
  for (let i = 0; i + 4 < parts.length; i += 5) {
    const [id, parents, author, date, subject] = parts.slice(i, i + 5);
    commits.push({ id, parents: parents ? parents.split(" ") : [], author, date, subject });
  }
  return { commits: commits.slice(0, page), more: commits.length > page };
}

// One page of the commits reachable from `tip`, an object id so every page reads the same history.
export async function loadPage(git, tip, skip = 0, page = PAGE) {
  return parseLog(await read(git, ["log", "-z", "--no-show-signature", "--topo-order", `--max-count=${page + 1}`, `--skip=${skip}`,
    "--format=%H%x00%P%x00%an%x00%aI%x00%s", tip, "--"]), page);
}

// "3d" style age, as my-github's ago().
export function ago(iso, now = Date.now()) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  for (const [unit, size] of [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]]) {
    if (s >= size) return `${Math.floor(s / size)}${unit}`;
  }
  return "now";
}
