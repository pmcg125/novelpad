# DOM 对照表（VS Code 1.85.0）

> 用途：L3 皮肤（`packages/extension/media/workbench.css`）与 L5 视图改动前，先在这里查选择器。
> 「稳定性」判断依据：该选择器在上游是否有对应 CSS 规则、是否被 TS 代码直接 `setClassName` 写死。
>
> 核证方式：本地 1.85.0 源码全文检索（`src/vs/**/*.{ts,css}`），并用
> `shell/scripts/check-css.mjs` 做「我们用的选择器 vs 上游 CSS 是否存在」的自动比对。
>
> **稳定**：上游 CSS 里有明确规则或 TS 里写死类名，小版本内基本不会变。
> **中等**：结构稳定但类名是内部命名，可能随重构调整。
> **脆弱**：依赖 DOM 层级顺序或纯内部实现，上游一动就失效——尽量别用。

---

## 1. 工作台骨架

| 元素 | 选择器 | 稳定性 | 说明 |
|---|---|---|---|
| 工作台根 | `.monaco-workbench` | 稳定 | 所有皮肤规则的命名空间 |
| 活动栏 | `.monaco-workbench .part.activitybar` | 稳定 | `activitybarpart.css`；`width: 48px` 是上游常量 |
| 活动栏内容区 | `.activitybar > .content > .composite-bar` | 稳定 | `margin-bottom: auto` |
| 活动栏条目 | `.activitybar .action-item` / `.action-item.checked` | 稳定 | 选中态靠 `.checked` |
| 侧栏 | `.monaco-workbench .part.sidebar` | 稳定 | `sidebarpart.css` |
| 侧栏标题 | `.part.sidebar > .title > .title-label h2` | 稳定 | 上游给了 `text-transform: uppercase`（对中文无效） |
| 侧栏视图分组头 | `.monaco-workbench .viewlet .collapsible.header .title` | 稳定 | `sidebarpart.css` |
| 状态栏 | `.monaco-workbench .part.statusbar` | 稳定 | `height: 22px; font-size: 12px` |
| 状态栏条目 | `.part.statusbar > .items-container > .statusbar-item > .statusbar-item-label` | 稳定 | `padding: 0 5px` |
| 编辑器区 | `.monaco-workbench .part.editor > .content` | 稳定 | |
| 标题栏 | `.monaco-workbench .part.titlebar` | 稳定 | 仅在 `window.titleBarStyle: custom` 时存在 |
| 菜单栏 | `.part.titlebar > .titlebar-container > .titlebar-left > .menubar` | 稳定 | `titlebarpart.css` |
| 命令中心 | `.part.titlebar > .titlebar-container > .titlebar-center > .command-center` | 稳定 | `window.commandCenter` 控制显隐 |

## 2. 标签页

| 元素 | 选择器 | 稳定性 | 说明 |
|---|---|---|---|
| 标签条 | `.part.editor > .content .editor-group-container > .title .tabs-container` | 稳定 | |
| 单个标签 | `... .tabs-container > .tab` | 稳定 | |
| 激活标签 | `... > .tab.active` | 稳定 | |
| 激活标签顶部描边容器 | `... > .tab.active.tab-border-top > .tab-border-top-container` | 中等 | 上游用 1px 高的 div 画顶部线；我们改成 2px |
| 单页签标题 | `.part.editor > .content .editor-group-container > .title > .label-container > .title-label` | 中等 | `workbench.editor.showTabs: single` 时的标题区 |

> 标签条的显示形态由 `workbench.editor.showTabs`（`multiple` / `single` / `none`）决定，
> 键定义在 `workbench/services/layout/browser/layoutService.ts` 的 `EDITOR_TABS_MODE`。
> **不要**用 CSS 去隐藏标签条——那是布局常量，会让面包屑、编辑器操作位置一起错位。

## 3. 列表与树

| 元素 | 选择器 | 稳定性 | 说明 |
|---|---|---|---|
| 树容器 | `.customview-tree` | 稳定 | `views.css`，TS 里 `setClassName('customview-tree')` |
| 树行 | `.customview-tree .monaco-list .monaco-list-row` | 稳定 | |
| 树行内容 | `.customview-tree .monaco-list-row .custom-view-tree-node-item` | 稳定 | |
| 选中行 | `... .monaco-list-row.selected` | 稳定 | |
| 可折叠节点 | `.monaco-tl-contents.align-icon-with-twisty` | 中等 | 是否有 twisty 图标决定类名 |

## 4. 输入框、面板、弹层

| 元素 | 选择器 | 稳定性 | 说明 |
|---|---|---|---|
| 命令面板 / quick input | `.quick-input-widget` | 稳定 | `width: 600px; margin-left: -300px`，居中靠负 margin |
| 命令面板列表项 | `.quick-input-widget .quick-input-list .quick-input-list-entry` | 稳定 | |
| 命令面板分组标题 | `.quick-input-list .quick-input-list-separator` | 稳定 | |
| 通知容器 | `.monaco-workbench > .notifications-toasts .notification-toast-container` | 稳定 | |
| 单条通知 | `... .notification-toast-container > .notification-toast` | 稳定 | `border-radius: 4px` |
| 滚动条 | `.monaco-scrollable-element > .scrollbar` | 稳定 | 粗细由 `editor.scrollbar.*Size` 设置控制 |

## 5. 编辑器本体（Monaco）

| 元素 | 选择器 | 稳定性 | 说明 |
|---|---|---|---|
| 编辑器根 | `.monaco-editor` | 稳定 | |
| 当前行 | `.monaco-editor .view-overlays .current-line` | 稳定 | **没有** `current-line-exact` 这个类名 |
| 边栏当前行 | `.monaco-editor .margin-view-overlays .current-line` | 稳定 | |
| 折叠图标 | `.monaco-editor .margin-view-overlays .codicon-folding-*` | 中等 | 上游本就是 `opacity: 0`，悬停才现 |
| 行号 | `.monaco-editor .margin-view-overlays .line-numbers` | 稳定 | 显示与否由 `editor.lineNumbers` 控制 |

> **不要用 CSS 控制编辑器排版。** 字号、行高、字距、行号、折叠、当前行高亮
> 全部走 `editor.*` 设置（见 `configurationDefaults`）。CSS 改这些会和 Monaco 的
> 测量逻辑打架，导致光标位置偏移。

## 6. 高对比度

`.hc-black` / `.hc-light` 挂在 **`.monaco-workbench`** 上，不在 `<body>`。

```css
/* 正确 */
:is(.novelpad) :is(.hc-black, .hc-light) .某元素 { ... }

/* 错误：永远匹配不到 */
:is(.novelpad) .某元素 { ... } /* 指望 body 上有 hc 类 */
```

## 7. Markdown 预览（webview，独立作用域）

预览跑在 webview 里，`workbench.css` **到不了**。主题类名也不同：

| 环境 | 主题类挂在哪 | 类名 |
|---|---|---|
| 工作台 | `.monaco-workbench` | `.hc-black` / `.hc-light` / `.vs-dark` / `.vs` |
| webview（预览） | `<body>` | `.vscode-high-contrast` / `.vscode-high-contrast-light` / `.vscode-dark` / `.vscode-light` |

| 元素 | 选择器 | 稳定性 |
|---|---|---|
| 预览正文容器 | `.markdown-body` | 稳定（`markdownDocumentRenderer.ts`） |
| 预览 body | `body.vscode-body` | 稳定 |

排版规则写在 `packages/extension/media/markdown-preview.css`，
通过 `contributes["markdown.previewStyles"]` 注入。

## 8. 自维护的类名（我们自己的）

这些类名由 NovelPad 生成，可以自由改：

| 类名 | 出处 |
|---|---|
| `body.novelpad` | `shell/overlay/src/vs/code/electron-sandbox/workbench/workbench.html`，L2 挂载点 |
| `--novelpad-*` CSS 变量 | `workbench.css` 第 1 节 |

`body.novelpad` 是「壳」与「标准 VS Code」的唯一区分点：
壳里存在 → 皮肤生效；标准 VS Code 里 `workbench.css` 的 `<link>` 404 → 静默失效。

## 9. 自动核对

```bash
# 我们用的选择器是否真实存在于上游 CSS
node shell/scripts/check-css.mjs <upstream 源码根> packages/extension/media/workbench.css

# 字体分片完整性
node shell/scripts/check-fonts.mjs packages/extension/media/fonts
```

新增皮肤规则前先跑一次，避免写下永远不会生效的选择器。