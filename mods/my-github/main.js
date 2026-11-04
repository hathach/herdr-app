// Issues and pull requests of the focused repo through `gh`; one copy per panel, `kind` "issues" or "prs".
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { spaces, panes, focused, exec, layout, theme, props, shared, setShared, run } from "herdr";
import { parseRemotes, pickRepo, ghFailure, classifyRejection, parseChecks, BUCKETS, ago, since, writeOutcome, matchingIds, commentLanded, exactNumber, findItems } from "./github.js";
import { sizedPart, panelSize, partPx, scaler, PILL_SLOT } from "./part-size.js";
import { SIDES, nextSide, sideOf, shareKey, twelfth, shareOf, shareAt } from "./part-split.js";

const POLL = 60000, BACKOFF = 300000, LIMIT = 100, REPOS = "my-github.repos";
const ISSUE = "number,title,state,author,labels,updatedAt,url", PR = `${ISSUE},isDraft,headRefName,baseRefName,reviewDecision`;
const VIEW = ",body,comments,createdAt";
const KINDS = {
  issues: { cmd: "issue", title: "Issues", noun: "issue", path: "issues", filters: ["open", "closed", "all"], list: ISSUE, view: ISSUE + VIEW },
  prs: { cmd: "pr", title: "Pull requests", noun: "pull request", path: "pulls", filters: ["open", "closed", "merged", "all"], list: PR, view: PR + VIEW },
};
const REVIEW = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

// This panel's text size (my-tabs' A−/A+ while it shows, px at zoom 1; Issues and PRs each their own) sizes its header,
// filters, find row and repo errors; the list and the detail (with its comment box) add their own offsets
// (part-size.js). Text, the heights around it and text columns scale from 13; icons, indents and truncation limits stay.
let z = scaler(13);

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

function must(result) {
  if (result.code !== 0) throw ghFailure(result);
  return result.stdout;
}

const here = () => `${focused()?.space}|${focused()?.tab ?? null}`;

// The tab bar's find key (`panel.find`): a request for this panel, made for the space and tab shown now.
function findRequest(panel, shown) {
  const r = shared("panel.find");
  return r?.panel === panel && Date.now() - r.at < 2000 && `${r.space}|${r.tab}` === here() && shown ? r : null;
}

const slot = (where) => `${where.on ?? ""}|${where.root}`;
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export default class GitHub extends View {
  init(_props, cx) {
    this.kind = props()?.kind === "prs" ? "prs" : "issues"; this.parts = {};
    this.k = KINDS[this.kind];
    this.filterKey = `filter:${this.kind}`;
    const filter = localStorage.getItem(this.filterKey);
    this.filter = this.k.filters.includes(filter) ? filter : "open";
    this.listKey = `list:${this.kind}`;
    // The list's height and width shares are kept apart, so moving it keeps both.
    this.side = sideOf(localStorage.getItem(`${this.listKey}:side`));
    this.share = { down: shareOf(localStorage.getItem(this.listKey), 5 / 12), across: shareOf(localStorage.getItem(shareKey(this.listKey, "across")), 5 / 12) };
    this.search = ""; this.items = []; this.gen = 0; this.detailGen = 0; this.loadedAt = 0;
    this.input = InputState.new({ placeholder: "Search, GitHub syntax" });
    this.input.on("submit", (_e, cx) => { this.search = this.input.value().trim(); this.refresh(cx); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.query = ""; this.findHandle = cx.focus_handle(); this.findInput = InputState.new({ placeholder: "Find number or title in loaded items" });
    this.findInput.on("change", (_e, cx) => { this.query = this.findInput.value().trim(); cx.notify(); });
    this.findInput.on("submit", (_e, cx) => this.findSubmit(cx));
    this.findInput.on("focus", (_e, cx) => { this.findFocused = this.findLanded = true; cx.notify(); });
    this.findInput.on("blur", (_e, cx) => { this.findFocused = false; cx.notify(); });
    // Writes are keyed by `itemKey()`: drafts, requests in flight, and writes whose outcome is unknown.
    this.drafts = new Map(); this.posting = new Set(); this.unknown = new Map(); this.seq = 0;
    this.comment = TextareaState.new({ placeholder: "Comment (Markdown)", rows: 4 });
    this.comment.on("change", (_e, cx) => {
      const had = Boolean(this.drafts.get(this.itemKey())?.trim());
      this.drafts.set(this.itemKey(), this.comment.value());
      if (had !== Boolean(this.comment.value().trim())) cx.notify();
    });
    cx.timer.every(15000, (cx) => { if (!this.loading && this.visible() && this.due()) this.refresh(cx); });
  }

  // The block ids in the layout are the kinds; hidden copies keep their timers, so they check this first.
  visible() {
    const root = layout();
    return find(root, "panel")?.hidden !== true && find(root, "panel-body")?.active === this.kind;
  }

  due() { return !this.stopped && Date.now() >= (this.backoffUntil ?? 0) && Date.now() - this.loadedAt >= POLL; }

  // Where to look and which repo was chosen there; a change means a fresh load.
  stamp(loc = location()) { return JSON.stringify([loc, shared(REPOS) ?? null]); }

  get limited() { return this.items.length >= LIMIT; }

  async resolve({ cwd, on }) {
    if (!cwd) return { error: "No folder" };
    const [top, config] = await Promise.all([
      exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }),
      exec("git", ["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"], { cwd, on }),
    ]);
    if (top.code !== 0) return { error: "Not a git repository" };
    // Exit 1 is "no remotes"; anything higher is git failing.
    if (config.code > 1) return { error: `git config failed: ${(config.stderr || config.stdout).trim()}` };
    const where = { root: top.stdout.trim(), on };
    return { ...where, ...pickRepo({ saved: shared(REPOS)?.[slot(where)], remotes: parseRemotes(config.stdout) }) };
  }

  gh(args, where) { return exec("gh", [...args, "-R", `github.com/${where.repo}`], { cwd: where.root, on: where.on }); }

  refresh(cx) {
    const gen = ++this.gen, loc = location(), stamp = this.stamp(loc);
    // Another place or repo choice: nothing from the old one may show while this one loads, or after it fails.
    if (stamp !== this.stamped) {
      this.stamped = stamp; this.where = null; this.key = null; this.error = null; this.clearList(); this.closeFind();
    }
    this.loading = true; this.stopped = false;
    cx.spawn(async (cx) => {
      try {
        const where = await this.resolve(loc);
        if (gen !== this.gen) return;
        const key = JSON.stringify([where.on, where.root, where.repo, this.filter, this.search]);
        if (key !== this.key) {
          this.key = key; this.clearList();
        }
        this.where = where; this.choosing = this.choosing && Boolean(where.choices);
        if (where.error) throw { message: where.error };
        const args = [this.k.cmd, "list", "--state", this.filter, "--limit", String(LIMIT), "--json", this.k.list, ...(this.search ? ["--search", this.search] : [])];
        const items = JSON.parse(must(await this.gh(args, where)));
        if (gen !== this.gen) return;
        this.items = items; this.error = null;
        if (this.selected) await this.loadDetail(++this.detailGen);
      } catch (e) {
        if (gen === this.gen) this.error = this.classify(e);
      } finally {
        if (gen === this.gen) { this.loading = false; this.loadedAt = Date.now(); }
        cx.notify();
      }
    });
  }

  // An auth failure stops polling until Retry; a rate limit slows it. `polls`: the request was for what is shown.
  classify(e, polls = true) {
    const error = e?.kind ? e : classifyRejection(e, this.where?.on);
    if (polls && error.kind === "auth") this.stopped = true;
    if (polls && error.kind === "rate") this.backoffUntil = Date.now() + BACKOFF;
    return error;
  }

  clearList() { this.items = []; this.closeDetail(); }

  closeDetail() {
    this.selected = null; this.drag = false; this.detail = null; this.checks = null; this.checksError = null; this.detailError = null; this.confirm = null; this.detailGen++;
  }

  shows(where) { return this.where?.on === where.on && this.where?.repo === where.repo; }

  itemKey() { return `${this.where?.on ?? ""}|${this.where?.repo}#${this.selected}`; }

  blocked(key) { return this.posting.has(key) || this.unknown.has(key); }

  select(number, cx) {
    if (this.selected === number) { this.closeDetail(); cx.notify(); return; }
    this.closeDetail(); this.selected = number;
    this.comment.set_value(this.drafts.get(this.itemKey()) ?? "");
    this.reloadDetail(cx);
    cx.notify();
  }

  reloadDetail(cx) {
    const gen = ++this.detailGen;
    cx.spawn(async (cx) => { await this.loadDetail(gen); cx.notify(); });
  }

  // A failed detail keeps the list row's title and link; checks succeed or fail on their own.
  async loadDetail(gen) {
    const n = String(this.selected), where = this.where, key = this.itemKey(), started = ++this.seq;
    this.detailLoading = true;
    const checks = this.kind !== "prs" ? null : this.gh(["pr", "checks", n, "--json", "name,state,bucket,link,workflow"], where)
      .then((r) => ({ list: parseChecks(r) })).catch((error) => ({ error }));
    try {
      const view = JSON.parse(must(await this.gh([this.k.cmd, "view", n, "--json", this.k.view], where)));
      this.settle(key, view, started);
      if (gen === this.detailGen) { this.detail = view; this.detailError = null; }
    } catch (e) {
      if (gen === this.detailGen) this.detailError = this.classify(e).message;
    }
    const c = await checks;
    if (gen !== this.detailGen) return;
    this.detailLoading = false;
    if (c) { this.checks = c.list ?? null; this.checksError = c.error ? this.classify(c.error).message : null; }
  }

  // An unknown write is settled only by seeing it on GitHub, in a read sent after the write: a new matching comment,
  // or the wanted state.
  settle(key, view, started) {
    const w = this.unknown.get(key);
    const landed = w && (w.body ? commentLanded(w.baseline, view.comments, w.body) : view.state === (w.action === "close" ? "CLOSED" : "OPEN"));
    if (!landed || started <= w.sent) return;
    this.unknown.delete(key);
    if (w.body) this.clearDraft(key, w.body);
  }

  // Only the text that was posted: edits made while it was on its way stay.
  clearDraft(key, body) {
    if ((this.drafts.get(key) ?? "").trim() !== body) return;
    this.drafts.delete(key);
    if (this.itemKey() === key) this.comment.set_value("");
  }

  // Reloads the item a write was for, if it is still the one shown.
  after(key, cx, list = false) {
    if (this.itemKey() !== key) return;
    if (list) this.refresh(cx);
    else this.reloadDetail(cx);
  }

  ghWrite(args, where) { return this.gh(args, where).catch((error) => ({ error })).then((r) => writeOutcome(r, where.on)); }

  postComment(cx) {
    const where = this.where, n = String(this.selected), key = this.itemKey(), body = (this.drafts.get(key) ?? "").trim();
    if (!body || this.blocked(key)) return;
    this.posting.add(key); this.writeError = null;
    cx.spawn(async (cx) => {
      try {
        const before = JSON.parse(must(await this.gh([this.k.cmd, "view", n, "--json", "comments"], where)));
        const baseline = matchingIds(before.comments, body), sent = this.seq;
        const result = await this.ghWrite([this.k.cmd, "comment", n, "--body", body], where);
        if (result.outcome === "done") this.clearDraft(key, body);
        else if (result.outcome === "unknown") this.unknown.set(key, { body, baseline, sent });
        else this.writeError = { key, message: this.classify(result, this.shows(where)).message };
        if (result.outcome !== "failed") this.after(key, cx);
      } catch (e) {
        this.writeError = { key, message: `Nothing posted: could not read the discussion first: ${this.classify(e, this.shows(where)).message}` };
      } finally { this.posting.delete(key); cx.notify(); }
    });
    cx.notify();
  }

  setState(cx) {
    const c = this.confirm;
    this.confirm = null;
    if (!c || this.blocked(c.key)) return;
    this.posting.add(c.key); this.writeError = null;
    cx.spawn(async (cx) => {
      try {
        const sent = this.seq, result = await this.ghWrite([this.k.cmd, c.action, c.n], c.where);
        if (result.outcome === "unknown") this.unknown.set(c.key, { action: c.action, sent });
        if (result.outcome === "failed") this.writeError = { key: c.key, message: this.classify(result, this.shows(c.where)).message };
        else this.after(c.key, cx, true);
      } finally { this.posting.delete(c.key); cx.notify(); }
    });
    cx.notify();
  }

  shown() { return this.query ? findItems(this.items, this.query) : this.items; }

  // A number opens exactly that item, loaded or not; anything else, the first match. Never toggles an open one.
  findSubmit(cx) {
    if (!this.where?.repo || this.stamp() !== this.stamped) return;
    const number = exactNumber(this.query) ?? this.shown()[0]?.number;
    if (number && number !== this.selected) this.select(number, cx);
  }

  // Focused again a moment later unless it landed, as Herdr's own dialogs do: a row mounted by this render may not
  // take it at once.
  openFind(cx) {
    this.finding = true; this.findLanded = false; this.findInput.focus();
    const at = here();
    cx.timer.after(600, () => { if (this.finding && !this.findLanded && here() === at && this.visible()) this.findInput.focus(); });
  }

  // Escape gives the keyboard back to the pane it came from.
  closeFind(back = false) {
    this.finding = false; this.query = ""; this.findInput?.set_value("");
    const f = focused();
    if (back && (f?.pane || f?.terminal)) run("pane.focus", f.pane ? { pane: f.pane } : { terminal: f.terminal });
  }

  findRow(t, count) {
    return h_flex().id("find").flex_none().px(10).py(5).gap(6).items_center().border_b(1).border_color(t.border).text_size(z(11)).text_color(t.dim)
      .track_focus(this.findHandle).on_key_down((e, cx) => { if (e.key === "escape") { this.closeFind(true); cx.stop_propagation(); cx.notify(); } })
      .child(div().id("find-box").flex_1().min_w(0).h(z(24)).px(8).flex().items_center().rounded(6).border_1().border_color(this.findFocused ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.findInput).h_full().text_size(z(11)).text_color(t.foreground)))
      .child(div().flex_none().child(count))
      .child(this.button("find-close", "mods/my-github/x.svg", "Close find (Esc)", (cx) => { this.closeFind(); cx.notify(); }, t));
  }

  startDrag(cx) {
    this.drag = true;
    cx.stop_propagation(); cx.notify();
  }

  moveList(cx) {
    this.side = nextSide(this.side);
    localStorage.setItem(`${this.listKey}:side`, this.side);
    cx.notify();
  }

  // The drag cover spans the list and the detail, so the pointer's place in it is the list's share.
  dragTo(event, cx) {
    const share = this.drag && shareAt(this.side, event.local_position, event.bounds), { axis } = SIDES[this.side];
    if (!share || share === this.share[axis]) return;
    this.share[axis] = share; cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    this.drag = false;
    const { axis } = SIDES[this.side];
    this.share[axis] = twelfth(this.share[axis]); localStorage.setItem(shareKey(this.listKey, axis), String(this.share[axis]));
    cx.notify();
  }

  setFilter(filter, cx) {
    if (filter === this.filter) return;
    this.filter = filter; localStorage.setItem(this.filterKey, filter);
    this.refresh(cx); cx.notify();
  }

  choose(repo, cx) {
    setShared(REPOS, { ...(shared(REPOS) ?? {}), [slot(this.where)]: repo });
    this.choosing = false; cx.notify();
  }

  button(id, icon, tip, onClick, t, spinning = false) {
    return div().id(id).size(24).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover)).tooltip(tip).on_click((_e, cx) => onClick(cx))
      .child(spinning ? svg("mods/my-github/spinner.svg").size(14).spin(900) : svg(icon).size(14));
  }

  chip(id, label, on, onClick, t, sz = z) {
    return div().id(id).h(sz(22)).px(8).flex().flex_none().items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected).text_color(t.foreground)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => onClick(cx)).child(label);
  }

  stateColor(it, t) {
    return it.isDraft ? t.dim : it.state === "OPEN" ? t.ansi2 : it.state === "MERGED" ? t.ansi5 : this.kind === "prs" ? t.ansi1 : t.ansi5;
  }

  notice(t) { return h_flex().flex_wrap().gap(6).items_center().p(8).rounded(8).border_1().border_color(t.ansi3); }

  labels(list, t) {
    return (list ?? []).slice(0, 3).map((l) => div().px(5).rounded(8).border_1().border_color(`#${l.color}`).text_color(t.muted).max_w(120).truncate().child(l.name));
  }

  // One line, columns aligned across rows: dot, number, title, author, age (not when slim); the rest is in the tooltip
  // and detail.
  row(it, t, numberWidth, z, slim) {
    const author = it.author?.login ?? "ghost", age = ago(it.updatedAt), names = (it.labels ?? []).map((l) => l.name).join(", ");
    const tip = [`#${it.number} ${it.title}`, [author, since("updated", age), it.isDraft && "draft",
      REVIEW[it.reviewDecision], names && `labels ${names}`].filter(Boolean).join(" · ")].join("\n");
    return h_flex().id(`item-${it.number}`).flex_none().h(z(28)).px(8).gap(6).items_center().rounded(7).cursor_pointer().tooltip(tip)
      .when(this.selected === it.number, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.select(it.number, cx))
      .child(div().size(7).flex_none().rounded(4).bg(this.stateColor(it, t)))
      .child(div().w(numberWidth).flex_none().truncate().text_right().text_size(z(12)).text_color(t.dim).child(`#${it.number}`))
      .child(div().flex_1().min_w(0).truncate().child(it.title))
      .when(!slim, (e) => e.child(div().w(z(80)).flex_none().truncate().text_size(z(12)).text_color(t.muted).child(author))
        .child(div().w(z(32)).flex_none().text_right().text_size(z(12)).text_color(t.dim).child(age)));
  }

  checksView(t, z) {
    if (this.checksError) return div().text_size(z(11)).text_color(t.ansi1).child(`Checks: ${this.checksError}`);
    if (!this.checks) return null;
    if (!this.checks.length) return div().text_size(z(11)).text_color(t.dim).child("No checks");
    const summary = BUCKETS.map(([b, word]) => [this.checks.filter((c) => c.bucket === b).length, word]).filter(([n]) => n).map(([n, word]) => `${n} ${word}`).join(", ");
    const color = Object.fromEntries(BUCKETS.map(([b, , token]) => [b, t[token]]));
    return v_flex().gap(2).text_size(z(11))
      .child(div().text_color(t.muted).child(`Checks: ${summary}`))
      .children(this.checks.filter((c) => c.bucket === "fail" || c.bucket === "pending").map((c, i) =>
        h_flex().id(`check-${i}`).gap(6).min_w(0).items_center().cursor_pointer().hover((s) => s.text_color(t.foreground)).text_color(t.muted)
          .on_click((_e, cx) => { if (c.link) cx.open_url(c.link); })
          .child(div().size(6).flex_none().rounded(3).bg(color[c.bucket])).child(div().min_w(0).truncate().child(c.workflow ? `${c.workflow} / ${c.name}` : c.name))));
  }

  detailView(t, z) {
    const d = this.detail, it = d ?? this.items.find((i) => i.number === this.selected) ?? { number: this.selected };
    const n = it.number, checks = this.kind === "prs" ? this.checksView(t, z) : null, opened = d && ago(d.createdAt);
    const meta = [it.author?.login, opened && since("opened", opened), REVIEW[it.reviewDecision]].filter(Boolean).join(" · ");
    return v_flex().id("detail").flex_1().min_h(0).overflow_y_scrollbar().p(12).gap(10)
      // The part's size pill sits at the top right, beside these buttons.
      .child(h_flex().gap(6).items_start().pr(PILL_SLOT - 12)
        .child(div().flex_1().min_w(0).font_semibold().child(it.title ? `${it.title} #${n}` : `#${n}`))
        .when(Boolean(it.url), (e) => e
          .child(this.button("copy-link", "mods/my-github/copy.svg", "Copy link", (cx) => cx.write_to_clipboard(it.url), t))
          .child(this.button("open-item", "mods/my-github/external.svg", "Open in browser", (cx) => cx.open_url(it.url), t)))
        .child(this.button("close-detail", "mods/my-github/x.svg", "Close", (cx) => { this.closeDetail(); cx.notify(); }, t)))
      .when(Boolean(it.state), (e) => e.child(h_flex().flex_wrap().gap(6).items_center().text_size(z(11)).text_color(t.dim)
        .child(div().px(6).rounded(8).text_color(t.background).bg(this.stateColor(it, t)).child(it.isDraft ? "DRAFT" : it.state))
        .child(div().min_w(0).truncate().child(meta))
        .children(this.labels(it.labels, t))))
      .when(Boolean(it.headRefName), (e) => e.child(div().text_size(z(11)).text_color(t.muted).truncate().child(`${it.headRefName} → ${it.baseRefName}`)))
      .when(Boolean(d), (e) => e.child(this.writes(d, t, z)))
      .when(Boolean(checks), (e) => e.child(checks))
      .when(Boolean(this.detailError), (e) => e.child(div().text_size(z(11)).text_color(t.ansi1).child(this.detailError)))
      .when(this.detailLoading && !d, (e) => e.child(div().text_color(t.dim).child("Loading…")))
      .when(Boolean(d), (e) => e
        .child(TextView.markdown(`body-${n}`, d.body?.trim() || "_No description._").selectable().w_full())
        .child(div().pt(4).text_size(z(11)).text_color(t.dim).child(`${d.comments.length} comment${d.comments.length === 1 ? "" : "s"}${this.kind === "prs" ? " · review comments on code are on GitHub" : ""}`))
        .children(d.comments.map((c, i) => v_flex().gap(4).p(8).rounded(8).border_1().border_color(t.border)
          .child(div().text_size(z(11)).text_color(t.dim).child(`${c.author?.login ?? "ghost"} · ${ago(c.createdAt)}`))
          .child(TextView.markdown(`comment-${n}-${i}`, c.body || " ").selectable().w_full())))
        .child(this.composer(t, z)));
  }

  // Close/Reopen behind a confirm naming the exact item, and the state of this item's writes.
  writes(d, t, z) {
    const key = this.itemKey(), label = `${this.where.repo}#${d.number}`, busy = this.posting.has(key), unknown = this.unknown.get(key);
    const action = d.state === "OPEN" ? "close" : d.state === "CLOSED" ? "reopen" : null;
    const confirm = this.confirm?.key === key ? this.confirm : null;
    return v_flex().gap(6).text_size(z(11))
      .child(h_flex().gap(4).items_center()
        .when(Boolean(action) && !confirm && !this.blocked(key), (e) => e.child(this.chip("state-action", `${cap(action)} ${this.k.noun}`, false,
          (cx) => { this.confirm = { key, where: this.where, n: String(d.number), action, label }; cx.notify(); }, t, z).border_1().border_color(t.border)))
        .when(busy, (e) => e.child(div().text_color(t.dim).child("Sending…"))))
      .when(Boolean(confirm), (e) => e.child(this.notice(t)
        .child(div().min_w(0).child(`${cap(confirm.action)} ${confirm.label}?`))
        .child(div().flex_1())
        .child(this.chip("state-yes", cap(confirm.action), true, (cx) => this.setState(cx), t, z))
        .child(this.chip("state-no", "Cancel", false, (cx) => { this.confirm = null; cx.notify(); }, t, z))))
      .when(this.writeError?.key === key, (e) => e.child(div().text_color(t.ansi1).child(this.writeError.message)))
      .when(Boolean(unknown), (e) => e.child(this.notice(t)
        .child(div().min_w(0).flex_1().child(`${unknown.body ? "Comment" : cap(unknown.action)}: outcome unknown, check on GitHub before trying again`))
        .child(this.chip("unknown-check", "Check again", false, (cx) => this.after(key, cx), t, z))
        .child(this.chip("unknown-clear", "Clear", false, (cx) => { this.unknown.delete(key); cx.notify(); }, t, z))));
  }

  composer(t, z) {
    const key = this.itemKey(), label = `${this.where.repo}#${this.selected}`;
    const enabled = Boolean(this.drafts.get(key)?.trim()) && !this.blocked(key);
    return v_flex().gap(6).pt(4)
      .child(div().id("comment-box").rounded(8).border_1().border_color(t.border).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.comment).text_size(z(12))))
      .child(h_flex().child(div().flex_1())
        .child(div().id("post-comment").h(z(28)).px(12).flex().items_center().rounded(7).text_size(z(12)).min_w(0).truncate()
          .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).when(enabled, (e) => e.cursor_pointer())
          .on_click((_e, cx) => { if (enabled) this.postComment(cx); }).child(this.posting.has(key) ? "Posting…" : `Post comment to ${label}`)));
  }

  message(t) {
    if (this.error) {
      const hint = { auth: "Run `gh auth login`", rate: "Rate limited, retrying in 5 min", timeout: "gh timed out" }[this.error.kind];
      return h_flex().px(12).py(6).gap(8).items_center().text_size(z(11)).text_color(t.ansi1)
        .child(div().flex_1().min_w(0).child([hint, this.error.message].filter(Boolean).join(": ")))
        .child(this.chip("retry", "Retry", false, (cx) => this.refresh(cx), t).text_color(t.foreground));
    }
    return null;
  }

  render(cx) {
    z = scaler(panelSize(this.kind));
    const shown = this.visible();
    if (shown && (this.stamp() !== this.stamped || (!this.loading && this.due()))) this.refresh(cx);
    const request = findRequest(this.kind, shown);
    if (request && request.id !== this.findId) {
      this.findId = request.id; this.openFind(cx);
      setShared("panel.find", null);
    }
    const t = theme(), w = this.where, repo = w?.repo, note = this.message(t), items = this.shown();
    // From every loaded item, so filtering keeps the title column still; 0.65 em covers a 12px UI-font digit or "#".
    const lz = scaler(partPx(this.kind, "list")), dz = scaler(partPx(this.kind, "detail"));
    const part = (box, content, opts) => sizedPart(box, content, { ui: this.parts, panel: this.kind, t, hide: this.drag, ...opts });
    const { direction, axis, cursor } = SIDES[this.side], across = axis === "across", share = `${this.share[axis] * 100}%`;
    const listBox = !this.selected ? v_flex().flex_1().min_w(0).min_h(0)
      : across ? v_flex().flex_none().min_h(0).h_full().w(share) : v_flex().flex_none().min_h(0).h(share);
    const divider = across ? div().w(5).h_full().flex().justify_center().child(div().w(1).h_full().bg(t.border))
      : div().h(5).w_full().flex().flex_col().justify_center().child(div().h(1).w_full().bg(t.border));
    const digits = this.items.reduce((n, it) => Math.max(n, String(it.number).length), 1), numberWidth = Math.ceil((digits + 1) * lz(12) * 0.65);
    // Author and age take about 200 px with the dot, number and gaps; a narrower list drops them to keep its titles.
    const slimAt = lz(360), slim = this.listWidth < slimAt;
    const empty = this.loading ? "Loading…" : repo && !this.error ? `No ${this.filter === "all" ? "" : this.filter + " "}${this.k.title.toLowerCase()}` : "";
    return v_flex().id("github").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(z(13))
      .child(h_flex().h(z(42)).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().font_semibold().child(this.k.title))
        .when(this.items.length > 0, (e) => e.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(z(10)).text_color(t.muted).child(this.query ? `${items.length} of ${this.items.length}` : this.limited ? `${LIMIT}+` : String(this.items.length))))
        .child(div().flex_1())
        .when(w?.choices?.length > 1, (e) => e.child(div().id("repo").min_w(0).max_w(180).h(z(22)).px(8).flex().items_center().rounded(6).cursor_pointer().text_size(z(11)).text_color(t.muted)
          .when(Boolean(this.choosing), (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.choosing = !this.choosing; cx.notify(); })
          .child(div().min_w(0).truncate().child(`${repo} ▾`))))
        .when(w?.choices?.length <= 1, (e) => e.child(div().min_w(0).truncate().text_size(z(11)).text_color(t.dim).child(repo)))
        .when(Boolean(repo) && this.kind === "issues", (e) => e.child(this.button("new-issue", "mods/my-github/plus.svg", "New issue on GitHub", (cx) => cx.open_url(`https://github.com/${repo}/issues/new/choose`), t)))
        .when(Boolean(repo), (e) => e.child(this.button("open-repo", "mods/my-github/external.svg", "Open on GitHub", (cx) => cx.open_url(`https://github.com/${repo}/${this.k.path}`), t)))
        .when(Boolean(this.selected), (e) => e.child(this.button("github-side", `mods/my-github/panel-${this.side}.svg`, `List on the ${this.side} · move it`, (cx) => this.moveList(cx), t)))
        .child(this.button("refresh", "mods/my-github/refresh.svg", "Refresh", (cx) => this.refresh(cx), t, this.loading)))
      .when(Boolean(w?.choices) && this.choosing, (e) => e.child(h_flex().flex_wrap().px(10).py(6).gap(4).border_b(1).border_color(t.border).text_size(z(11)).text_color(t.muted)
        .children(w.choices.map((c) => this.chip(`choose-${c}`, c, c === repo, (cx) => this.choose(c, cx), t)))))
      .child(h_flex().flex_wrap().flex_none().px(10).py(5).gap(4).items_center().border_b(1).border_color(t.border).text_size(z(11)).text_color(t.muted)
        .children(this.k.filters.map((f) => this.chip(`filter-${f}`, cap(f), this.filter === f, (cx) => this.setFilter(f, cx), t)))
        .child(div().id("search").flex_1().min_w(120).h(z(24)).px(8).flex().items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(Input.new(this.input).h_full().text_size(z(11)).text_color(t.foreground))))
      .when(Boolean(this.finding), (e) => e.child(this.findRow(t, this.query ? `${items.length} found` : "")))
      .when(Boolean(note), (e) => e.child(note))
      .child(div().id("github-body").flex()[direction]().flex_1().min_h(0).relative().on_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .child(part(listBox,
        v_flex().id("items").size_full().overflow_y_scrollbar().p(6)
          .on_size_change((size, cx) => { this.listWidth = size.width; if (size.width < slimAt !== slim) cx.notify(); })
          .children(items.map((it) => this.row(it, t, numberWidth, lz, slim)))
          .when(!this.items.length && Boolean(empty), (e) => e.child(div().p(8).text_color(t.dim).child(empty)))
          .when(this.items.length > 0 && !items.length, (e) => e.child(div().p(8).text_color(t.dim).child(exactNumber(this.query) ? `Not loaded: Enter opens #${exactNumber(this.query)}` : "No matching loaded items")))
          .when(this.limited, (e) => e.child(div().p(8).text_size(lz(11)).text_color(t.dim).child(`Showing the first ${LIMIT}: refine the search to see more`))),
        { part: "list", label: this.k.title }))
      .when(Boolean(this.selected), (e) => e
        .child(divider.id("github-divider").flex_none()[cursor]().on_mouse_down("left", (_e, cx) => this.startDrag(cx)))
        .child(part(v_flex().flex_1().min_w(0).min_h(0), this.detailView(t, dz), { part: "detail", label: "Detail" })))
      // While dragging, a cover keeps the pointer's moves and release even over the detail's text and comment box.
      .when(Boolean(this.drag), (e) => e.child(div().id("github-drag").absolute().inset_0()[cursor]()
        .on_mouse_move((ev, cx) => this.dragTo(ev, cx)).on_mouse_up("left", (_ev, cx) => this.endDrag(cx)).on_hover((inside, cx) => { if (!inside) this.endDrag(cx); }))));
  }
}
