// The Git panel's commit comparison. Pure (no herdr imports) so `node --test` loads it; `git` is (args) -> {code,
// stdout, stderr}, run with the commit reads' flags.

// A failed read's message; one about --no-lazy-fetch means this Git predates it (as my-git's failure()).
export function failure(r) {
  const text = (r.stderr || r.stdout || `git exited ${r.code}`).trim();
  return new Error(/unknown option.*no-lazy-fetch/.test(text) ? "This machine's Git does not support --no-lazy-fetch" : text);
}

// A commit object's parent ids, from its header.
export function parseParents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) break;
    if (line.startsWith("parent ")) out.push(line.slice(7));
  }
  return out;
}

// What a commit is compared with: its first parent, null for a root commit; `unavailable` when that parent's object is
// not here. `parents` are log's, which a shallow boundary shows as none, so then the header decides.
export async function commitBase(git, sha, parents) {
  let list = parents;
  if (!list.length) {
    const r = await git(["cat-file", "-p", sha]);
    if (r.code !== 0) throw failure(r);
    list = parseParents(r.stdout);
  }
  const parent = list[0] ?? null, merge = list.length > 1;
  if (!parent) return { parent, merge, unavailable: false };
  const r = await git(["cat-file", "-e", parent]);
  if (r.code > 1) throw failure(r);
  return { parent, merge, unavailable: r.code === 1 };
}

// diff-tree args for a commit against its base (its first parent, or nothing for a root commit).
export const treeDiff = (base, sha, ...options) => ["diff-tree", "--no-commit-id", "-r", "--no-renames", "--no-ext-diff",
  "--no-textconv", "--no-color", ...options, ...(base.parent ? [base.parent, sha] : ["--root", sha])];

// What a pull request is compared with: where its head left its base, as GitHub's Files changed does. -> { parent,
// merge: false, missing, unavailable }: `missing` the tips whose objects are not here, `unavailable` why there is no
// comparison, else null.
export async function prBase(git, head, base) {
  const missing = [];
  for (const sha of [head, base]) {
    const r = await git(["cat-file", "-e", sha]);
    if (r.code > 1) throw failure(r);
    if (r.code === 1) missing.push(sha);
  }
  const answer = (parent, unavailable) => ({ parent, merge: false, missing, unavailable });
  if (missing.length) return answer(null, "not in this clone");
  // Exit 1: no common history here.
  const r = await git(["merge-base", "--all", base, head]);
  if (r.code > 1) throw failure(r);
  const bases = r.stdout.split("\n").filter(Boolean);
  if (!bases.length) {
    const shallow = await git(["rev-parse", "--is-shallow-repository"]);
    if (shallow.code !== 0) throw failure(shallow);
    return answer(null, shallow.stdout.trim() === "true" ? "this shallow clone lacks their common history" : "no common history with the base");
  }
  if (bases.length > 1) return answer(null, "more than one merge base");
  // A head already in its base (merged, or the base moved past it) would compare as no changes.
  if (bases[0] === head) return answer(null, "the head is already in the base");
  return answer(bases[0], null);
}

// git args that fetch exactly these commits from a URL and write only their objects: no refs, FETCH_HEAD, tags,
// submodules, commit graph or maintenance.
export const prFetch = (url, shas) => ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-tags",
  "--no-recurse-submodules", "--no-write-fetch-head", "--no-auto-maintenance", "--no-write-commit-graph", "--refmap=", url, ...shas];
