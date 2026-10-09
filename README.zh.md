# dsh-md-editor · 右栏 Markdown 编辑器

**在 DeepSeek Harness 右侧栏里直接编辑工作区的 `.md` 文件。**

在官方工作区文件树里点一个 `.md` → 它就在右栏以**可编辑的 Monaco 标签**打开。
直接改，停手 1.5 秒自动保存。不用另开页面，不用复制粘贴到别的编辑器。

> English docs: [README.md](./README.md)

---

## 能做什么

- **就地打开** —— 为 `*.md` / `*.markdown` 注册自己的 Sidebar 标签类型，
  官方文件树点文件就直接进可编辑标签。
- **Monaco 编辑器** —— 行号、Markdown 语法高亮、自动换行。
  Monaco 加载失败时降级为**带行号的纯文本框**（仍可编辑）。
- **自动保存** —— 停手 1.5 秒写盘；`Ctrl/Cmd+S` 立即保存。
- **重新读取** —— 放弃本地改动、重新拉磁盘内容。
- **预览接力** —— 「预览」按钮把同一文件交给**官方文档标签**（kind `text`），
  那里有内置渲染器（Markdown / 代码 / 纯文本）；装了
  [`dsh-md-studio`](https://github.com/BioAIEvolu/dsh-md-studio) 还能看 Mermaid 与公式。

## 安装

```sh
# npm（发布后）
dsh plugin --profile <你的 profile> add dsh-md-editor

# 从 GitHub
dsh plugin --profile <你的 profile> add github:Zhang1025681484/dsh-md-editor

# 从本地目录
dsh plugin --profile <你的 profile> add file:/绝对路径/dsh-md-editor
```

**Electron 桌面版**的 `desktop` profile 由应用自己管理（CLI 装不进去），
请用 **设置 → 插件 → 添加插件**，粘贴本地路径或包名。

装完后**完全退出 DSH 再打开**（宿主侧 JS 模块按进程缓存），
并在插件列表里确认它已启用。

## 使用

1. 打开右侧栏 → **文件** 标签
2. 点任意 `.md` → 在「**Markdown 编辑器**」标签里打开
3. 编辑；停手 1.5 秒（或 `Ctrl/Cmd+S`）
4. 底部状态栏出现 `已保存（版本 …）` 即写入成功

## 环境要求

- DeepSeek Harness **>= 0.2.0-rc.2**（开发与验证环境为 `0.2.0-rc.2`）
- Monaco 0.52.2 随包内置（`vendor/monaco`，约 13 MB），**完全离线可用**

## 已知限制（如实说）

- **无冲突保护。** 保存是直接覆盖。原本的 `replaceIfVersion` 校验已关闭：
  该 `version` 字符串经 Remote 层传到浏览器后 `mtimeNs` 段会变形
  （期望 `…:1781482301616186400:…`，实际 `…:1791482301616186400:…`，差恰好 1e16，
  是大整数序列化的精度问题），带它保存必然被判"版本冲突"。需要以磁盘为准时用「重新读取」。
- **不做 Markdown 渲染。** 这是编辑器不是阅读器；要看渲染效果用「预览」按钮，
  或装预览类插件（如 `dsh-md-studio`）。
- **大文件会截断**：单页 5 000 行、最多 40 页（约 20 万行）。状态栏会提示，
  **截断状态下请勿保存**。
- **界面文案是中文硬编码**，尚未接入 Client locale 服务。
- **会在插件目录写 `.client-beacon.log`**（调试信标，见下），可随时删除。

## 实现要点（写给插件开发者）

`package.json` 里声明两半：

| 半 | 文件 | 职责 |
|---|---|---|
| 宿主 | `index.js` | 用 `ctx.connection.fetch.register` 在 `/api/md-editor/monaco` 暴露 Monaco 资源；注册 `/md-save` 命令 |
| 宿主 | `monaco.js` | 同源 Monaco 资源解析，含路径穿越与符号链接校验 |
| 浏览器 | `client.js` | 注册标签类型并渲染编辑器 |

用到的关键 API（均对照官方实现验证过）：

```js
// 浏览器半 —— 第一层扩展点（稳定；正文完全自控）
ctx.sidebarRightTabs.register({
  id: 'dsh-md-editor', kind: 'md-editor',
  patterns: ['*.md', '*.markdown'],   // glob —— 带点
  priority: 'extension',
  title: () => 'Markdown 编辑器',
});
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-md-editor' }, Body));

// Cordis 服务依赖必须逐字声明
inject: ['slots', 'sidebarRight', 'remote', 'remote.workspaceFiles', 'remote.commands']
```

- 读文件走 `ctx.remote.workspaceFiles.read(...)`（该服务只读）。
- 写文件必须由宿主执行：浏览器调 `/md-save` 命令，宿主用
  `ctx.fs.writeText(resolved, content, guard, undefined, policy)` 落盘。
- **宿主解析路径时必须传会话工作区作为 `cwd`**，否则相对路径会按进程工作目录解析，
  出现"写入成功但文件没变"。

### 调试信标

插件会往**自己目录**下的 `.client-beacon.log` 追加每个生命周期阶段一行
（经 `/api/md-editor/beacon` 路由）。它把"用户说界面不对"变成"我能从磁盘上读到的数字"。
开发这个插件时踩到的所有坑，整理在
[`DSH插件开发-避坑指南.md`](../DSH插件开发-避坑指南.md)。

## 第三方

见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。简言之：

- **Monaco Editor 0.52.2** —— MIT，© Microsoft Corporation（内置在 `vendor/monaco`）
- **Monaco 加载机制** —— 复用自 [yueyexiayu/dsh-bianji](https://github.com/yueyexiayu/dsh-bianji)（MIT）

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
