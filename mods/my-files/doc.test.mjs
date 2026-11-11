// node --no-warnings --test mods/my-files/doc.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { alerts, overBytes, tableCells, markdownDoc, RENDER } from "./doc.js";

test("an alert marker becomes its kind with a line break", () => {
  assert.equal(alerts("> [!NOTE]\n> hi"), "> **Note**  \n> hi");
  assert.equal(alerts(">[!WARNING]"), ">**Warning**  ");
});

test("only a whole quote line is an alert", () => {
  assert.equal(alerts("text [!NOTE]\n> [!NOTE] more"), "text [!NOTE]\n> [!NOTE] more");
});

test("fenced code keeps its alert markers", () => {
  const md = "```md\n> [!NOTE]\n```\n> [!TIP]\n~~~~\n> [!NOTE]\n~~~\n> [!NOTE]\n~~~~\n> [!NOTE]";
  assert.equal(alerts(md), "```md\n> [!NOTE]\n```\n> **Tip**  \n~~~~\n> [!NOTE]\n~~~\n> [!NOTE]\n~~~~\n> **Note**  ");
});

test("a fence in a quote, and a fence line with text, keep code as code", () => {
  assert.equal(alerts("> ```md\n> [!NOTE]\n> ```\n> [!NOTE]"), "> ```md\n> [!NOTE]\n> ```\n> **Note**  ");
  assert.equal(alerts("```\n```not-a-close\n> [!NOTE]\n```\n> [!NOTE]"), "```\n```not-a-close\n> [!NOTE]\n```\n> **Note**  ");
  assert.equal(alerts("```md\n> ```\n> [!NOTE]\n```\n> [!NOTE]"), "```md\n> ```\n> [!NOTE]\n```\n> **Note**  ");
  assert.equal(alerts("> ```\n> code\n\n> [!NOTE]"), "> ```\n> code\n\n> **Note**  ");
});

test("overBytes compares encoded bytes with the limit", () => {
  for (const s of ["", "abc", "✓", "é", "😀", "a✓é😀", "x✓".repeat(50)])
    for (const limit of [0, 1, 3, 4, 5, 10, 99, 100, 150, 200, 1000]) assert.equal(overBytes(s, limit), Buffer.byteLength(s) > limit, `${s} ${limit}`);
});

test("tableCells counts header and rows times columns, outer pipes optional", () => {
  assert.equal(tableCells("| a | b |\n|---|:-:|\n| 1 | 2 |\n\ntext | x"), 4);
  assert.equal(tableCells("a | b | c\n--- | --- | ---\n1 | 2 | 3\n4 | 5 | 6\n\npara"), 9);
  assert.equal(tableCells("text | with a pipe\n- list\n---"), 0);
  assert.equal(tableCells("> a | b\n> --- | ---\n> 1 | 2\n"), 4);
});

test("markdownDoc renders within its limits and says why not beyond them", () => {
  assert.deepEqual(markdownDoc("> [!NOTE]\n> hi"), { md: "> **Note**  \n> hi" });
  assert.deepEqual(markdownDoc("x".repeat(RENDER.bytes + 1)), { note: "Over 128 KiB" });
  assert.deepEqual(markdownDoc("✓".repeat(RENDER.bytes / 3 + 1)), { note: "Over 128 KiB" });
  const table = "| a | b |\n|---|---|\n" + "| 1 | 2 |\n".repeat(RENDER.cells / 2);
  assert.deepEqual(markdownDoc(table), { note: "Tables over 2000 cells" });
  assert.ok(markdownDoc("| a | b |\n|---|---|\n" + "| 1 | 2 |\n".repeat(RENDER.cells / 2 - 1)).md);
});
