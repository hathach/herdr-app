// node --no-warnings --test hooks/claude-background.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { labelsFor } from "./claude-background.mjs";

const HOOK = fileURLToPath(new URL("./claude-background.mjs", import.meta.url));

test("labelsFor: Stop counts, empty or missing lists remove, a process start or end clears, /clear and the rest are ignored", () => {
  assert.deepEqual(labelsFor({ hook_event_name: "Stop", background_tasks: [{}, {}], session_crons: [{}] }),
    ["claude.background_tasks=2", "claude.session_crons=1"]);
  assert.deepEqual(labelsFor({ hook_event_name: "Stop", stop_hook_active: true, background_tasks: [] }),
    ["claude.background_tasks=", "claude.session_crons="]);
  assert.deepEqual(labelsFor({ hook_event_name: "Stop", background_tasks: "2", session_crons: { length: 3 } }),
    ["claude.background_tasks=", "claude.session_crons="]);
  const cleared = ["claude.background_tasks=", "claude.session_crons="];
  for (const source of ["startup", "resume"]) assert.deepEqual(labelsFor({ hook_event_name: "SessionStart", source }), cleared);
  for (const source of ["clear", "compact"]) assert.equal(labelsFor({ hook_event_name: "SessionStart", source }), null);
  for (const reason of ["prompt_input_exit", "logout", "other"]) assert.deepEqual(labelsFor({ hook_event_name: "SessionEnd", reason }), cleared);
  assert.equal(labelsFor({ hook_event_name: "SessionEnd", reason: "clear" }), null);
  assert.equal(labelsFor({ hook_event_name: "SubagentStop", background_tasks: [{}] }), null);
  assert.equal(labelsFor(null), null);
});

// Runs the hook with a fake `hc` first on PATH that records its argv, or sleeps.
function run(input, { terminal = "ci/t7", hc = "record", path, kind } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "claude-background-"));
  const log = join(dir, "argv");
  if (hc) {
    writeFileSync(join(dir, "hc"), hc === "sleep" ? "#!/bin/sh\nsleep 5\n" : `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
    chmodSync(join(dir, "hc"), 0o755);
  }
  const env = { PATH: path ?? `${dir}:/usr/bin:/bin`, ...(terminal ? { HC_TERMINAL_ID: terminal } : {}), ...(kind ? { CLAUDE_CODE_SESSION_KIND: kind } : {}) };
  const started = Date.now();
  const r = spawnSync(process.execPath, [HOOK], { input, env, encoding: "utf8" });
  const argv = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : null;
  rmSync(dir, { recursive: true, force: true });
  return { ...r, argv, ms: Date.now() - started };
}

const STOP = JSON.stringify({ hook_event_name: "Stop", background_tasks: [{ type: "monitor" }], session_crons: [] });

test("the hook labels its terminal verbatim, both pairs in one hc call, silently", () => {
  const r = run(STOP);
  assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, "");
  assert.deepEqual(r.argv, ["label", "ci/t7", "claude.background_tasks=1", "claude.session_crons="]);
});

test("the hook exits 0 quietly without a terminal, in a background session, without hc, on bad input and when hc hangs", () => {
  assert.equal(run(STOP, { terminal: null }).argv, null);
  assert.equal(run(STOP, { kind: "bg" }).argv, null);
  for (const r of [run(STOP, { hc: null, path: "/nonexistent" }), run("not json"), run(JSON.stringify({ hook_event_name: "PreToolUse" }))]) {
    assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.equal(r.stderr, ""); assert.equal(r.argv, null);
  }
  const slow = run(STOP, { hc: "sleep" });
  assert.equal(slow.status, 0); assert.equal(slow.stdout, "");
  assert.ok(slow.ms < 3000, `took ${slow.ms} ms`);
});
