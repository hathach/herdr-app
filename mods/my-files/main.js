// Modified from Herdr's shipped `files` mod (Apache-2.0): tree and preview together, tree on any side.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { languageOf, highlightLines, COLORS } from "./syntax.js";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, layout, shared, setShared, props } from "herdr";

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
// The editor colours C, C++ and Python natively (by these names) but draws Markdown and reST plain; those get coloured
// read-only lines instead.
const EDITOR = { c: "c", cpp: "cpp", python: "py" }, LINES = new Set(["markdown", "rst"]);
const PER_FOLDER = 500, TOTAL = 5000, FOUND = 200;
// A splitter's share lands on the nearest eighth when its drag ends, like the side panel's.
const eighth = (share) => Math.min(7, Math.max(1, Math.round(share * 8))) / 8;
// far: the tree sits at the end of the body, so its share counts back from that edge.
const SIDES = { left: { direction: "flex_row", axis: "across" }, top: { direction: "flex_col", axis: "down" },
  right: { direction: "flex_row_reverse", axis: "across", far: true }, bottom: { direction: "flex_col_reverse", axis: "down", far: true } };

// This panel's text size (my-tabs' A−/A+ while it shows, px at zoom 1): text, the heights around it and text columns scale
// from 13; icons, indents and truncation limits stay.
let scale = 1;
const z = (px) => px * scale;
const panelScale = () => (Number(shared("panel.text_size.files")) || 13) / 13;

// Code text uses the terminal's font, at the block's `code_font_size` prop, else the terminal's size (px at zoom 1),
// times the panel scale; row heights and character widths follow it, with ratios for a JetBrains Mono-like font.
function codeMetrics() {
  const s = settings(), size = (Number(props()?.code_font_size) || Number(s.font_size) || 14) * scale;
  return { family: s.font_family ?? "JetBrains Mono", size, row: Math.round(size * 1.6), char: size * 0.62, numbers: Math.ceil(size * 0.62 * 4) };
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

async function directory(path, on) {
  if (!on && window()?.platform === "windows") {
    const r = await exec("powershell", ["-NoProfile", "-Command", "& { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint)) } }) | ConvertTo-Json -Compress } '" + path.replaceAll("'", "''") + "'"]);
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ] && [ ! -L "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  const r = await exec("sh", ["-c", script, "files", path], { on });
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map(); this.side = localStorage.getItem("tree"); if (!Object.keys(SIDES).includes(this.side)) this.side = "left";
    this.share = { across: Number(localStorage.getItem("tree:across")) || 0.375, down: Number(localStorage.getItem("tree:down")) || 0.375 };
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.query = ""; this.findHandle = cx.focus_handle(); this.findInput = InputState.new({ placeholder: "Find file in repo" });
    this.findInput.on("change", (_e, cx) => { this.query = this.findInput.value().trim(); cx.notify(); });
    this.findInput.on("submit", (_e, cx) => { const first = this.found()?.list[0]; if (first) this.show(first.path, cx, first.base); });
    this.findInput.on("focus", (_e, cx) => { this.findFocused = this.findLanded = true; cx.notify(); });
    this.findInput.on("blur", (_e, cx) => { this.findFocused = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file, base: this.fileBase });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false; this.closeFind(); this.index = null;
      if (saved?.file) this.show(saved.file, cx, saved.base);
    }
    if (this.finding) this.loadIndex(cx);
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  // base: the folder `path` is relative to, the repo root for find results, else the tree's root.
  show(path, cx, base = this.root) {
    this.code?.release(); this.code = null; this.lines = null; this.file = path; this.fileBase = base; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, on = this.on;
    const current = () => this.file === path && this.fileBase === base && this.current(context);
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${base}/${path}`, { on });
        if (!current()) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt", lang = languageOf(path);
        const value = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if (LINES.has(lang)) {
          const lines = value.replace(/\n$/, "").split("\n");
          this.lines = { lines, runs: highlightLines(lang, lines), chars: lines.reduce((n, l) => Math.max(n, l.length), 0) };
          return;
        }
        const mono = codeMetrics();
        this.editorFont = { family: mono.family, size: mono.size };
        this.code = EditorState.new({ language: EDITOR[lang] ?? LANG[ext] ?? ext, readonly: true,
          value,
          font_family: mono.family, font_size: mono.size,
          syntax: Object.fromEntries(["keyword", "string", "comment", "function", "type", "number", "constant"].map(k => [k, t[COLORS[k]]])) });
      } catch { if (current()) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  // The repo's files, tracked and untracked but not ignored, from its root; outside a repo, find covers the tree's
  // loaded folders. One build at a time; a result for another place is dropped.
  loadIndex(cx) {
    const context = this.context, { cwd, on } = context;
    if (!cwd || this.indexing) return;
    this.indexing = true;
    cx.spawn(async cx => {
      let index;
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0 && /not a git repository/i.test(top.stderr)) index = { key: context.key, tree: true };
        else if (top.code !== 0) throw new Error(top.stderr.trim() || "git rev-parse failed");
        else if (this.current(context)) {
          const root = top.stdout.trim(), r = await exec("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, on });
          if (r.code !== 0) throw new Error(r.stderr.trim() || "git ls-files failed");
          // An unchanged listing keeps its index object, so the matches computed from it stay cached.
          const old = this.index;
          index = old?.key === context.key && old.root === root && old.listing === r.stdout ? old
            : { key: context.key, root, listing: r.stdout, paths: [...new Set(r.stdout.split("\0").filter(Boolean))] };
        }
      } catch (e) { index = { key: context.key, error: String(e) }; }
      this.indexing = false;
      if (!this.finding) return;
      // A build for a place left meanwhile gives way to one for the place shown now.
      if (this.current(context)) { if (index !== this.index) { this.index = index; cx.notify(); } }
      else this.loadIndex(cx);
    });
  }

  // Matches as { path, base }, ranked, before the display cap.
  found() {
    const index = this.index?.key === this.context?.key ? this.index : null;
    if (!this.query || !index || index.error) return null;
    if (index.tree) {
      const files = [...this.entries].flatMap(([prefix, list]) => list.filter(e => !e.dir).map(e => ({ path: prefix ? `${prefix}/${e.name}` : e.name, base: this.root })));
      return { list: findPaths(files, this.query, f => f.path) };
    }
    if (this.memo?.index !== index || this.memo.query !== this.query)
      this.memo = { index, query: this.query, list: findPaths(index.paths, this.query).map(path => ({ path, base: index.root })) };
    return this.memo;
  }

  // Focused again a moment later unless it landed, as Herdr's own dialogs do: a row mounted by this render may not
  // take it at once.
  openFind(cx) {
    this.finding = true; this.findLanded = false; this.findInput.focus(); this.loadIndex(cx);
    const at = here();
    cx.timer.after(600, () => { if (this.finding && !this.findLanded && here() === at && panelShown("files")) this.findInput.focus(); });
  }

  // Escape gives the keyboard back to the pane it came from.
  closeFind(back = false) {
    this.finding = false; this.query = ""; this.findInput?.set_value(""); this.memo = null;
    const f = focused();
    if (back && (f?.pane || f?.terminal)) run("pane.focus", f.pane ? { pane: f.pane } : { terminal: f.terminal });
  }

  findRow(t, found) {
    const index = this.index?.key === this.context?.key ? this.index : null;
    const note = index?.error ?? (!index ? "Indexing…" : !this.query ? (index.tree ? "Loaded folders only" : "Tracked and untracked, not ignored")
      : `${found.list.length} found${index.tree ? " in loaded folders" : ""}`);
    return v_flex().id("find").flex_none().px(10).py(5).gap(3).border_b(1).border_color(t.border).text_size(z(11)).text_color(index?.error ? t.ansi1 : t.dim)
      .track_focus(this.findHandle).on_key_down((e, cx) => { if (e.key === "escape") { this.closeFind(true); cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().gap(6).items_center()
        .child(div().id("find-box").flex_1().min_w(0).h(z(24)).px(8).flex().items_center().rounded(6).border_1().border_color(this.findFocused ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.findInput).h_full().text_size(z(11)).text_color(t.foreground)))
        .child(this.button("find-close", "mods/my-files/x.svg", "Close find (Esc)", cx => { this.closeFind(); cx.notify(); }, t)))
      .child(div().min_w(0).truncate().child(note));
  }

  results(t, found) {
    const list = found.list;
    return v_flex().id("files-found").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(list.slice(0, FOUND).map(({ path, base }) => {
      const parts = path.split("/"), name = parts.pop();
      return h_flex().id(`found-${base}/${path}`).h(z(28)).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.file === path && this.fileBase === base, el => el.bg(t.selected)).hover(s => s.bg(t.hover)).on_click((_e, cx) => this.show(path, cx, base))
        .child(svg("mods/my-files/file.svg").size(14).flex_none().text_color(t.muted))
        .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)));
    })).when(list.length > FOUND, el => el.child(div().p(8).text_size(z(11)).text_color(t.dim).child(`Showing the first ${FOUND} of ${list.length}: refine the search`)))
      .when(!list.length, el => el.child(div().p(8).text_size(z(12)).text_color(t.dim).child("No matching files")));
  }

  // Read-only like the editor, without its selection; the same font and line numbers.
  linesView(t) {
    const { lines, runs, chars } = this.lines, mono = codeMetrics(), gutter = Math.ceil(String(lines.length).length * mono.char) + 20;
    const row = (i) => h_flex().h(mono.row).flex_none().w_full()
      .child(div().w(gutter).flex_none().pr(12).text_right().text_color(t.dim).child(String(i + 1)))
      .child(runs[i] ? h_flex().flex_1().min_w(0).children(runs[i].map(([text, category]) =>
        div().flex_none().whitespace_nowrap().when(Boolean(COLORS[category]), e => e.text_color(t[COLORS[category]])).child(text)))
        : div().flex_1().min_w(0).whitespace_nowrap().child(lines[i]));
    const list = v_virtual_list("files-lines", lines.length, mono.row, i => String(i), range => Array.from({ length: range.end - range.start }, (_, k) => row(range.start + k))).size_full();
    return div().flex_1().min_w(0).min_h(0).relative().pt(4).font_family(mono.family).text_size(mono.size)
      .child(div().id("files-lines-x").size_full().overflow_x_scrollbar().child(div().w_full().min_w(Math.max(300, chars * mono.char + gutter + 30)).h_full().child(list)))
      .child(Scrollbar.vertical("files-lines").viewport_from_layout().absolute().inset_0());
  }

  moveTree(cx) {
    const sides = Object.keys(SIDES);
    this.side = sides[(sides.indexOf(this.side) + 1) % sides.length];
    localStorage.setItem("tree", this.side);
    cx.notify();
  }

  startDrag(cx) {
    this.drag = true;
    cx.stop_propagation(); cx.notify();
  }

  // The drag cover spans the body, so the pointer's place in it is the tree's share.
  dragTo(event, cx) {
    if (!this.drag || !event.bounds) return;
    const { axis, far } = SIDES[this.side], at = axis === "across" ? event.local_position.x / event.bounds.width : event.local_position.y / event.bounds.height;
    this.share[axis] = Math.min(7 / 8, Math.max(1 / 8, far ? 1 - at : at));
    cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    const { axis } = SIDES[this.side];
    this.share[axis] = eighth(this.share[axis]);
    localStorage.setItem(`tree:${axis}`, String(this.share[axis]));
    this.drag = false; cx.notify();
  }

  rows(prefix, depth, out, t) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      out.push(h_flex().id(`file-${path}`).h(z(28)).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().when(this.file === path && this.fileBase === this.root, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
        .on_click((_e, cx) => entry.dir ? this.toggle(path, cx) : this.show(path, cx))
        .child(entry.dir ? svg(`mods/my-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(svg(`mods/my-files/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(mark), el => el.child(div().text_size(z(11)).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t);
    }
    return out;
  }

  tree(t) {
    return v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6).children(this.rows("", 0, [], t))
      .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(z(12)).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
      .when(this.limited, el => el.child(div().p(8).text_size(z(11)).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")));
  }

  body(t, found) {
    const list = found ? this.results(t, found) : this.tree(t);
    if (!this.file) return list;
    const { direction, axis } = SIDES[this.side], share = `${this.share[axis] * 100}%`;
    const tree = axis === "across" ? v_flex().flex_none().min_h(0).h_full().w(share) : v_flex().flex_none().min_h(0).w_full().h(share);
    const handle = axis === "across" ? div().w(5).h_full().cursor_col_resize().child(div().w(1).h_full().bg(t.border)).flex().justify_center()
      : div().h(5).w_full().cursor_row_resize().child(div().h(1).w_full().bg(t.border)).flex().flex_col().justify_center();
    const preview = this.code ? Editor.new(this.code).flex_1().min_w(0).min_h(0) : this.lines ? this.linesView(t) : div().flex_1().p(12).text_color(t.dim).child(this.fileError || "Loading file…");
    return div().id("files-body").flex().flex_1().min_h(0).relative()[direction]()
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .child(tree.child(list))
      .child(handle.id("files-split").flex_none().on_mouse_down("left", (_e, cx) => this.startDrag(cx)))
      .child(preview)
      // While dragging, a cover keeps the pointer's moves and release even over the editor.
      .when(Boolean(this.drag), el => el.child(div().id("files-drag").absolute().inset_0()[axis === "across" ? "cursor_col_resize" : "cursor_row_resize"]()
        .on_mouse_move((e, cx) => this.dragTo(e, cx)).on_mouse_up("left", (_e, cx) => this.endDrag(cx)).on_hover((inside, cx) => { if (!inside) this.endDrag(cx); })));
  }

  button(id, icon, tip, onClick, t) {
    return div().id(id).size(24).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover(s => s.bg(t.hover))
      .tooltip(tip).on_click((_e, cx) => onClick(cx)).child(svg(icon).size(14));
  }

  render(cx) {
    scale = panelScale();
    if (key() !== this.context?.key) this.refresh(cx);
    // The editor takes its font when made: a terminal font change reopens the preview with the new one.
    const mono = codeMetrics();
    if (this.code && (this.editorFont.family !== mono.family || this.editorFont.size !== mono.size)) this.show(this.file, cx, this.fileBase);
    const request = findRequest("files");
    if (request && request.id !== this.findId) {
      this.findId = request.id; this.openFind(cx);
      setShared("panel.find", null);
    }
    const t = theme(), found = this.finding ? this.found() : null;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(z(13))
      .child(h_flex().h(z(42)).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(z(12)).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
        .when(Boolean(this.file), el => el
          .child(this.button("files-side", `mods/my-files/panel-${this.side}.svg`, `Tree on the ${this.side} · move it`, cx => this.moveTree(cx), t))
          .child(this.button("files-close", "mods/my-files/x.svg", "Close the preview", cx => { this.show(null); cx.notify(); }, t))))
      .when(Boolean(this.finding), el => el.child(this.findRow(t, found)))
      .child(this.body(t, found));
  }
}
