// Modified from Herdr's shipped `changes` mod (Apache-2.0): side-by-side view, open in a pane, branch scope.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { diffRows, splitRows, wholeSides, colourSides, paint, CUT } from "./diff.js";
import { languageOf, COLORS } from "./syntax.js";
import { fileTree, treeRows } from "./tree.js";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, run, layout, shared, setShared, props } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const countLines = (text) => text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;

// The repo's default branch: what a PR from this checkout targets unless told otherwise.
async function findBase(git) {
  const head = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["origin/main", "origin/master"]) {
    if ((await git(["rev-parse", "--verify", "-q", `refs/remotes/${ref}`])).code === 0) return ref;
  }
  throw new Error("No base branch: origin/HEAD, origin/main and origin/master are all missing");
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function panelShown(panel) {
  const root = layout();
  return find(root, "panel")?.hidden !== true && find(root, "panel-body")?.active === panel;
}

const here = () => `${focused()?.space}|${focused()?.tab ?? null}`;

// The tab bar's find key (`panel.find`): a request for this panel, made for the space and tab shown now.
function findRequest(panel) {
  const r = shared("panel.find");
  return r?.panel === panel && Date.now() - r.at < 2000 && `${r.space}|${r.tab}` === here() && panelShown(panel) ? r : null;
}

// Every whitespace-separated term in the path, case-insensitive; the last term inside the file name ranks first,
// then shorter paths.
function findPaths(list, query, path = (x) => x) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean), last = terms.at(-1);
  if (!terms.length) return list;
  return list.map((x) => [path(x).toLowerCase(), x]).filter(([p]) => terms.every((t) => p.includes(t)))
    .map(([p, x], i) => [p.slice(p.lastIndexOf("/") + 1).includes(last) ? 0 : 1, p.length, i, x])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]).map((r) => r[3]);
}

// This panel's text size (my-tabs' A−/A+ while it shows, px at zoom 1): text, the heights around it and text columns scale
// from 13; icons, indents and truncation limits stay.
let scale = 1;
const z = (px) => px * scale;
const panelScale = () => (Number(shared("panel.text_size.changes")) || 13) / 13;

// Code text uses the terminal's font, at the block's `code_font_size` prop, else the terminal's size (px at zoom 1),
// times the panel scale; row heights and character widths follow it, with ratios for a JetBrains Mono-like font.
function codeMetrics() {
  const s = settings(), size = (Number(props()?.code_font_size) || Number(s.font_size) || 14) * scale;
  return { family: s.font_family ?? "JetBrains Mono", size, row: Math.round(size * 1.6), char: size * 0.62, numbers: Math.ceil(size * 0.62 * 4) };
}

// A splitter's share lands on the nearest eighth when its drag ends, like the side panel's.
const eighth = (share) => Math.min(7, Math.max(1, Math.round(share * 8))) / 8;

// Changed-line [background, line number] colours: opaque and saturated, as Claude Code's diff draws them; the set
// follows the drawn theme's background, whatever the appearance setting says.
const CHANGED = { dark: { "-": ["#3d0100", "#dc5a5a"], "+": ["#022800", "#50c850"] }, light: { "-": ["#ffd7d5", "#b42318"], "+": ["#d3f5d1", "#1a7f37"] } };
const darkColour = (hex) => { const n = parseInt(hex.slice(1, 7), 16); return (n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114 < 128000; };

export default class Changes extends View {
  init(given, cx) {
    // As a pane (opened from the panel) it stays on the repo it was opened for instead of following focus.
    this.pinned = given?.root ? { cwd: given.root, on: given.on ?? null } : null;
    const mode = this.pinned ? "pane" : "panel";
    this.splitKey = `split:${mode}`; this.scopeKey = `scope:${mode}`;
    this.split = localStorage.getItem(this.splitKey) !== "false";
    this.scope = given?.scope ?? localStorage.getItem(this.scopeKey) ?? "work";
    this.listKey = `list:${mode}`; this.listShare = Number(localStorage.getItem(this.listKey)) || null;
    this.place = this.placeKey(); this.context = this.key(); this.open = given?.open ?? null;
    this.files = []; this.rows = []; this.pairs = []; this.diffChars = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.collapsed = new Map();
    this.query = ""; this.findInput = InputState.new({ placeholder: "Find changed file" });
    this.findInput.on("change", (_e, cx) => { this.query = this.findInput.value().trim(); cx.notify(); });
    this.findInput.on("submit", (_e, cx) => { const first = this.shown()[0]; if (first && this.open !== first.path) this.pick(first.path, cx); });
    this.findInput.on("focus", (_e, cx) => { this.findFocused = this.findLanded = true; cx.notify(); });
    this.findInput.on("blur", (_e, cx) => { this.findFocused = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  where() { return this.pinned ?? location(); }
  placeKey() { return JSON.stringify(this.where()); }
  key() { return JSON.stringify({ ...this.where(), scope: this.scope }); }

  setScope(scope, cx) {
    // A commit or fetch reports into the scope it started in.
    if (scope === this.scope || this.busy || this.fetching) return;
    this.scope = scope;
    localStorage.setItem(this.scopeKey, scope);
    cx.notify();
  }

  fetchBase(cx) {
    if (!this.base || !this.root || this.fetching || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context, branch = this.base.slice("origin/".length);
    this.fetching = true; this.note = null; this.baseCache = null;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["fetch", "--quiet", "origin", branch], { cwd: root, on });
        if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
      } catch (e) { if (this.key() === context) this.note = `Fetch failed: ${e}`; }
      finally { this.fetching = false; this.again = true; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  toggleSplit(cx) {
    this.split = !this.split;
    localStorage.setItem(this.splitKey, String(this.split));
    cx.notify();
  }

  openPane() {
    if (!this.root || this.context !== this.key()) return;
    run("pane.split", { direction: "right", mod: "my-changes", props: { root: this.root, on: this.on, open: this.open, scope: this.scope, code_font_size: props()?.code_font_size } });
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          // A fetch refreshes once when it ends; its own .git writes would only refresh against stale refs.
          if (this.watched === root && !this.fetching) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    if (this.loading || this.busy) return;
    this.again = false;
    const { cwd, on } = this.where(), context = this.key();
    if (context !== this.context) {
      this.context = context; this.base = null; this.from = null; this.files = [];
      this.setLines([]); this.error = null; this.note = null; this.closed = false; this.limited = false;
      // A scope switch keeps the repo, its watch, the commit message and the selected file.
      const place = this.placeKey();
      if (place !== this.place) {
        this.place = place; this.root = null; this.open = null; this.baseCache = null;
        this.message = ""; this.input.set_value(""); this.watched = null;
      }
    }
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (this.key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.setLines([]); this.open = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        // Branch scope diffs the working tree against where the branch left the base, as a PR's "Files changed" does.
        let from = head.code === 0 ? "HEAD" : null, base = null;
        if (this.scope === "branch") {
          if (!from) throw new Error("No commits yet");
          base = this.baseCache ??= await findBase(git);
          const mb = await git(["merge-base", base, "HEAD"]);
          if (mb.code !== 0) throw new Error(`No common history with ${base}`);
          from = mb.stdout.trim();
        }
        const stats = {};
        const results = from ? [await git(["diff", from, "--numstat", "-z", "--no-renames"])] : [await git(["diff", "--cached", "--numstat", "-z", "--no-renames"]), await git(["diff", "--numstat", "-z", "--no-renames"])];
        for (const result of results) {
          if (result.code !== 0) throw new Error(result.stderr);
          for (const entry of result.stdout.split("\0")) {
            const [a, d, ...parts] = entry.split("\t");
            if (!parts.length) continue;
            const path = parts.join("\t"), old = stats[path] ?? { add: 0, del: 0 };
            stats[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
          }
        }
        let changed = status.stdout.split("\0").filter(Boolean).map((entry) => {
          const xy = entry.slice(0, 2), path = entry.slice(3), fresh = xy === "??";
          const conflict = xy.includes("U") || xy === "AA" || xy === "DD";
          return { path, status: conflict ? "U" : xy.includes("D") ? "D" : fresh || xy.includes("A") ? "A" : "M", fresh };
        });
        if (base) {
          const names = await git(["diff", from, "--name-status", "-z", "--no-renames"]);
          if (names.code !== 0) throw new Error(names.stderr);
          const parts = names.stdout.split("\0"), tracked = [];
          for (let i = 0; i + 1 < parts.length; i += 2) tracked.push({ path: parts[i + 1], status: "ADU".includes(parts[i][0]) ? parts[i][0] : "M", fresh: false });
          // Status knows conflicts and untracked files; an untracked file recreated over a deleted one shows once, as new.
          const rows = new Map(tracked.map((f) => [f.path, f]));
          for (const f of changed) if (f.fresh || f.status === "U") rows.set(f.path, f);
          changed = [...rows.values()];
        }
        const files = changed.slice(0, 1000).map((f) => ({ ...f, ...((!f.fresh && stats[f.path]) || { add: 0, del: 0 }) }));
        if (this.key() !== context) return;
        this.root = root; this.on = on; this.from = from; this.base = base; this.files = files; this.limited = changed.length > 1000; this.error = null;
        this.watch(root, cx);
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.setLines([]); }
        // The first file's diff shows until you pick another.
        if (!this.open && !this.closed && files.length) this.open = files[0].path;
        if (this.open) {
          try { await this.load(this.open, context); }
          catch { if (this.key() === context) this.setLines(["Cannot preview this diff (too large or unreadable)"]); }
        }
      } catch (e) { if (this.key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        // A fetch that ended mid-refresh needs one more pass against its new refs.
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  async load(path, context) {
    // Only the newest load publishes: a refresh can start another load of the same file before this one ends.
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on, lang = languageOf(path), gen = this.loads = (this.loads ?? 0) + 1;
    if (!file) return;
    // source: what the lexer reads for both sides, a fresh file's text or the whole-file diff.
    let lines, source = null;
    if (file.fresh || (!this.from && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
        source = { kind: "fresh", text };
      }
    } else {
      const diff = [...READ, "diff", ...(this.from ? [this.from] : []), "--no-ext-diff", "--no-textconv", "--no-color"];
      // The same diff as one whole-file hunk gives each side's lexical state from line 1, so a hunk that starts inside
      // a comment or string colours right. Failing that, the diff draws uncoloured.
      const whole = lang ? exec("git", [...diff, "--unified=100000000", "--", path], { cwd: root, on }).catch(() => null) : null;
      const r = await exec("git", [...diff, "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
      const w = whole && first >= 0 && await whole;
      if (w?.code === 0) source = { kind: "diff", text: w.stdout };
    }
    if (this.key() === context && this.open === path && gen === this.loads) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + CUT : line), lang && source && this.colour(source, lang));
  }

  // Lexing is the slow part of a load, and a refresh mostly reloads the same file unchanged.
  colour({ kind, text }, lang) {
    const c = this.coloured;
    if (c?.lang === lang && c.kind === kind && c.text === text) return c.sides;
    const sides = kind === "fresh" ? { old: [], new: text.replace(/\n$/, "").split("\n") } : wholeSides(text);
    this.coloured = { lang, kind, text, sides: colourSides(sides, lang) };
    return this.coloured.sides;
  }

  setLines(lines, coloured) {
    this.rows = diffRows(lines);
    if (coloured) paint(this.rows, coloured);
    this.pairs = splitRows(this.rows);
    this.diffChars = lines.reduce((n, line) => Math.max(n, line.length), 0);
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    // Picked from find results: its folders open, so it shows in the tree once find closes.
    const collapsed = this.collapsedHere();
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) collapsed.delete(path.slice(0, at));
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
  }

  // Folders closed in this place and scope; all open at first.
  collapsedHere() {
    if (!this.collapsed.has(this.context)) this.collapsed.set(this.context, new Set());
    return this.collapsed.get(this.context);
  }

  toggleFolder(path, cx) {
    const collapsed = this.collapsedHere();
    if (!collapsed.delete(path)) collapsed.add(path);
    cx.notify();
  }

  // The list's rows: the folder tree, or while finding, the ranked matches with their folders.
  listRows() {
    if (this.query) return this.shown().map((file) => ({ file, depth: 0 }));
    if (this.treeOf !== this.files) { this.treeOf = this.files; this.tree = fileTree(this.files); }
    return treeRows(this.tree, this.collapsedHere());
  }

  treeRow(id, depth, t) {
    return h_flex().id(id).h(z(28)).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover));
  }

  fileRow(f, depth, t) {
    const parts = f.path.split("/"), name = parts.pop(), folder = this.query && parts.length ? parts.join("/") + "/" : "";
    return this.treeRow(`change-file-${f.path}`, depth, t).when(this.open === f.path, (e) => e.bg(t.selected)).on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().w(12).flex_none())
      .child(svg("mods/my-changes/file.svg").size(14).flex_none().text_color(t.muted))
      .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(folder)).child(div().max_w(260).min_w(0).truncate().child(name)))
      .when(f.add > 0, (e) => e.child(div().text_size(z(11)).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(z(11)).text_color(t.ansi1).child(`−${f.del}`)))
      .child(div().w(z(10)).flex_none().text_size(z(11)).text_color(f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked).child(f.status));
  }

  folderRow(row, t) {
    const open = !this.collapsedHere().has(row.dir);
    return this.treeRow(`change-dir-${row.dir}`, row.depth, t).on_click((_e, cx) => this.toggleFolder(row.dir, cx))
      .child(svg(`mods/my-changes/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim))
      .child(svg("mods/my-changes/folder.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(row.name));
  }

  shown() {
    if (this.found?.files !== this.files || this.found.query !== this.query) this.found = { files: this.files, query: this.query, list: findPaths(this.files, this.query, (f) => f.path) };
    return this.found.list;
  }

  // Focused again a moment later unless it landed, as Herdr's own dialogs do: a row mounted by this render may not
  // take it at once.
  openFind(cx) {
    this.finding = true; this.findLanded = false; this.findPlace = this.placeKey(); this.findInput.focus();
    const at = here();
    cx.timer.after(600, () => { if (this.finding && !this.findLanded && here() === at && panelShown("changes")) this.findInput.focus(); });
  }

  // Escape gives the keyboard back to the pane it came from.
  closeFind(back = false) {
    this.finding = false; this.query = ""; this.findInput.set_value("");
    const f = focused();
    if (back && (f?.pane || f?.terminal)) run("pane.focus", f.pane ? { pane: f.pane } : { terminal: f.terminal });
  }

  findRow(t, count) {
    return h_flex().id("find").flex_none().px(10).py(5).gap(6).items_center().border_b(1).border_color(t.border).text_size(z(11)).text_color(t.dim)
      .child(div().id("find-box").flex_1().min_w(0).h(z(24)).px(8).flex().items_center().rounded(6).border_1().border_color(this.findFocused ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.findInput).h_full().text_size(z(11)).text_color(t.foreground)))
      .child(div().flex_none().child(count))
      .child(this.headerButton("find-close", "mods/my-changes/x.svg", false, "Close find (Esc)", (cx) => { this.closeFind(); cx.notify(); }, t));
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (this.key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (this.key() === context) this.note = `Commit failed: ${e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  // An absent line (the empty side of a split row) is shaded.
  lineCell(line, number, t, runs) {
    const [band, numbers] = this.changed[line?.tint ?? line?.kind] ?? [line ? null : t.raised + "60", t.dim];
    return h_flex().gap(10).when(Boolean(band), (e) => e.bg(band))
      .child(div().w(this.mono.numbers).flex_none().text_right().text_color(numbers).child(number === undefined ? "" : String(number)))
      .child(runs ? h_flex().flex_1().min_w(0).overflow_hidden().children(runs.map(([text, category]) =>
        div().flex_none().whitespace_nowrap().when(Boolean(COLORS[category]), (e) => e.text_color(t[COLORS[category]])).child(text)))
        : div().flex_1().min_w(0).truncate().child(line?.text ?? ""));
  }

  diffRow(row, t) {
    if (row.kind === "@") return div().w_full().px(12).h(this.mono.row).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);
    const old = row.kind === "-";
    return this.lineCell(row, old ? row.old : row.new, t, old ? row.oldRuns : row.newRuns).w_full().h(this.mono.row).flex_none();
  }

  splitRow(pair, t) {
    if (!("left" in pair)) return this.diffRow(pair, t);
    return h_flex().w_full().h(this.mono.row).flex_none()
      .child(this.lineCell(pair.left, pair.left?.old, t, pair.left?.oldRuns).flex_1().min_w(0).h_full())
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.lineCell(pair.right, pair.right?.new, t, pair.right?.newRuns).flex_1().min_w(0).h_full());
  }

  startDrag(cx) {
    this.drag = true;
    cx.stop_propagation(); cx.notify();
  }

  // The drag cover spans the list and the diff, so the pointer's height in it is the list's share.
  dragTo(event, cx) {
    if (!this.drag || !event.bounds) return;
    this.listShare = Math.min(7 / 8, Math.max(1 / 8, event.local_position.y / event.bounds.height));
    cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = false;
    // A press with no move leaves a list that still fits its files as it is.
    if (this.listShare) { this.listShare = eighth(this.listShare); localStorage.setItem(this.listKey, String(this.listShare)); }
    cx.notify();
  }

  headerButton(id, icon, active, tip, onClick, t, spinning = false) {
    return div().id(id).size(24).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .bg(active ? t.selected : t.background).text_color(active ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .tooltip(tip).on_click((_e, cx) => onClick(cx)).child(spinning ? svg("mods/my-changes/spinner.svg").size(14).spin(900) : svg(icon).size(14));
  }

  scopeBar(t) {
    const chip = (scope, label) => div().id(`scope-${scope}`).h(z(22)).px(8).flex().items_center().rounded(6).cursor_pointer()
      .when(this.scope === scope, (e) => e.bg(t.selected).text_color(t.foreground)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setScope(scope, cx)).child(label);
    return h_flex().h(z(34)).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).text_size(z(11)).text_color(t.muted)
      .child(chip("work", "Uncommitted")).child(chip("branch", "Branch"))
      .child(div().flex_1())
      .when(this.scope === "branch" && Boolean(this.base), (e) => e
        .child(div().min_w(0).truncate().text_color(t.dim).child(`vs ${this.base}`))
        .child(this.headerButton("changes-fetch", "mods/my-changes/fetch.svg", false, this.fetching ? "Fetching…" : "Fetch origin", (cx) => this.fetchBase(cx), t, this.fetching)));
  }

  render(cx) {
    scale = panelScale();
    if (this.key() !== this.context) this.refresh(cx);
    // A row belongs to the place it opened for; a scope switch keeps it.
    if (this.finding && this.findPlace !== this.placeKey()) this.closeFind();
    const request = !this.pinned && findRequest("changes");
    if (request && request.id !== this.findId) {
      this.findId = request.id; this.openFind(cx);
      setShared("panel.find", null);
    }
    const shown = this.shown(), rows = this.listRows();
    this.mono = codeMetrics();
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    this.changed = CHANGED[darkColour(t.background) ? "dark" : "light"];
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const nothing = this.base ? `No changes vs ${this.base}` : "No uncommitted changes";
    const [items, draw] = this.split ? [this.pairs, (p, t) => this.splitRow(p, t)] : [this.rows, (r, t) => this.diffRow(r, t)];
    const list = v_virtual_list("changes-diff", items.length, this.mono.row, (i) => String(i), (range) => items.slice(range.start, range.end).map((item) => draw(item, t))).size_full();
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(z(13)).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.findFocused) { this.closeFind(true); cx.stop_propagation(); cx.notify(); return; }
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(z(42)).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(z(10)).text_color(t.muted).child(this.query ? `${shown.length} of ${this.files.length} files` : `${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(z(11)).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(z(11)).text_color(t.ansi1).child(`−${del}`))
        .child(this.headerButton("changes-split", "mods/my-changes/columns.svg", this.split, this.split ? "Unified view" : "Side-by-side view", (cx) => this.toggleSplit(cx), t))
        .when(!this.pinned, (e) => e.child(this.headerButton("changes-pane", "mods/my-changes/open-pane.svg", false, "Open in a pane", () => this.openPane(), t))))
      .child(this.scopeBar(t))
      .when(Boolean(this.finding), (e) => e.child(this.findRow(t, this.query ? `${shown.length} found` : "")))
      .child(v_flex().id("changes-body").flex_1().min_h(0).relative()
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .child(v_flex().id("changes-list").flex_none().h(this.listShare ? `${this.listShare * 100}%` : Math.min(z(200), Math.max(44, rows.length * z(28) + 12))).overflow_y_scrollbar().p(6)
        .children(rows.map((row) => row.file ? this.fileRow(row.file, row.depth, t) : this.folderRow(row, t)))
        .when(!shown.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : !this.root ? "No folder" : this.files.length ? "No matching changed files" : nothing)))))
      .child(div().id("changes-divider").h(5).w_full().flex_none().flex().flex_col().justify_center().cursor_row_resize().child(div().h(1).w_full().bg(t.border))
        .on_mouse_down("left", (_e, cx) => this.startDrag(cx)))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(z(11)).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(this.mono.family).text_size(this.mono.size)
        // In a horizontal scroller the list keeps its last measured width, leaving the side-by-side divider off centre.
        .child(this.split ? list : div().id("changes-diff-x").size_full().overflow_x_scrollbar().child(div().w_full().min_w(Math.max(300, this.diffChars * this.mono.char + this.mono.numbers + 30)).h_full().child(list)))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      // While dragging, a cover keeps the pointer's moves and release even over the diff.
      .when(Boolean(this.drag), (e) => e.child(div().id("changes-drag").absolute().inset_0().cursor_row_resize()
        .on_mouse_move((ev, cx) => this.dragTo(ev, cx)).on_mouse_up("left", (_ev, cx) => this.endDrag(cx)).on_hover((inside, cx) => { if (!inside) this.endDrag(cx); }))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(z(11)).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(z(32)).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(z(12)).text_color(t.foreground)))
        .child(div().id("commit").h(z(32)).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(z(12)).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
