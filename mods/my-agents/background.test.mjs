// node --no-warnings --test mods/my-agents/background.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { RANK, background, rankOf } from "./background.js";

const term = (labels, fg = { name: "claude", argv: ["claude-ada"] }) => ({ foreground: fg, labels });
const both = { "claude.background_tasks": "2", "claude.session_crons": "1" };

test("background reads the counts while claude is in front and its turn has ended", () => {
  assert.deepEqual(background("done", term(both)), { tasks: 2, crons: 1 });
  assert.deepEqual(background("idle", term({ "claude.session_crons": "3" })), { tasks: 0, crons: 3 });
  assert.deepEqual(background("done", term(both, { argv: ["claude"] })), { tasks: 2, crons: 1 });
});

test("background is nothing while working or blocked, after claude left, without labels or with bad ones", () => {
  const none = { tasks: 0, crons: 0 };
  for (const status of ["working", "blocked", "error", undefined]) assert.deepEqual(background(status, term(both)), none);
  assert.deepEqual(background("done", term(both, { name: "bash", argv: ["bash"] })), none);
  assert.deepEqual(background("done", term(both, null)), none);
  assert.deepEqual(background("done", term(undefined)), none);
  assert.deepEqual(background("done", undefined), none);
  assert.deepEqual(background("done", term({ "claude.background_tasks": "0", "claude.session_crons": "-1" })), none);
  assert.deepEqual(background("done", term({ "claude.background_tasks": "two", "claude.session_crons": "1.5" })), none);
});

test("rankOf: done stays done, idle with tasks is working, held done wins, crons and others unchanged", () => {
  assert.equal(rankOf("done", { tasks: 2 }), RANK.done);
  assert.equal(rankOf("idle", { tasks: 1 }), RANK.working);
  assert.equal(rankOf("idle", { heldDone: true, tasks: 1 }), RANK.done);
  assert.equal(rankOf("idle", { heldDone: true }), RANK.done);
  assert.equal(rankOf("idle"), RANK.idle);
  assert.equal(rankOf("blocked", { tasks: 3 }), RANK.blocked);
  assert.equal(rankOf("working", { tasks: 3 }), RANK.working);
  assert.equal(rankOf("unknown"), 0);
});
