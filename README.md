# herdr-app

My customizations for the [Herdr](https://herdr.dev) desktop app, tracked in place in `~/.config/herdr-app`. The
`.gitignore` allowlist keeps Herdr's shipped files and runtime state out: name your own layouts, themes and mods
`my-*` or they stay untracked.

- `mods/my-agents`: Herdr's agents list, drawing a second Claude account's icon in the theme's blue: a terminal whose
  foreground runs as `claude-ada` (the wrapper does `exec -a claude-ada claude`).
- `programs.json`: `claude-ada` counts as Claude Code before its first status report.
- `mods/my-changes`: Herdr's Changes panel plus a side-by-side diff view, an open-in-a-pane button, a branch scope
  (changes vs the default branch, with fetch), changed files as a folder tree like Files (flat matches while finding; a
  file's +/− counts give way when its name needs the room) resizable in twelfths, and C/C++, Python, Markdown and reST
  diffs coloured by `syntax.js`, a line lexer (not a parser), which stops colouring after 250 ms, since Herdr interrupts
  a script task after 500 ms. Tests: `node --no-warnings --test mods/my-changes/*.test.mjs`. With props `{source: "git",
  panel: "git"}` it is the Git panel's lower half: my-git's picked commit, read-only, against its first parent (a root
  commit against nothing), with its own view and text size settings.
- `mods/my-git`: the Git panel's upper half, read-only: the focused repo's branches (current checkout, local,
  remote-tracking; no fetch) and a branch's commits, 100 a page from the tip as it was when listed. The picked commit
  goes to the my-changes block below through shared `git.selection`. Polls refs every 10 s while shown; a moved branch
  reloads the first page, or offers Reload once more pages are loaded. Reads never fetch a partial clone's missing
  objects (`--no-lazy-fetch`; a Git without it shows an error). Tests: `node --no-warnings --test
  mods/my-git/git.test.mjs`.
- `mods/my-files`: Herdr's Files panel showing the tree and a file preview together, with the tree on any side and
  resizable in twelfths. Markdown and reST previews are coloured by its copy of `syntax.js` (kept identical to
  my-changes', checked by the test); they are read-only lines without text selection. Other files use Herdr's editor.
- `keys.json` (`layout:my-main`): `ctrl-shift-f` opens the side panel's find row (its shown panel, else Files):
  Files finds a path in the whole repo (tracked and untracked, not ignored; outside a repo, the loaded folders),
  Changes and Git filter changed files, Issues and PRs find a loaded number or title (Enter on a number opens it even
  when it isn't loaded). Enter opens the first match, Escape closes the row and returns to the terminal.
- `mods/my-panel-snap`: snaps the right side panel to the nearest twelfth of the work area when a drag ends.
- `mods/my-github`: Issues and PRs panels for the focused repo through `gh` on the repo's machine: list, filter,
  search, detail with comments and PR checks below a list resizable in twelfths, comment, close/reopen behind a
  confirm. Only the `upstream` and `origin` remotes count, never other forks: the one picked in the panel, else
  `gh repo set-default`'s, else `upstream`, else `origin`; github.com only. Helper tests:
  `node --no-warnings --test mods/my-github/github.test.mjs`.
- List sides (`part-split.js` in my-changes and my-github, identical copies; tests: `node --no-warnings --test
  mods/my-changes/part-split.test.mjs`): like the Files tree, the Changes and Git changed-files list moves to any side
  of its diff, and the Issues and PRs list to any side of an open item, from a header button. Each copy keeps its side
  and a height and a width share apart (`list:<panel|pane|git|issues|prs>[:side|:across]` in its storage), so moving
  keeps both; the Changes list's height fits its files until dragged, and the commit box stays below both.
- `mods/my-tabs`: Herdr's tab bar plus Issues, PRs and Git buttons for the side panel, and while it is open, A−/A+ for
  the shown panel's text size (shared `panel.text_size.<files|changes|issues|prs|git>`, 10–20 px at zoom 1, default
  13): each panel scales its text and rows from its own. Herdr's Settings screen can't take extra rows (`frame/` is
  rewritten on every start).
- Part sizes (`part-math.js` in my-files, my-changes, my-git, my-github and my-tabs, `part-size.js` in the first four,
  identical copies; tests: `node --no-warnings --test mods/my-changes/part-math.test.mjs`): each part of a panel (Files
  list and preview; Changes list, diff and commit box; Git commits, changed files and diff; Issues and PRs list and
  detail) shows a `− 13 +` pill while hovered, Ctrl+scroll over it resizes it, and clicking the number resets it. A
  part stores an offset from its panel's size (`panel.text_offset.<panel>.<part>`, −12 to +14), clamped to 8–24 px at
  zoom 1, so A−/A+ moves every part with the panel until a part reaches a limit. Below 96 px wide the pill drops its
  number, below 52 px only Ctrl+scroll is left. Resizing a code preview reopens its editor at the top. Fenced code
  blocks in Issues and PRs bodies and comments keep a fixed size: Herdr's Markdown view can't size them.
- `layouts/my-main.json`: Herdr's `main` layout with its tab bar, agents list and Files and Changes panels pointed at
  `my-tabs`, `my-agents`, `my-files` and `my-changes`, Issues and PRs panels from `my-github`, a Git panel (`my-git`
  over `my-changes`, 3:5, resizable), a side panel sized by
  share (default 5/12, no fixed pixel maximum) and `my-panel-snap` in it. The Files and Changes blocks' prop
  `code_font_size` (13, the panels' list size) sizes the diff and file preview text, in the terminal's font, at the
  default panel text size; without it they use the terminal's size.

## Use on another machine

```sh
cd ~/.config/herdr-app
git init -b main && git remote add origin git@github.com:hathach/herdr-app.git
git fetch origin && git checkout -f -t origin/main   # replaces that machine's keys.json and settings.json
herdr-app do layout.switch '{"name":"my-main"}'
```

## License

Apache-2.0, as Herdr. Files cloned from Herdr's shipped mods and layouts are modified copies; each says so and
records its origin in `cloned_from`. Icons copied from Herdr are Lucide glyphs under ISC/MIT: see `LICENSE-Lucide.txt`.
