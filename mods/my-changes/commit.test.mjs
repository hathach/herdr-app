// node --no-warnings --test mods/my-changes/commit.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, parseParents, commitBase, treeDiff } from "./commit.js";

// Fixture commits ignore this machine's signing setup.
const ENV = { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@x",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" };
const runner = (dir) => async (args) => {
  const r = spawnSync("git", ["--no-optional-locks", "--no-lazy-fetch", ...args], { cwd: dir, env: ENV, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
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
  const sh = (...args) => { const r = spawnSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
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
