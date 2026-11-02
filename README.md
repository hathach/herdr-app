# herdr-app

My customizations for the [Herdr](https://herdr.dev) desktop app, tracked in place in `~/.config/herdr-app`. The
`.gitignore` allowlist keeps Herdr's shipped files and runtime state out: name your own layouts, themes and mods
`my-*` or they stay untracked.

- `mods/my-agents`: Herdr's agents list, drawing a second Claude account's icon in the theme's blue: a terminal whose
  foreground runs as `claude-ada` (the wrapper does `exec -a claude-ada claude`).
- `programs.json`: `claude-ada` counts as Claude Code before its first status report.
- `mods/my-changes`: Herdr's Changes panel plus a side-by-side diff view, an open-in-a-pane button, a branch scope
  (changes vs the default branch, with fetch), a file list resizable in eighths, and C/C++, Python, Markdown and reST
  diffs coloured by `syntax.js`, a line lexer (not a parser). Tests: `node --no-warnings --test
  mods/my-changes/syntax.test.mjs`.
- `mods/my-files`: Herdr's Files panel showing the tree and a file preview together, with the tree on any side and
  resizable in eighths. Markdown and reST previews are coloured by its copy of `syntax.js` (kept identical to
  my-changes', checked by the test); they are read-only lines without text selection. Other files use Herdr's editor.
- `keys.json` (`layout:my-main`): `ctrl-shift-f` opens the side panel's find row (its shown panel, else Files):
  Files finds a path in the whole repo (tracked and untracked, not ignored; outside a repo, the loaded folders),
  Changes filters changed files, Issues and PRs find a loaded number or title (Enter on a number opens it even when
  it isn't loaded). Enter opens the first match, Escape closes the row and returns to the terminal.
- `mods/my-panel-snap`: snaps the right side panel to the nearest eighth of the work area when a drag ends.
- `mods/my-github`: Issues and PRs panels for the focused repo through `gh` on the repo's machine: list, filter,
  search, detail with comments and PR checks below a list resizable in eighths, comment, close/reopen behind a
  confirm. Only the `upstream` and `origin` remotes count, never other forks: the one picked in the panel, else
  `gh repo set-default`'s, else `upstream`, else `origin`; github.com only. Helper tests:
  `node --no-warnings --test mods/my-github/github.test.mjs`.
- `mods/my-tabs`: Herdr's tab bar plus Issues and PRs buttons for the side panel.
- `layouts/my-main.json`: Herdr's `main` layout with its tab bar, agents list and Files and Changes panels pointed at
  `my-tabs`, `my-agents`, `my-files` and `my-changes`, Issues and PRs panels from `my-github`, a side panel sized by
  share (default 3/8, no fixed pixel maximum) and `my-panel-snap` in it.

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
