// node --no-warnings --test mods/my-changes/commit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, parseParents, commitBase, treeDiff, prBase, prFetch } from "./commit.js";

// Fixture commits ignore this machine's signing setup.
const ENV = { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@x",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" };
const runner = (dir) => async (args) => {
  const r = spawnSync("git", ["--no-optional-locks", "--no-lazy-fetch", ...args], { cwd: dir, env: ENV, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};
// Fixture setup: git in `dir`, throwing on failure.
const shIn = (dir) => (...args) => {
  const r = spawnSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};

test("parseParents reads only the header", () => {
  assert.deepEqual(parseParents("tree t\nparent p1\nparent p2\nauthor A\n\nparent not-a-header\n"), ["p1", "p2"]);
  assert.deepEqual(parseParents("tree t\nauthor A\n\nmsg\n"), []);
});

test("failure names a Git without --no-lazy-fetch", () => {
  assert.match(failure({ code: 129, stderr: "unknown option: --no-lazy-fetch\nusage: git" }).message, /does not support --no-lazy-fetch/);
  assert.equal(failure({ code: 128, stderr: "fatal: bad\n" }).message, "fatal: bad");
});

test("treeDiff compares with the parent, or a root commit with nothing", () => {
  assert.deepEqual(treeDiff({ parent: "p" }, "c", "-p").slice(-3), ["-p", "p", "c"]);
  assert.deepEqual(treeDiff({ parent: null }, "c").slice(-2), ["--root", "c"]);
});

test("commitBase: ordinary, merge, root, a shallow boundary with and without its parent object", async () => {
  const dir = mkdtempSync(join(tmpdir(), "my-changes-commit-")), clone = mkdtempSync(join(tmpdir(), "my-changes-shallow-"));
  const sh = shIn(dir);
  const commit = (name) => { writeFileSync(join(dir, name), name); sh("add", "--", name); sh("commit", "-q", "-m", name); return sh("rev-parse", "HEAD"); };
  try {
    sh("init", "-q", "-b", "main");
    const root = commit("a"), c2 = commit("b");
    sh("checkout", "-q", "-b", "side", root); const side = commit("c");
    sh("checkout", "-q", "main"); sh("merge", "-q", "--no-ff", "-m", "merge", "side");
    const merge = sh("rev-parse", "HEAD"), git = runner(dir);
    assert.deepEqual(await commitBase(git, root, []), { parent: null, merge: false, unavailable: false });
    assert.deepEqual(await commitBase(git, c2, [root]), { parent: root, merge: false, unavailable: false });
    assert.deepEqual(await commitBase(git, merge, [c2, side]), { parent: c2, merge: true, unavailable: false });
    // A depth-1 clone: log shows the boundary with no parents; its header still names them, their objects absent.
    spawnSync("git", ["clone", "-q", "--depth=1", `file://${dir}`, clone], { env: ENV });
    assert.deepEqual(await commitBase(runner(clone), merge, []), { parent: c2, merge: true, unavailable: true });
    // The boundary's parent object fetched later (a deeper fetch of another ref): comparable again.
    spawnSync("git", ["fetch", "-q", "--depth=1", "origin", c2], { cwd: clone, env: ENV });
    assert.deepEqual(await commitBase(runner(clone), merge, []), { parent: c2, merge: true, unavailable: false });
    await assert.rejects(commitBase(git, "0".repeat(40), []));
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(clone, { recursive: true, force: true }); }
});

// main a-b; pr: c on a, later merged into main (`merged`); m1 and m2 each merge x and y, so they have two merge bases;
// lone shares no history.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "my-changes-pr-"));
  const sh = shIn(dir);
  const commit = (name) => { writeFileSync(join(dir, name), name); sh("add", "--", name); sh("commit", "-q", "-m", name); return sh("rev-parse", "HEAD"); };
  sh("init", "-q", "-b", "main");
  const a = commit("a"), b = commit("b");
  sh("checkout", "-q", "-b", "pr", a); const c = commit("c");
  sh("checkout", "-q", "-b", "x", a); const x = commit("x");
  sh("checkout", "-q", "-b", "y", a); const y = commit("y");
  sh("checkout", "-q", "x"); sh("merge", "-q", "--no-ff", "-m", "m1", "y"); const m1 = sh("rev-parse", "HEAD");
  sh("checkout", "-q", "-B", "y2", y); sh("merge", "-q", "--no-ff", "-m", "m2", x); const m2 = sh("rev-parse", "HEAD");
  sh("checkout", "-q", "main"); sh("merge", "-q", "--no-ff", "-m", "merge pr", "pr"); const merged = sh("rev-parse", "HEAD");
  sh("checkout", "-q", "--orphan", "lone"); sh("rm", "-q", "-rf", "."); const lone = commit("lone");
  return { dir, a, b, c, m1, m2, merged, lone };
}

test("prBase: merge base, missing tips, merged head, criss-cross, unrelated, shallow", async () => {
  const f = fixture(), clone = mkdtempSync(join(tmpdir(), "my-changes-pr-shallow-"));
  try {
    const git = runner(f.dir), none = { missing: [] };
    assert.deepEqual(await prBase(git, f.c, f.b), { ...none, parent: f.a, unavailable: null });
    const gone = "1".repeat(40);
    assert.deepEqual(await prBase(git, gone, f.b), { parent: null, missing: [gone], unavailable: "not in this clone" });
    assert.deepEqual(await prBase(git, f.c, gone), { parent: null, missing: [gone], unavailable: "not in this clone" });
    assert.deepEqual(await prBase(git, f.c, f.merged), { ...none, parent: null, unavailable: "the head is already in the base" });
    assert.deepEqual(await prBase(git, f.m1, f.m2), { ...none, parent: null, unavailable: "more than one merge base" });
    assert.deepEqual(await prBase(git, f.lone, f.b), { ...none, parent: null, unavailable: "no common history with the base" });
    // Branch tips only: c and m1 are here, their merge base a is not.
    spawnSync("git", ["clone", "-q", "--depth=1", "--no-single-branch", `file://${f.dir}`, clone], { env: ENV });
    const shallow = runner(clone);
    assert.deepEqual(await prBase(shallow, f.c, f.m1), { ...none, parent: null, unavailable: "this shallow clone lacks their common history" });
  } finally { rmSync(f.dir, { recursive: true, force: true }); rmSync(clone, { recursive: true, force: true }); }
});

test("prFetch takes exactly the commits and writes no refs, FETCH_HEAD or commit graph", async () => {
  const f = fixture(), clone = mkdtempSync(join(tmpdir(), "my-changes-pr-fetch-"));
  const sh = shIn(clone);
  try {
    sh("init", "-q", "-b", "main");
    // A ref of its own gives a commit graph something to cover; the remote's refspec would map fetched refs.
    writeFileSync(join(clone, "own"), "own"); sh("add", "own"); sh("commit", "-q", "-m", "own");
    sh("config", "fetch.writeCommitGraph", "true"); sh("remote", "add", "origin", `file://${f.dir}`);
    const before = sh("for-each-ref");
    sh(...prFetch(`file://${f.dir}`, [f.c, f.b]));
    assert.equal(sh("for-each-ref"), before);
    assert.equal(existsSync(join(clone, ".git", "FETCH_HEAD")), false);
    assert.equal(existsSync(join(clone, ".git", "objects", "info", "commit-graph")) || existsSync(join(clone, ".git", "objects", "info", "commit-graphs")), false);
    assert.deepEqual(await prBase(runner(clone), f.c, f.b), { parent: f.a, missing: [], unavailable: null });
    // Polling reads leave refs and the index alone.
    const index = existsSync(join(clone, ".git", "index"));
    await prBase(runner(clone), f.c, f.b);
    assert.equal(sh("for-each-ref"), before); assert.equal(existsSync(join(clone, ".git", "index")), index);
    assert.deepEqual(readdirSync(join(clone, ".git")).filter((n) => n.endsWith(".lock")), []);
  } finally { rmSync(f.dir, { recursive: true, force: true }); rmSync(clone, { recursive: true, force: true }); }
});
