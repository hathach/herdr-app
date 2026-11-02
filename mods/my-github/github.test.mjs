// node --no-warnings --test mods/my-github/github.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRemote, parseRemotes, ghDefault, pickRepo, classifyError, classifyRejection, parseChecks, ago, writeOutcome, matchingIds, commentLanded } from "./github.js";

test("parseRemote reads ssh, scp-like and https URLs", () => {
  const want = { host: "github.com", repo: "hathach/tinyusb" };
  for (const url of ["git@github.com:hathach/tinyusb.git", "ssh://git@github.com/hathach/tinyusb", "https://github.com/hathach/tinyusb.git",
    "https://github.com/hathach/tinyusb/", "ssh://git@github.com:22/hathach/tinyusb.git", "https://user@GitHub.com/hathach/tinyusb"]) {
    assert.deepEqual(parseRemote(url), want, url);
  }
  assert.deepEqual(parseRemote("git@gitlab.com:a/b.git"), { host: "gitlab.com", repo: "a/b" });
  assert.equal(parseRemote("/srv/git/repo.git"), null);
  assert.equal(parseRemote("https://github.com/only-owner"), null);
});

test("parseRemotes keeps remote names and gh's resolution", () => {
  const text = "remote.origin.url git@github.com:me/r.git\nremote.up.stream.url https://github.com/them/r\nremote.local.url /tmp/x\n" +
    "remote.origin.gh-resolved base\nremote.gone.gh-resolved base\n";
  assert.deepEqual(parseRemotes(text), [
    { remote: "origin", host: "github.com", repo: "me/r", resolved: "base" },
    { remote: "up.stream", host: "github.com", repo: "them/r" },
  ]);
});

test("ghDefault: base, owner/repo, and the remote's host", () => {
  assert.deepEqual(ghDefault([{ remote: "origin", host: "github.com", repo: "me/r", resolved: "base" }]), { host: "github.com", repo: "me/r" });
  assert.deepEqual(ghDefault([{ remote: "origin", host: "github.com", repo: "me/r", resolved: "org/r" }]), { host: "github.com", repo: "org/r" });
  assert.deepEqual(ghDefault([{ remote: "origin", host: "ghe.corp", repo: "me/r", resolved: "org/r" }]), { host: "ghe.corp", repo: "org/r" });
  assert.equal(ghDefault([{ remote: "origin", host: "github.com", repo: "me/r" }]), null);
});

const r = (remote, repo, host = "github.com", resolved) => ({ remote, host, repo, ...(resolved ? { resolved } : {}) });

test("pickRepo precedence", () => {
  const remotes = [r("origin", "me/x"), r("upstream", "org/x")];
  assert.deepEqual(pickRepo({ remotes }), { repo: "org/x", choices: ["org/x", "me/x"] });
  assert.equal(pickRepo({ remotes, saved: "me/x" }).repo, "me/x");
  const resolved = [r("origin", "me/x", "github.com", "base"), r("upstream", "org/x")];
  assert.equal(pickRepo({ remotes: resolved }).repo, "me/x");
  assert.equal(pickRepo({ remotes: resolved, saved: "org/x" }).repo, "org/x");
  // A saved choice that is no longer origin or upstream is ignored.
  assert.equal(pickRepo({ remotes, saved: "gone/x" }).repo, "org/x");
});

test("pickRepo never shows other forks", () => {
  const forks = [r("a", "a/x"), r("origin", "me/x"), r("b", "b/x")];
  assert.deepEqual(pickRepo({ remotes: forks }), { repo: "me/x", choices: ["me/x"] });
  assert.equal(pickRepo({ remotes: forks, saved: "a/x" }).repo, "me/x");
  assert.deepEqual(pickRepo({ remotes: [r("origin", "me/x"), r("b", "b/x", "github.com", "base")] }), { repo: "me/x", choices: ["me/x"] });
  assert.deepEqual(pickRepo({ remotes: [r("upstream", "org/x"), r("fork", "a/x")] }), { repo: "org/x", choices: ["org/x"] });
  assert.deepEqual(pickRepo({ remotes: [r("fork", "a/x")] }), { error: "No origin or upstream remote" });
  assert.deepEqual(pickRepo({ remotes: [] }), { error: "No origin or upstream remote" });
});

test("pickRepo single and unsupported", () => {
  assert.deepEqual(pickRepo({ remotes: [r("origin", "me/x"), r("upstream", "me/x")] }), { repo: "me/x", choices: ["me/x"] });
  assert.deepEqual(pickRepo({ remotes: [r("origin", "a/b", "gitlab.com")] }), { error: "Only github.com is supported in v1" });
  assert.deepEqual(pickRepo({ remotes: [r("origin", "a/b", "gitlab.com"), r("upstream", "org/b")] }), { repo: "org/b", choices: ["org/b"] });
  // gh's default on another host is that host's repo, never github.com's same-named one.
  const ghe = [r("upstream", "org/x"), r("origin", "me/x"), r("corp", "me/x", "ghe.corp", "base")];
  assert.equal(pickRepo({ remotes: ghe }).repo, "org/x");
});

test("classifyError", () => {
  assert.equal(classifyError("To get started with GitHub CLI, please run:  gh auth login").kind, "auth");
  assert.equal(classifyError("HTTP 403: API rate limit exceeded for user").kind, "rate");
  assert.equal(classifyError("HTTP 429: Too Many Requests").kind, "rate");
  assert.equal(classifyError("HTTP 403: Resource not accessible by integration").kind, "access");
  assert.equal(classifyError("GraphQL: Could not resolve to a Repository with the name 'a/b'.").kind, "access");
  assert.equal(classifyError("something else\nmore").message, "something else");
  assert.equal(classifyError("anything", 4).kind, "auth");
});

test("parseChecks", () => {
  const json = '[{"name":"a","bucket":"pass"},{"name":"b","bucket":"fail"},{"name":"c","bucket":"pending"}]';
  assert.deepEqual(parseChecks({ code: 0, stdout: json, stderr: "" }).map((c) => c.bucket), ["fail", "pending", "pass"]);
  assert.equal(parseChecks({ code: 8, stdout: json, stderr: "" }).length, 3); // defensive: gh 2.103.3 exits 0 with JSON
  assert.deepEqual(parseChecks({ code: 1, stdout: "", stderr: "no checks reported on the 'x' branch" }), []);
  assert.throws(() => parseChecks({ code: 1, stdout: "", stderr: "HTTP 401: Bad credentials" }), (e) => e.kind === "auth");
});

test("classifyRejection", () => {
  assert.deepEqual(classifyRejection(new Error("`herdr.exec`: cannot start gh: No such file or directory (os error 2)"), "ci"), { kind: "missing", message: "gh is not installed on ci" });
  assert.equal(classifyRejection(new Error("cannot start gh: x"), null).message, "gh is not installed");
  assert.equal(classifyRejection(new Error("timed out after 30 s")).kind, "timeout");
  assert.equal(classifyRejection("machine unreachable").kind, "other");
});

test("ago", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  assert.equal(ago("2026-11-02T11:59:30Z", now), "now");
  assert.equal(ago("2026-11-02T11:00:00Z", now), "1h");
  assert.equal(ago("2026-10-30T12:00:00Z", now), "3d");
});

test("writeOutcome", () => {
  assert.equal(writeOutcome({ code: 0, stdout: "https://github.com/o/r/issues/1#issuecomment-1", stderr: "" }).outcome, "done");
  assert.equal(writeOutcome({ code: 1, stdout: "", stderr: "HTTP 403: Must have admin rights" }).outcome, "failed");
  assert.equal(writeOutcome({ code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" }).outcome, "failed");
  assert.equal(writeOutcome({ code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway" }).outcome, "unknown");
  assert.deepEqual(writeOutcome({ error: new Error("`herdr.exec`: cannot start gh: No such file or directory") }, "ci"), { outcome: "failed", kind: "missing", message: "gh is not installed on ci" });
  assert.equal(writeOutcome({ error: new Error("timed out after 30 s") }).outcome, "unknown");
  assert.equal(writeOutcome({ error: new Error("machine ci is unreachable") }).outcome, "unknown");
});

test("commentLanded needs a new matching comment, not an older identical one", () => {
  const old = { id: "A", viewerDidAuthor: true, body: "+1" };
  const other = { id: "B", viewerDidAuthor: false, body: "+1" };
  const baseline = matchingIds([old, other], "+1 ");
  assert.deepEqual(baseline, ["A"]);
  assert.equal(commentLanded(baseline, [old, other], "+1"), false);
  assert.equal(commentLanded(baseline, [old, other, { id: "C", viewerDidAuthor: false, body: "+1" }], "+1"), false);
  assert.equal(commentLanded(baseline, [old, other, { id: "D", viewerDidAuthor: true, body: "+1\n" }], "+1"), true);
});
