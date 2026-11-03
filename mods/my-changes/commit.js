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
