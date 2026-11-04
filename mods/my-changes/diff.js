// Diff rows for the Changes panel and their syntax colours. Pure (no herdr imports) so `node --test` loads it.
import { highlightLines } from "./syntax.js";

export const CUT = "… (line truncated)";

// `--numstat -z` outputs -> { path: { add, del, binary } }, summed across them (staged plus unstaged).
export function parseNumstat(texts) {
  const stats = {};
  for (const text of texts) {
    for (const entry of text.split("\0")) {
      const [a, d, ...parts] = entry.split("\t");
      if (!parts.length) continue;
      const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
      stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
    }
  }
  return stats;
}

// `--name-status -z --no-renames` -> files { path, status: A | D | U | M, fresh: false }.
export function parseNameStatus(text) {
  const parts = text.split("\0"), files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ path: parts[i + 1], status: "ADU".includes(parts[i][0]) ? parts[i][0] : "M", fresh: false });
  return files;
}

// Numbers each diff line once, so a frame only draws the rows on screen. `raw` keeps the line's own text; `text` is
// what is drawn (an empty line draws as one space); `key` names the row to the diff's virtual list.
export function diffRows(lines) {
  let old = 0, next = 0, before = null;
  return lines.map((line, i) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line), kind = match ? "@" : line[0], raw = line.slice(1), last = before, key = `r${i}`;
    before = kind;
    if (match) { old = +match[1]; next = +match[2]; return { kind, text: line, key }; }
    if (kind === "-") return { kind, old: old++, raw, text: raw || " ", key };
    if (kind === "+") return { kind, new: next++, raw, text: raw || " ", key };
    if (kind === " ") return { kind, old: old++, new: next++, raw, text: raw || " ", key };
    // A "\ No newline at end of file" marker belongs to the change it follows: same side, same tint.
    return line.startsWith("\\") && (last === "+" || last === "-") ? { kind: "", text: line, tint: last, key } : { kind: "", text: line, key };
  });
}

// Pairs each run of removed lines with the added lines after it: old on the left, new on the right.
export function splitRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind !== "-" && row.kind !== "+") {
      out.push(row.kind === " " ? { left: row, right: row, key: row.key } : row);
      i++; continue;
    }
    const take = (kind, list) => { while (rows[i]?.kind === kind || rows[i]?.tint === kind) list.push(rows[i++]); };
    const del = [], add = [];
    take("-", del); take("+", add);
    for (let j = 0; j < Math.max(del.length, add.length); j++) out.push({ left: del[j], right: add[j], key: (del[j] ?? add[j]).key });
  }
  return out;
}

// A whole-file diff (`--unified=<more lines than the file>`) -> both sides' lines, each null unless it is complete:
// one hunk from line 1 whose line count matches its header (git may still split a huge file, or output may be cut).
export function wholeSides(text) {
  const lines = text.split("\n"), at = lines.findIndex((l) => l.startsWith("@@"));
  const header = at >= 0 && /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[at]);
  if (!header || lines.slice(at + 1).some((l) => l.startsWith("@@"))) return { old: null, new: null };
  const old = [], next = [];
  for (const line of lines.slice(at + 1)) {
    if (line[0] === " ") { old.push(line.slice(1)); next.push(line.slice(1)); }
    else if (line[0] === "-") old.push(line.slice(1));
    else if (line[0] === "+") next.push(line.slice(1));
  }
  const whole = (start, count = "1", list) => (+start === 1 || +count === 0) && list.length === +count ? list : null;
  return { old: whole(header[1], header[2], old), new: whole(header[3], header[4], next) };
}

// Runs for each side's whole lines, once per load: { old, new }, each { lines, runs } or null. Both sides are lexed in
// one script task, so they share one deadline.
export function colourSides(sides, lang) {
  const deadline = Date.now() + 250, side = (lines) => lines && { lines, runs: highlightLines(lang, lines, undefined, deadline) };
  return { old: side(sides.old), new: side(sides.new) };
}

function clip(runs, length) {
  const out = [];
  for (const [text, category] of runs) {
    if (length <= 0) break;
    out.push([text.slice(0, length), category]); length -= text.length;
  }
  return out;
}

// A shown line's runs: its side's line must be the same text, or begin with it where the display cut the line.
function runsFor(raw, side, number) {
  const line = side?.lines[number - 1], runs = side?.runs[number - 1];
  if (line === undefined || !runs) return null;
  if (raw === line) return runs;
  const shown = raw.endsWith(CUT) ? raw.slice(0, -CUT.length) : null;
  return shown !== null && line.startsWith(shown) ? [...clip(runs, shown.length), [CUT, null]] : null;
}

// Gives each row the runs of its line on each side it shows: `-` old, `+` new, context both (its text is the same,
// but a change above it can leave the two sides in different states, an open comment say).
export function paint(rows, coloured) {
  for (const row of rows) {
    if (row.old !== undefined) row.oldRuns = runsFor(row.raw, coloured.old, row.old);
    if (row.new !== undefined) row.newRuns = runsFor(row.raw, coloured.new, row.new);
  }
  return rows;
}

// Unchanged lines a click reveals at a gap's edge.
export const STEP = 20;

export const cutLine = (line) => (line.length > 4000 ? line.slice(0, 4000) + CUT : line);

// The last line a compact diff's hunks reach on either side: a floor for the file's length.
export function hunkEnd(lines) {
  let end = 0;
  for (const line of lines) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) end = Math.max(end, +h[1] + +(h[2] ?? 1) - 1, +h[3] + +(h[4] ?? 1) - 1);
  }
  return end;
}

// A whole-file diff's rows for diffView, its @@ row left out; null unless the diff is whole, neither side is longer
// than `maxLines` (their rows take QuickJS a good part of the 500 ms a task may run; the header's counts say so before
// anything is split) and the view before any reveal fits `maxRows`: a longer one keeps the plain diff, cut, so hidden
// changes never pass for unchanged lines.
export function fullRows(text, maxLines = 20000, maxRows = 1500) {
  const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/m.exec(text.slice(0, 4096));
  if (!h || Math.max(+(h[1] ?? 1), +(h[2] ?? 1)) > maxLines) return null;
  const sides = wholeSides(text);
  if (!sides.old || !sides.new) return null;
  const lines = text.replace(/\n$/, "").split("\n");
  const rows = diffRows(lines.slice(lines.findIndex((l) => l.startsWith("@@"))).map(cutLine)).slice(1);
  return diffView(rows, new Map()).rows.length <= maxRows ? rows : null;
}

// The visible rows of a whole-file diff's numbered rows (`full`, its @@ row left out): each change with `context`
// unchanged lines around it, and every gap between those windows opened by `reveal` (gap id -> { top, bottom }: lines
// shown from its start and from its end). Each window starts with its own @@ header, counted from its rows. The header
// below hidden lines reveals them upwards and a row after the window above them downwards: both carry `gap`, `dir`
// and `step` for revealFor. A gap's id is its first and last line's numbers, so a refresh that moves it drops its
// reveal. Rows a "\ No newline" marker follows keep it; markers count as no line. gaps: id -> hidden line count.
// `tag` prefixes the controls' keys, so a click queued on one file's view never reveals lines in the next one's.
export function diffView(full, reveal, tag = "", context = 3) {
  const n = full.length, change = (r) => r.kind === "-" || r.kind === "+", line = (r) => r.kind === " ";
  const near = new Array(n).fill(false);
  for (const step of [1, -1]) {
    let since = Infinity;
    for (let i = step > 0 ? 0 : n - 1; i >= 0 && i < n; i += step) {
      if (change(full[i])) since = 0; else if (line(full[i])) { since++; if (since <= context) near[i] = true; }
    }
  }
  // gapAt[i]: the id of the gap whose hidden lines include row i (a marker goes with the row before it).
  const gapAt = new Array(n).fill(null), gaps = new Map();
  for (let i = 0; i < n;) {
    if (!line(full[i]) || near[i]) { i++; continue; }
    const at = [];
    for (; i < n && (line(full[i]) ? !near[i] : !change(full[i])); i++) if (line(full[i])) at.push(i);
    const first = full[at[0]], last = full[at.at(-1)], id = `${first.old}:${first.new}-${last.old}:${last.new}`;
    const { top = 0, bottom = 0 } = reveal.get(id) ?? {}, shut = at.slice(top, Math.max(top, at.length - bottom));
    if (!shut.length) continue;
    gaps.set(id, shut.length);
    for (let j = shut[0]; j <= shut.at(-1); j++) gapAt[j] = id;
    for (let j = shut.at(-1) + 1; j < n && !line(full[j]) && !change(full[j]); j++) gapAt[j] = id;
  }
  const rows = [];
  let lastOld = 0, lastNew = 0;
  const pass = (r) => { if (r.old !== undefined) lastOld = r.old; if (r.new !== undefined) lastNew = r.new; };
  for (let i = 0; i < n;) {
    if (gapAt[i]) { pass(full[i++]); continue; }
    let end = i, olds = 0, news = 0, firstOld, firstNew;
    for (; end < n && !gapAt[end]; end++) {
      const r = full[end];
      if (r.old !== undefined) { olds++; firstOld ??= r.old; }
      if (r.new !== undefined) { news++; firstNew ??= r.new; }
    }
    const range = `@@ -${firstOld ?? lastOld},${olds} +${firstNew ?? lastNew},${news} @@`;
    const up = i > 0 && gapAt[i - 1], down = end < n && gapAt[end];
    if (up) {
      const step = Math.min(STEP, gaps.get(up));
      rows.push({ kind: "@", text: `${range}  ↑ Show ${step} preceding lines`, key: `${tag}up:${up}`, gap: up, dir: "up", step });
    } else rows.push({ kind: "@", text: range, key: `h${i}` });
    for (let j = i; j < end; j++) { rows.push(full[j]); pass(full[j]); }
    if (down) {
      const step = Math.min(STEP, gaps.get(down));
      rows.push({ kind: "more", text: `↓ Show ${step} following lines`, key: `${tag}down:${down}`, gap: down, dir: "down", step });
    }
    i = end;
  }
  return { rows, gaps };
}

// The reveal a click on a header or "more" row asks for its gap; null for any other row.
export function revealFor(row, reveal) {
  if (!row?.dir) return null;
  const { top = 0, bottom = 0 } = reveal.get(row.gap) ?? {};
  return row.dir === "down" ? { top: top + row.step, bottom } : { top, bottom: bottom + row.step };
}
