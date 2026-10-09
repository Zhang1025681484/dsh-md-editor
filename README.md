# dsh-md-editor

**Edit workspace `.md` files right inside the DeepSeek Harness right sidebar.**

Click a `.md` in the official workspace file tree → it opens in the right sidebar as an
**editable Monaco tab**. Type, pause, and it saves itself. No separate page, no copy-pasting
into another editor.

> 中文说明见 [README.zh.md](./README.zh.md)

---

## What it does

- **Opens in place** — registers its own Sidebar tab type for `*.md` / `*.markdown`,
  so the official file tree opens files directly into an editable tab.
- **Monaco editor** — line numbers, Markdown syntax highlighting, word wrap.
  If Monaco cannot load it degrades to a line-numbered plain textarea (still editable).
- **Autosave** — writes 1.5 s after you stop typing. `Ctrl/Cmd+S` saves immediately.
- **Reload** — discards local edits and re-reads from disk.
- **Preview hand-off** — a Preview button opens the same file in the official document tab
  (kind `text`), giving you the built-in renderers (Markdown / code / plain text), plus Mermaid
  and KaTeX if [`dsh-md-studio`](https://github.com/BioAIEvolu/dsh-md-studio) is installed.

## Install

```sh
# from npm (once published)
dsh plugin --profile <your-profile> add dsh-md-editor

# from GitHub
dsh plugin --profile <your-profile> add github:Zhang1025681484/dsh-md-editor

# from a local directory
dsh plugin --profile <your-profile> add file:/absolute/path/to/dsh-md-editor
```

On the Electron desktop build the `desktop` profile is owned by the app itself, so the CLI cannot
install into it — use **Settings → Plugins → Add plugin** and paste the local path or package name.

Then **fully restart DSH** (host-side JavaScript modules are cached per process) and make sure the
plugin is enabled in the plugin list.

## Usage

1. Open the right sidebar → **Files** tab
2. Click any `.md` file → it opens in a **Markdown Editor** tab
3. Edit; pause 1.5 s (or `Ctrl/Cmd+S`)
4. The status bar shows `已保存（版本 …）` once the write lands

## Requirements

- DeepSeek Harness **>= 0.2.0-rc.2** (developed and verified on `0.2.0-rc.2`)
- Monaco 0.52.2 is bundled in `vendor/monaco` (~13 MB), so it works fully offline

## Known limitations

- **No conflict protection.** Saves overwrite unconditionally. The intended `replaceIfVersion`
  guard is disabled: the `version` string returned over the Remote layer has its `mtimeNs` segment
  altered in transit (expected `…:1781482301616186400:…`, actual `…:1791482301616186400:…` — off by
  exactly 1e16, a large-integer serialization artifact), so every save would be rejected as a stale
  conflict. Use the Reload button when you want disk to win.
- **No Markdown rendering.** This is an editor, not a viewer — use the Preview button, or install a
  preview plugin such as `dsh-md-studio`.
- **Large files are truncated** at 5 000 lines/page × 40 pages (~200 000 lines). The status bar warns
  you; do not save a truncated file.
- **UI strings are hard-coded Chinese** — the client locale service is not wired up yet.
- **Writes `.client-beacon.log`** into the plugin directory. It is a debugging beacon (see below)
  and is safe to delete.

## How it works (for plugin authors)

Two halves, declared in `package.json`:

| Half | File | Responsibility |
|---|---|---|
| Host | `index.js` | serves Monaco assets at `/api/md-editor/monaco` via `ctx.connection.fetch.register`; registers the `/md-save` command |
| Host | `monaco.js` | same-origin Monaco asset resolution, with traversal and symlink checks |
| Browser | `client.js` | registers the tab type and renders the editor |

Key APIs, all verified against official implementations:

```js
// browser half — first-layer extension point (stable; body fully self-controlled)
ctx.sidebarRightTabs.register({
  id: 'dsh-md-editor', kind: 'md-editor',
  patterns: ['*.md', '*.markdown'],   // glob — WITH the dot
  priority: 'extension',
  title: () => 'Markdown editor',
});
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-md-editor' }, Body));

// Cordis service dependencies must be declared verbatim
inject: ['slots', 'sidebarRight', 'remote', 'remote.workspaceFiles', 'remote.commands']
```

- Reads go through `ctx.remote.workspaceFiles.read(...)` — that service is read-only.
- Writes must be performed by the host: the browser calls the `/md-save` command, and the host
  writes with `ctx.fs.writeText(resolved, content, guard, undefined, policy)`.
- **The host must pass the session workspace as `cwd`** when resolving the path — otherwise relative
  paths resolve against the process working directory and you get a "successful" write to the wrong
  location.

### Debug beacon

The plugin appends one line per lifecycle stage to `.client-beacon.log` in its own directory
(via a `/api/md-editor/beacon` route). It turns "the UI looks wrong" into numbers readable from
disk. Every trap hit while building this is written up in
[`DSH插件开发-避坑指南.md`](../DSH插件开发-避坑指南.md) (Chinese).

## Third-party

See [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md). In short:

- **Monaco Editor 0.52.2** — MIT, © Microsoft Corporation (bundled in `vendor/monaco`)
- **Monaco loading mechanism** — reused from [yueyexiayu/dsh-bianji](https://github.com/yueyexiayu/dsh-bianji) (MIT)

## License

MIT — see [LICENSE](./LICENSE).
