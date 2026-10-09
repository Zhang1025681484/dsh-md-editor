# Third-party notices

This package is MIT-licensed (see `LICENSE`), but it contains and derives from
third-party work. Those parts keep their original licenses and copyright.

## 1. dsh-bianji — MIT

<https://github.com/yueyexiayu/dsh-bianji>

The Monaco 0.52.2 loading mechanism is reused from this project. Specifically:

- **`monaco.js`** — same-origin Monaco asset resolution, path-traversal and symlink
  checks, CSS `url(...)` rewriting, content-type mapping, cache headers.
- **`client.js`** — the loader injection sequence and the fallback editor:
  - `installMonacoWorkers()` worker environment
  - `fetchMonaco()` + `loadScriptText()` (fetch text, execute from a blob URL)
  - `require.config({ paths: { vs }, 'vs/css': { disabled: true } })`
  - `installMonacoScriptBridge()` — intercepting `head.appendChild` for `?file=` script tags
  - `injectMonacoCss()` / `rewriteMonacoCss()`
  - `LinedTextarea` — the no-Monaco fallback editor

Adapted for this package: the route prefix (`/api/md-editor/monaco` instead of
`/api/bianji/monaco`), the plugin-directory resolution, and the surrounding
editor component. **Original copyright belongs to the author of dsh-bianji.**

## 2. Monaco Editor — MIT

`vendor/monaco` contains Monaco Editor 0.52.2, Copyright (c) Microsoft Corporation,
licensed under the MIT License. License texts shipped with the bundled assets:
`vendor/monaco/vs/editor/editor.main.js.LEGAL.txt` and related `.LEGAL.txt` files.

## 3. React — MIT

The browser half obtains React from the Harness platform module table
(`require('react')`); **no copy of React is bundled**. Declared in the manifest
via `dsh.client.external` when built, or resolved from the platform table directly.
