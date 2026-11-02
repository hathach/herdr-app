# herdr-app

My customizations for the [Herdr](https://herdr.dev) desktop app, tracked in place in `~/.config/herdr-app`. The
`.gitignore` allowlist keeps Herdr's shipped files and runtime state out: name your own layouts, themes and mods
`my-*` or they stay untracked.

- `mods/my-agents`: Herdr's agents list, drawing a second Claude account's icon in the theme's blue: a terminal whose
  foreground runs as `claude-ada` (the wrapper does `exec -a claude-ada claude`).
- `programs.json`: `claude-ada` counts as Claude Code before its first status report.
- `mods/my-changes`: Herdr's Changes panel plus a side-by-side diff view, an open-in-a-pane button, a branch scope
  (changes vs the default branch, with fetch) and a file list resizable in eighths.
- `mods/my-files`: Herdr's Files panel showing the tree and a file preview together, with the tree on any side and
  resizable in eighths.
- `mods/my-panel-snap`: snaps the right side panel to the nearest eighth of the work area when a drag ends.
- `layouts/my-main.json`: Herdr's `main` layout with its agents list and Files and Changes panels pointed at
  `my-agents`, `my-files` and `my-changes`, a side panel sized by share (default 3/8, no fixed pixel maximum) and
  `my-panel-snap` in it.

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
