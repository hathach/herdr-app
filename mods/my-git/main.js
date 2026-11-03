// The Git panel's upper block, read-only: the focused repo's branches and one branch's commits. The picked commit goes
// to the my-changes block below it (props.source "git") through shared `git.selection`.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, focused, exec, theme, layout, shared, setShared } from "herdr";
import { READ, loadRefs, loadPage, ago } from "./git.js";

const SELECTION = "git.selection", POLL = 10000;

// This panel's text size (my-tabs' A−/A+ while it shows, px at zoom 1): text, the heights around it and text columns scale
// from 13; icons and indents stay.
let scale = 1;
const z = (px) => px * scale;
const panelScale = () => (Number(shared("panel.text_size.git")) || 13) / 13;

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Hidden copies keep their timers, so they check this first.
function visible() {
  const root = layout();
  return find(root, "panel")?.hidden !== true && find(root, "panel-body")?.active === "git";
}

const branchName = (ref) => ref.replace(/^refs\/(heads|remotes)\//, "");

export default class Git extends View {
  init(_props, cx) {
    // A selection kept in saved shared state belongs to an earlier start.
    setShared(SELECTION, null);
    // listGen: the repo and branch shown; a read applies only while it stands. picks numbers each publication.
    this.listGen = 0; this.picks = 0;
    this.choices = JSON.parse(localStorage.getItem("branches") ?? "{}");
    this.repo = null; this.place = null; this.requested = null; this.clear();
    this.branchQuery = ""; this.branchInput = InputState.new({ placeholder: "Find branch" });
    this.branchInput.on("change", (_e, cx) => { this.branchQuery = this.branchInput.value().trim(); cx.notify(); });
    this.branchInput.on("submit", (_e, cx) => { const first = this.branchRows().find((r) => !r.group); if (first) this.choose(first.key, cx); });
    cx.timer.every(POLL, (cx) => { if (visible()) this.refresh(cx); });
  }

  clear() {
    this.dropHistory(); this.refs = null; this.branch = null; this.error = null; this.note = null; this.picking = false;
  }

  dropHistory() {
    this.tip = null; this.commits = []; this.more = false; this.pages = 0; this.moved = null; this.selected = null;
  }

  git(repo) { return (args) => exec("git", [...READ, ...args], { cwd: repo.root, on: repo.on }); }

  // Every setShared re-renders every mod: clearing what is already clear is skipped.
  publish(selection) { if (selection || shared(SELECTION)) setShared(SELECTION, selection); }

  // A new repo or branch: nothing shown is current, and reads still running for the old one must not apply.
  restart() { this.listGen++; this.publish(null); }
  reset() { this.restart(); this.clear(); }

  refresh(cx) {
    const where = location(), place = JSON.stringify(where);
    // Reads started for the place focus left can't publish, even while this one waits behind them.
    if (place !== this.requested) { this.requested = place; this.listGen++; }
    if (this.loading) { this.again = true; return; }
    if (!where.cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      let gen = this.listGen, resolving = false;
      try {
        if (place !== this.place) {
          resolving = true;
          const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: where.cwd, on: where.on });
          if (gen !== this.listGen) return;
          this.place = place;
          const root = top.code === 0 ? top.stdout.trim() : null;
          if (root !== this.repo?.root || where.on !== this.repo?.on) {
            this.reset(); gen = this.listGen;
            this.repo = root ? { on: where.on, root, key: `${where.on ?? ""}|${root}` } : null;
            if (!root) this.error = "Not a git repository";
          }
          resolving = false;
        }
        if (this.repo) await this.sync(gen, cx);
      } catch (e) {
        // An unreachable machine or a failed read: the next poll resolves the folder again.
        if (gen === this.listGen) {
          if (resolving) { this.reset(); this.repo = null; }
          this.error = e.message ?? String(e); this.place = null;
        }
      } finally {
        this.loading = false;
        if (this.again) this.refresh(cx);
        cx.notify();
      }
    });
  }

  async sync(gen, cx) {
    const repo = this.repo, git = this.git(repo), refs = await loadRefs(git);
    if (gen !== this.listGen) return;
    this.refs = refs; this.error = null;
    let choice = this.choices[repo.key] ?? "current", branch = null;
    if (choice !== "current") {
      branch = [...refs.local, ...refs.remote].find((b) => b.ref === choice);
      if (!branch) {
        this.note = `${branchName(choice)} is gone: showing the current checkout`;
        delete this.choices[repo.key]; localStorage.setItem("branches", JSON.stringify(this.choices));
        choice = "current";
      }
    }
    if (choice !== this.branch) {
      const note = this.note;
      this.reset(); gen = this.listGen;
      this.refs = refs; this.branch = choice; this.note = note;
    }
    const tip = branch ? branch.id : refs.head;
    // An unborn checkout (an orphan branch, say) has no history to keep showing.
    if (!tip) { if (this.tip) { this.restart(); this.dropHistory(); } return; }
    if (tip !== this.tip && tip !== this.moved) {
      // A page beyond the first was asked for: keep that history still and offer the new one.
      if (this.tip && this.pages > 1) { this.moved = tip; return; }
      const before = this.tip, page = await loadPage(git, tip);
      if (gen !== this.listGen) return;
      // Load more landed meanwhile: that history stays.
      if (this.tip !== before || this.pages > 1) { if (this.tip) this.moved = tip; return; }
      this.tip = tip; this.moved = null; this.commits = page.commits; this.more = page.more; this.pages = 1;
      // A branch opens on its newest commit; a refresh of the same branch keeps whatever is picked.
      if (!before && this.commits.length) this.select(this.commits[0], cx);
    }
  }

  reload(cx) {
    this.pages = 1; this.moved = null;
    this.refresh(cx);
    cx.notify();
  }

  loadMore(cx) {
    if (this.paging || !this.more || !this.repo) return;
    const gen = this.listGen, tip = this.tip, skip = this.commits.length, git = this.git(this.repo);
    this.paging = true;
    cx.spawn(async (cx) => {
      try {
        const page = await loadPage(git, tip, skip);
        if (gen === this.listGen && tip === this.tip && skip === this.commits.length) {
          this.commits = [...this.commits, ...page.commits]; this.more = page.more; this.pages++;
        }
      } catch (e) { if (gen === this.listGen) this.note = `Load more failed: ${e.message ?? e}`; }
      finally { this.paging = false; cx.notify(); }
    });
    cx.notify();
  }

  // The block below reads the commit itself; picking it again (a new gen) reads it again, after a fetch say.
  select(commit, cx) {
    const repo = this.repo;
    if (!repo) return;
    this.selected = commit;
    this.publish({ gen: ++this.picks, on: repo.on, root: repo.root, sha: commit.id, parents: commit.parents,
      subject: commit.subject, author: commit.author, date: commit.date });
    cx.notify();
  }

  choose(key, cx) {
    const repo = this.repo;
    if (!repo) return;
    if (key === "current") delete this.choices[repo.key]; else this.choices[repo.key] = key;
    localStorage.setItem("branches", JSON.stringify(this.choices));
    const refs = this.refs;
    this.reset(); this.refs = refs; this.branch = key;
    this.branchQuery = ""; this.branchInput.set_value("");
    this.refresh(cx);
    cx.notify();
  }

  togglePicker(cx) {
    this.picking = !this.picking && Boolean(this.refs);
    if (this.picking) this.branchInput.focus();
    cx.notify();
  }

  // The picker's rows: the current checkout, then local and remote-tracking branches under a heading each.
  branchRows() {
    const refs = this.refs;
    if (!refs) return [];
    const terms = this.branchQuery.toLowerCase().split(/\s+/).filter(Boolean), match = (name) => terms.every((t) => name.toLowerCase().includes(t));
    const checkout = refs.branch ? branchName(refs.branch) : refs.head ? `detached at ${refs.head.slice(0, 7)}` : "no commits yet";
    const rows = match(`current checkout ${checkout}`) ? [{ key: "current", label: "Current checkout", detail: checkout }] : [];
    for (const [title, list] of [["Local", refs.local], ["Remote", refs.remote]]) {
      const shown = list.filter((b) => match(b.name));
      if (shown.length) rows.push({ key: `group:${title}`, label: title, group: true }, ...shown.map((b) => ({ key: b.ref, label: b.name, detail: b.head ? "checked out" : "" })));
    }
    return rows;
  }

  label() {
    const refs = this.refs;
    if (this.branch && this.branch !== "current") return branchName(this.branch);
    return refs?.branch ? branchName(refs.branch) : refs?.head ? refs.head.slice(0, 7) : "HEAD";
  }

  button(id, icon, tip, onClick, t, spinning = false) {
    return div().id(id).size(24).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => onClick(cx))
      .child(spinning ? svg("mods/workspace-chrome/spinner.svg").size(14).spin(900) : svg(icon).size(14));
  }

  // Virtual-list rows take no handlers: the list's on_item_click picks by key.
  branchRow(row, t) {
    if (row.group) return div().h(z(24)).px(8).flex().items_end().pb(3).text_size(z(11)).text_color(t.dim).child(row.label);
    const on = row.key === (this.branch ?? "current");
    return h_flex().h(z(28)).px(8).gap(8).items_center().rounded(7).when(on, (e) => e.bg(t.selected))
      .child(div().flex_1().min_w(0).truncate().child(row.label))
      .when(Boolean(row.detail), (e) => e.child(div().flex_none().max_w(160).truncate().text_size(z(11)).text_color(t.dim).child(row.detail)));
  }

  commitRow(c, t) {
    return h_flex().h(z(28)).px(8).gap(6).items_center().rounded(7).when(c.id === this.selected?.id, (e) => e.bg(t.selected))
      .child(div().size(7).flex_none().rounded(4).bg(c.parents.length > 1 ? t.ansi5 : t.muted))
      .child(div().w(z(56)).flex_none().text_size(z(12)).text_color(t.dim).child(c.id.slice(0, 7)))
      .child(div().flex_1().min_w(0).truncate().child(c.subject))
      .child(div().w(z(80)).flex_none().truncate().text_size(z(12)).text_color(t.muted).child(c.author))
      .child(div().w(z(32)).flex_none().text_right().text_size(z(12)).text_color(t.dim).child(ago(c.date)));
  }

  picker(t) {
    const rows = this.branchRows();
    return v_flex().flex_1().min_h(0)
      .on_key_down((e, cx) => { if (e.key === "escape") { this.picking = false; cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().flex_none().px(10).py(5).border_b(1).border_color(t.border)
        .child(div().id("branch-find").flex_1().min_w(0).h(z(24)).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.branchInput).h_full().text_size(z(11)).text_color(t.foreground))))
      .child(v_flex().flex_1().min_h(0).relative().p(6)
        .child(v_virtual_list("git-branches", rows.length, rows.map((r) => r.group ? z(24) : z(28)), (i) => rows[i].key,
          (range) => rows.slice(range.start, range.end).map((r) => this.branchRow(r, t))).size_full()
          .on_item_click((key, cx) => { if (!key.startsWith("group:")) this.choose(key, cx); }))
        .child(Scrollbar.vertical("git-branches").viewport_from_layout().absolute().inset_0())
        .when(!rows.length, (e) => e.child(div().p(8).text_color(t.dim).child("No matching branches"))));
  }

  history(t) {
    const commits = this.commits, offList = this.selected && !commits.some((c) => c.id === this.selected.id);
    const empty = this.error ? null : !this.refs ? (this.loading ? "Loading…" : this.repo ? null : "No folder") : !this.tip ? "No commits yet" : null;
    return v_flex().flex_1().min_h(0)
      .when(Boolean(this.moved), (e) => e.child(div().id("git-moved").flex_none().px(12).py(4).bg(t.raised).text_size(z(11)).text_color(t.muted).cursor_pointer()
        .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.reload(cx)).child("Branch moved · Reload")))
      .when(Boolean(offList), (e) => e.child(div().flex_none().px(12).py(4).text_size(z(11)).text_color(t.dim).child("The picked commit is not in the refreshed list")))
      .child(v_flex().flex_1().min_h(0).relative().p(6)
        .child(v_virtual_list("git-commits", commits.length, z(28), (i) => commits[i].id,
          (range) => commits.slice(range.start, range.end).map((c) => this.commitRow(c, t))).size_full()
          .on_item_click((id, cx) => { const c = this.commits.find((c) => c.id === id); if (c) this.select(c, cx); }))
        .child(Scrollbar.vertical("git-commits").viewport_from_layout().absolute().inset_0())
        .when(Boolean(empty), (e) => e.child(div().p(8).text_color(t.dim).child(empty))))
      .when(this.more, (e) => e.child(div().id("git-more").flex_none().px(12).py(5).border_t(1).border_color(t.border).text_size(z(11)).text_color(t.muted)
        .cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.loadMore(cx))
        .child(this.paging ? "Loading…" : `Load ${commits.length ? "more" : "commits"}`)));
  }

  render(cx) {
    scale = panelScale();
    const shown = visible();
    if (shown && (!this.shown || JSON.stringify(location()) !== this.requested)) this.refresh(cx);
    this.shown = shown;
    const t = theme(), message = this.error ?? this.note;
    return v_flex().id("git").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(z(13))
      .child(h_flex().h(z(42)).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child("Git"))
        .when(Boolean(this.refs), (e) => e.child(div().id("git-branch").min_w(0).max_w(220).h(z(22)).px(8).flex().items_center().rounded(6).cursor_pointer()
          .text_size(z(11)).text_color(t.muted).when(this.picking, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .tooltip(this.branch === "current" ? "Current checkout · pick a branch" : "Pick a branch").on_click((_e, cx) => this.togglePicker(cx))
          .child(div().min_w(0).truncate().child(`${this.label()} ▾`))))
        .when(this.commits.length > 0, (e) => e.child(div().flex_none().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(z(10)).text_color(t.muted)
          .child(`${this.commits.length}${this.more ? "+" : ""}`)))
        .child(div().flex_1())
        .when(Boolean(this.repo), (e) => e.child(div().min_w(0).truncate().text_size(z(11)).text_color(t.dim).child(this.repo.root.split(/[\\/]/).pop())))
        .child(this.button("git-refresh", "mods/my-git/refresh.svg", "Refresh", (cx) => { this.refresh(cx); cx.notify(); }, t, this.loading)))
      .when(Boolean(message), (e) => e.child(div().flex_none().px(12).py(4).border_b(1).border_color(t.border).text_size(z(11))
        .text_color(this.error ? t.ansi1 : t.dim).child(message)))
      .child(this.picking ? this.picker(t) : this.history(t));
  }
}
