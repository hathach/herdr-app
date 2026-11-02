// Modified from Herdr's shipped `changes` mod (Apache-2.0): side-by-side view, open in a pane, branch scope.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, run } from "herdr";

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

// Numbers each diff line once, so a frame only draws the rows on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, old: old++, text: line.slice(1) || " " };
    if (kind === "+") return { kind, new: next++, text: line.slice(1) || " " };
    if (kind === " ") return { kind, old: old++, new: next++, text: line.slice(1) || " " };
    return { kind: "", text: line };
  });
}

// Pairs each run of removed lines with the added lines after it: old on the left, new on the right.
function splitRows(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.kind !== "-" && row.kind !== "+") {
      out.push(row.kind === " " ? { left: row, right: row } : row);
      i++; continue;
    }
    // A "\ No newline at end of file" marker stays with the line above it instead of ending the run.
    const take = (kind, list) => { while (rows[i]?.kind === kind || (list.length && rows[i]?.kind === "" && rows[i].text.startsWith("\\"))) list.push(rows[i++]); };
    const del = [], add = [];
    take("-", del); take("+", add);
    for (let j = 0; j < Math.max(del.length, add.length); j++) out.push({ left: del[j], right: add[j] });
  }
  return out;
}

// The repo's default branch: what a PR from this checkout targets unless told otherwise.
async function findBase(git) {
  const head = await git(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim();
  for (const ref of ["origin/main", "origin/master"]) {
    if ((await git(["rev-parse", "--verify", "-q", `refs/remotes/${ref}`])).code === 0) return ref;
  }
  throw new Error("No base branch: origin/HEAD, origin/main and origin/master are all missing");
}

// A splitter's share lands on the nearest eighth when its drag ends, like the side panel's.
const eighth = (share) => Math.min(7, Math.max(1, Math.round(share * 8))) / 8;

export default class Changes extends View {
  init(props, cx) {
    // As a pane (opened from the panel) it stays on the repo it was opened for instead of following focus.
    this.pinned = props?.root ? { cwd: props.root, on: props.on ?? null } : null;
    const mode = this.pinned ? "pane" : "panel";
    this.splitKey = `split:${mode}`; this.scopeKey = `scope:${mode}`;
    this.split = localStorage.getItem(this.splitKey) !== "false";
    this.scope = props?.scope ?? localStorage.getItem(this.scopeKey) ?? "work";
    this.listKey = `list:${mode}`; this.listShare = Number(localStorage.getItem(this.listKey)) || null;
    this.place = this.placeKey(); this.context = this.key(); this.open = props?.open ?? null;
    this.files = []; this.rows = []; this.pairs = []; this.diffWidth = 0; this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const hadMessage = Boolean(this.message.trim());
      this.message = this.input.value();
      if (hadMessage !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
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
    run("pane.split", { direction: "right", mod: "my-changes", props: { root: this.root, on: this.on, open: this.open, scope: this.scope } });
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
    const file = this.files.find((f) => f.path === path), root = this.root, on = this.on;
    if (!file) return;
    let lines;
    if (file.fresh || (!this.from && file.status === "A")) {
      const text = await readTextFile(`${root}/${path}`, { on }).catch(() => null);
      if (text === null) lines = ["Cannot preview this file (binary, too large, or unreadable)"];
      else if (text.includes("\0")) lines = ["Binary file · no text diff"];
      else {
        file.add = countLines(text);
        lines = [`@@ -0,0 +1,${file.add} @@`, ...text.slice(0, 400000).replace(/\n$/, "").split("\n").slice(0, 1500).map(l => `+${l}`)];
      }
    } else {
      const r = await exec("git", [...READ, "diff", ...(this.from ? [this.from] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", path], { cwd: root, on });
      if (r.code !== 0) throw new Error(r.stderr);
      const all = r.stdout.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
      lines = first < 0 ? [file.binary ? "Binary file changed" : "No text diff available"] : all.slice(first);
    }
    if (this.key() === context && this.open === path) this.setLines(lines.slice(0, 1500).map(line => line.length > 4000 ? line.slice(0, 4000) + "… (line truncated)" : line));
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.pairs = splitRows(this.rows);
    this.diffWidth = Math.max(300, ...lines.map(line => line.length * 7 + 50));
  }

  pick(path, cx) {
    this.open = this.open === path ? null : path; this.setLines([]); this.note = null;
    this.closed = !this.open;
    const context = this.context;
    if (this.open) cx.spawn(async (cx) => {
      try { await this.load(path, context); }
      catch (e) { if (this.key() === context && this.open === path) this.note = `Cannot preview this diff (too large or unreadable): ${e}`; }
      cx.notify();
    });
    cx.notify();
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
  lineCell(line, number, t) {
    const tint = line?.kind === "+" ? t.ansi2 + "18" : line?.kind === "-" ? t.ansi1 + "18" : line ? null : t.raised + "60";
    return h_flex().gap(10).when(Boolean(tint), (e) => e.bg(tint))
      .child(div().w(30).flex_none().text_right().text_color(t.dim).child(number === undefined ? "" : String(number)))
      .child(div().flex_1().min_w(0).truncate().child(line?.text ?? ""));
  }

  diffRow(row, t) {
    if (row.kind === "@") return div().w_full().px(12).h(20).flex_none().truncate().bg(t.raised).text_color(t.dim).child(row.text);
    return this.lineCell(row, row.kind === "-" ? row.old : row.new, t).w_full().h(20).flex_none();
  }

  splitRow(pair, t) {
    if (!("left" in pair)) return this.diffRow(pair, t);
    return h_flex().w_full().h(20).flex_none()
      .child(this.lineCell(pair.left, pair.left?.old, t).flex_1().min_w(0).h_full())
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.lineCell(pair.right, pair.right?.new, t).flex_1().min_w(0).h_full());
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
    const chip = (scope, label) => div().id(`scope-${scope}`).h(22).px(8).flex().items_center().rounded(6).cursor_pointer()
      .when(this.scope === scope, (e) => e.bg(t.selected).text_color(t.foreground)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setScope(scope, cx)).child(label);
    return h_flex().h(34).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
      .child(chip("work", "Uncommitted")).child(chip("branch", "Branch"))
      .child(div().flex_1())
      .when(this.scope === "branch" && Boolean(this.base), (e) => e
        .child(div().min_w(0).truncate().text_color(t.dim).child(`vs ${this.base}`))
        .child(this.headerButton("changes-fetch", "mods/my-changes/fetch.svg", false, this.fetching ? "Fetching…" : "Fetch origin", (cx) => this.fetchBase(cx), t, this.fetching)));
  }

  render(cx) {
    if (this.key() !== this.context) this.refresh(cx);
    const t = theme(), add = this.files.reduce((n, f) => n + f.add, 0), del = this.files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const nothing = this.base ? `No changes vs ${this.base}` : "No uncommitted changes";
    const [items, draw] = this.split ? [this.pairs, (p, t) => this.splitRow(p, t)] : [this.rows, (r, t) => this.diffRow(r, t)];
    const list = v_virtual_list("changes-diff", items.length, 20, (i) => String(i), (range) => items.slice(range.start, range.end).map((item) => draw(item, t))).size_full();
    return v_flex().id("changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${this.files.length} files`))
        .child(div().flex_1()).child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(this.headerButton("changes-split", "mods/my-changes/columns.svg", this.split, this.split ? "Unified view" : "Side-by-side view", (cx) => this.toggleSplit(cx), t))
        .when(!this.pinned, (e) => e.child(this.headerButton("changes-pane", "mods/my-changes/open-pane.svg", false, "Open in a pane", () => this.openPane(), t))))
      .child(this.scopeBar(t))
      .child(v_flex().id("changes-body").flex_1().min_h(0).relative()
      .on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .child(v_flex().id("changes-list").flex_none().h(this.listShare ? `${this.listShare * 100}%` : Math.min(200, Math.max(44, this.files.length * 28 + 12))).overflow_y_scrollbar().p(6).children(this.files.map((f) => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().id(`change-${f.path}`).h(28).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().when(this.open === f.path, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.pick(f.path, cx))
          .child(div().w(14).text_size(11).text_color(f.status === "A" ? t.ansi2 : f.status === "D" ? t.ansi1 : f.status === "U" ? t.ansi1 : t.blocked).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().max_w(260).min_w(0).truncate().child(name)))
          .when(f.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${f.add}`))).when(f.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${f.del}`)));
      })).when(!this.files.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? nothing : "No folder")))))
      .child(div().id("changes-divider").h(5).w_full().flex_none().flex().flex_col().justify_center().cursor_row_resize().child(div().h(1).w_full().bg(t.border))
        .on_mouse_down("left", (_e, cx) => this.startDrag(cx)))
      .when(this.limited, el => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(11)
        // In a horizontal scroller the list keeps its last measured width, leaving the side-by-side divider off centre.
        .child(this.split ? list : div().id("changes-diff-x").size_full().overflow_x_scrollbar().child(div().w_full().min_w(this.diffWidth).h_full().child(list)))
        .child(Scrollbar.vertical("changes-diff").viewport_from_layout().absolute().inset_0())
        .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(6).px(12).text_color(t.dim).child("Select a file to view its changes"))))
      // While dragging, a cover keeps the pointer's moves and release even over the diff.
      .when(Boolean(this.drag), (e) => e.child(div().id("changes-drag").absolute().inset_0().cursor_row_resize()
        .on_mouse_move((ev, cx) => this.dragTo(ev, cx)).on_mouse_up("left", (_ev, cx) => this.endDrag(cx)).on_hover((inside, cx) => { if (!inside) this.endDrag(cx); }))))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(8).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(h_flex().flex_none().p(10).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(32).px(14).flex().items_center().rounded(8).bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit")));
  }
}
