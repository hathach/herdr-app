// node --no-warnings --test mods/my-changes/tree.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileTree, treeRows } from "./tree.js";

const files = ["src/b.c", "README.md", "src/a/x.h", "a", "a/b", "src/a.c"].map((path) => ({ path }));
const shown = (rows) => rows.map((r) => `${"  ".repeat(r.depth)}${r.dir !== undefined ? r.name + "/" : r.file.path.split("/").pop()}`);

test("folders before files, each by name, nested by depth", () => {
  assert.deepEqual(shown(treeRows(fileTree(files), new Set())), ["a/", "  b", "src/", "  a/", "    x.h", "  a.c", "  b.c", "a", "README.md"]);
});

test("a deleted file and a new folder of the same name are separate rows", () => {
  const rows = treeRows(fileTree(files), new Set());
  assert.equal(rows.find((r) => r.dir === "a")?.name, "a");
  assert.ok(rows.some((r) => r.file?.path === "a"));
});

test("a collapsed folder hides everything under it, nothing else", () => {
  assert.deepEqual(shown(treeRows(fileTree(files), new Set(["src"]))), ["a/", "  b", "src/", "a", "README.md"]);
  assert.deepEqual(shown(treeRows(fileTree(files), new Set(["src/a"]))), ["a/", "  b", "src/", "  a/", "  a.c", "  b.c", "a", "README.md"]);
});

test("rows keep the file objects, so counts filled in later show", () => {
  const rows = treeRows(fileTree(files), new Set());
  assert.equal(rows.find((r) => r.file?.path === "src/a/x.h").file, files[2]);
});
