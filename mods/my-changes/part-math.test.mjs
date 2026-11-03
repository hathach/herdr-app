// node --no-warnings --test mods/my-changes/part-math.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BASE, PART, OFFSET, baseKey, offsetKey, baseSize, offsetOf, partSize, stepOffset, wheelStep } from "./part-math.js";

test("copies are identical", () => {
  for (const [file, mods] of [["part-math.js", ["my-files", "my-git", "my-github", "my-tabs"]], ["part-size.js", ["my-files", "my-git", "my-github"]]]) {
    const mine = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const mod of mods) assert.equal(readFileSync(new URL(`../${mod}/${file}`, import.meta.url), "utf8"), mine, `${mod}/${file}`);
  }
});

test("keys", () => {
  assert.equal(baseKey("git"), "panel.text_size.git");
  assert.equal(offsetKey("git", "diff"), "panel.text_offset.git.diff");
});

test("stored values are normalised", () => {
  assert.deepEqual([undefined, null, "15", NaN, Infinity, 9, 21, 14.6, 16].map(baseSize), [13, 13, 13, 13, 13, 10, 20, 15, 16]);
  assert.deepEqual([undefined, "2", -40, 40, 1.4, -3].map(offsetOf), [0, 0, -12, 14, 1, -3]);
});

test("every part size is reachable from every base", () => {
  for (let base = BASE.min; base <= BASE.max; base++)
    for (let size = PART.min; size <= PART.max; size++) {
      const offset = size - base;
      assert.ok(offset >= OFFSET.min && offset <= OFFSET.max, `${base} ${size}`);
      assert.equal(partSize(base, offsetOf(offset)), size);
    }
});

test("steps store the offset of the next size and stop at the limits", () => {
  assert.equal(stepOffset(13, 0, 1), 1);
  assert.equal(stepOffset(13, 2, -1), 1);
  assert.equal(stepOffset(13, 11, 1), null);
  assert.equal(stepOffset(10, -2, -1), null);
  assert.equal(stepOffset(20, 4, -1), 3);
});

test("a saturated part steps back at once after the base moves", () => {
  // At base 20 an offset of 4 shows 24; moving the base to 10 shows 14, and a step from there is relative to 14.
  assert.equal(partSize(20, 4), PART.max);
  assert.equal(partSize(10, 4), 14);
  assert.equal(stepOffset(10, 4, -1), 3);
  // An offset past the limit (from a larger base) steps from the shown size, not the stored offset.
  assert.equal(partSize(20, 10), PART.max);
  assert.equal(stepOffset(20, 10, -1), 3);
});

test("a wheel steps once per event, trackpad pixels carry their remainder", () => {
  const ev = (y, lines, touch_phase = "moved") => ({ delta: { x: 0, y }, delta_lines: lines === undefined ? undefined : { x: 0, y: lines }, touch_phase });
  assert.deepEqual(wheelStep(0, ev(20, 1)), { acc: 0, by: 1 });
  assert.deepEqual(wheelStep(0, ev(-60, -3)), { acc: 0, by: -1 });
  assert.deepEqual(wheelStep(0.5, ev(40, 1.5)), { acc: 0, by: 1 });
  const run = (ys) => { let s = { acc: 0, by: 0 }, steps = []; for (const y of ys) { s = wheelStep(s.acc, ev(y)); steps.push(s.by); } return { steps, acc: s.acc }; };
  assert.deepEqual(run([15, 15, 15, 15, 15]).steps, [0, 0, 1, 0, 0]);
  assert.equal(run([80]).steps[0], 2);
  assert.deepEqual(run([40, 40]).steps, [1, 1]);
  assert.equal(run([50]).acc, 0.25);
  assert.deepEqual(wheelStep(30 / 40, ev(-5, undefined, "ended")), { acc: 0, by: 0 });
  assert.deepEqual(wheelStep(0.5, ev(-40)), { acc: 0, by: -1 });
});
