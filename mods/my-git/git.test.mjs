// node --no-warnings --test mods/my-git/git.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ, failure, parseRefs, loadRefs, parseLog, loadPage, ago } from "./git.js";

// Fixture commits ignore this machine's signing setup.
const ENV = { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "A", GIT_COMMITTER_EMAIL: "a@x",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false" };

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "my-git-test-"));
  const sh = (...args) => {
    const r = spawnSync("git", args, { cwd: dir, env: ENV, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  // As the panel runs it: every read through READ.
  const git = async (args) => { const r = spawnSync("git", [...READ, ...args], { cwd: dir, env: ENV, encoding: "utf8" }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; };
  sh("init", "-q", "-b", "main");
  const commit = (name, text = name) => { writeFileSync(join(dir, name), text); sh("add", "--", name); sh("commit", "-q", "-m", `add ${name}`); return sh("rev-parse", "HEAD"); };
  return { dir, sh, git, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("parseRefs: local and remote-tracking branches, symbolic refs left out", () => {
  const line = (...f) => f.join("\0");
  const refs = parseRefs([line("refs/heads/main", "a1", "*", ""), line("refs/heads/fix/x", "b2", " ", ""),
    line("refs/remotes/origin/HEAD", "a1", " ", "refs/remotes/origin/main"), line("refs/remotes/origin/main", "a1", " ", ""), ""].join("\n"));
  assert.deepEqual(refs.local.map((r) => [r.name, r.head]), [["main", true], ["fix/x", false]]);
  assert.deepEqual(refs.remote.map((r) => r.name), ["origin/main"]);
});

test("parseLog: five fields per commit, empty subjects and parents kept, one extra means more", () => {
  const text = ["c3", "c2 c1", "A", "2026-11-01T00:00:00Z", "merge", "c2", "", "B", "2026-10-01T00:00:00Z", ""].join("\0") + "\0";
  const { commits, more } = parseLog(text, 1);
  assert.deepEqual(commits, [{ id: "c3", parents: ["c2", "c1"], author: "A", date: "2026-11-01T00:00:00Z", subject: "merge" }]);
  assert.equal(more, true);
  assert.deepEqual(parseLog(text, 2).commits[1], { id: "c2", parents: [], author: "B", date: "2026-10-01T00:00:00Z", subject: "" });
  assert.equal(parseLog(text, 2).more, false);
  assert.deepEqual(parseLog(""), { commits: [], more: false });
});

test("failure names a Git without --no-lazy-fetch", () => {
  assert.match(failure({ code: 129, stderr: "unknown option: --no-lazy-fetch\nusage: git" }).message, /does not support --no-lazy-fetch/);
  assert.equal(failure({ code: 128, stderr: "fatal: bad\n" }).message, "fatal: bad");
});

test("loadRefs: branch, head, unborn and detached", async () => {
  const r = repo();
  try {
    assert.deepEqual(await loadRefs(r.git), { local: [], remote: [], branch: "refs/heads/main", head: null });
    const c1 = r.commit("a"); r.sh("branch", "side"); r.sh("update-ref", "refs/remotes/origin/main", c1);
    r.sh("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const refs = await loadRefs(r.git);
    assert.deepEqual([refs.branch, refs.head, refs.local.map((b) => b.name).sort(), refs.remote.map((b) => b.name)], ["refs/heads/main", c1, ["main", "side"], ["origin/main"]]);
    r.sh("checkout", "-q", "--detach");
    const detached = await loadRefs(r.git);
    assert.deepEqual([detached.branch, detached.head], [null, c1]);
  } finally { r.done(); }
});

test("loadPage pages a fixed tip while the branch moves, and odd file names don't break it", async () => {
  const r = repo();
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(r.commit(`f ${i}\twith tab\nand newline`));
    const tip = ids.at(-1), first = await loadPage(r.git, tip, 0, 2);
    r.commit("later");
    const second = await loadPage(r.git, tip, 2, 2), last = await loadPage(r.git, tip, 4, 2);
    assert.deepEqual([...first.commits, ...second.commits, ...last.commits].map((c) => c.id), [...ids].reverse());
    assert.deepEqual([first.more, second.more, last.more], [true, true, false]);
    assert.equal(first.commits[0].subject, "add f 4\twith tab and newline");
  } finally { r.done(); }
});

test("loadPage ids stay clean when log.showSignature is on and a commit is signed", async () => {
  const r = repo();
  try {
    const key = join(r.dir, "..", `${r.dir.split("/").pop()}-key`);
    spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    try {
      writeFileSync(join(r.dir, "a"), "a"); r.sh("add", "a");
      r.sh("-c", "gpg.format=ssh", "-c", `user.signingkey=${key}`, "commit", "-q", "-S", "-m", "signed");
      r.sh("config", "log.showSignature", "true");
      assert.match(r.sh("log", "-1", "--format=%H"), /\n/, "the fixture shows signature output");
      const tip = r.sh("rev-parse", "HEAD");
      assert.deepEqual((await loadPage(r.git, tip)).commits.map((c) => c.id), [tip]);
    } finally { rmSync(key, { force: true }); rmSync(`${key}.pub`, { force: true }); }
  } finally { r.done(); }
});

test("reads leave refs, index and worktree alone", async () => {
  const r = repo();
  try {
    const tip = r.commit("a"); writeFileSync(join(r.dir, "a"), "dirty");
    const status = r.sh("status", "--porcelain"), index = statSync(join(r.dir, ".git", "index")).mtimeMs;
    await loadRefs(r.git); await loadPage(r.git, tip);
    assert.deepEqual([statSync(join(r.dir, ".git", "index")).mtimeMs, r.sh("status", "--porcelain"), r.sh("rev-parse", "HEAD")], [index, status, tip]);
  } finally { r.done(); }
});

test("ago", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.deepEqual(["2026-11-02T11:59:30Z", "2026-11-02T11:00:00Z", "2026-10-30T12:00:00Z"].map((d) => ago(d, now)), ["now", "1h", "3d"]);
});
