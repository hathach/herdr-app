# herdr-app

My customizations for the [Herdr](https://herdr.dev) desktop app, tracked in place in `~/.config/herdr-app`. The
`.gitignore` allowlist keeps Herdr's shipped files and runtime state out: name your own layouts, themes and mods
`my-*` or they stay untracked.

- `mods/my-changes`: Herdr's Changes panel plus a side-by-side diff view, an open-in-a-pane button and a branch scope
  (changes vs the default branch, with fetch).
- `layouts/my-main.json`: Herdr's `main` layout with its Changes panel pointed at `my-changes`.

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
