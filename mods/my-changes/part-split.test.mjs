// node --no-warnings --test mods/my-changes/part-split.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextSide, sideOf, shareKey, twelfth, shareOf, shareAt } from "./part-split.js";

test("sides cycle like the Files tree and default to top", () => {
  assert.deepEqual(["left", "top", "right", "bottom"].map(nextSide), ["top", "right", "bottom", "left"]);
  assert.deepEqual(["left", "right", "bottom", "top", null, "middle", undefined].map(sideOf), ["left", "right", "bottom", "top", "top", "top", "top"]);
  assert.deepEqual([shareKey("list:git", "down"), shareKey("list:git", "across")], ["list:git", "list:git:across"]);
});

test("stored shares are validated and snapped", () => {
  const d = 5 / 12;
  assert.deepEqual([null, undefined, "", "abc", "0", "0.05", "0.95", "1", String(d), 1 / 12, 11 / 12].map((v) => shareOf(v, d)),
    [d, d, d, d, d, d, d, d, d, 1 / 12, 11 / 12]);
  // Shares saved as tenths land on the nearest twelfth.
  assert.deepEqual(["0.1", "0.4", "0.6", "0.9"].map((v) => shareOf(v, null)), [1 / 12, 5 / 12, 7 / 12, 11 / 12]);
  assert.deepEqual([0, 0.04, 0.33, 0.5, 0.96, 1].map(twelfth), [1 / 12, 1 / 12, 4 / 12, 6 / 12, 11 / 12, 11 / 12]);
});

test("the pointer gives the list's share from its own edge", () => {
  const bounds = { width: 400, height: 800 }, at = { x: 100, y: 200 };
  assert.equal(shareAt("left", at, bounds), 0.25);
  assert.equal(shareAt("right", at, bounds), 0.75);
  assert.equal(shareAt("top", at, bounds), 0.25);
  assert.equal(shareAt("bottom", at, bounds), 0.75);
  assert.equal(shareAt("left", { x: -50, y: 0 }, bounds), 1 / 12);
  assert.equal(shareAt("right", { x: -50, y: 0 }, bounds), 11 / 12);
  assert.equal(shareAt("bottom", { x: 0, y: 900 }, bounds), 1 / 12);
  assert.equal(shareAt("top", at, { width: 400, height: 0 }), null);
  assert.equal(shareAt("left", at, undefined), null);
  assert.equal(shareAt("left", undefined, bounds), null);
});
