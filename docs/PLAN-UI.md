# M7 · 主界面深度定制（壳）

> 一句话：**壳只出一个挂载点，皮肤和排版全部由扩展提供**——改视觉不需要重编 44 分钟的 VS Code。
>
> 目标形态见 `docs/design/mockups/studio.html` / `studio-dark.html`；令牌见 `docs/DESIGN.md`。

---

## 1. 先划清「能改」与「不值得改」

深度定制最大的坑是把上游 CSS 整文件覆盖：丢上游规则、每次上游更新重做一遍。
所以先按**可控性**分档，只在前两档投入。

| 元素 | 可控性 | 手段 |
|---|---|---|
| 颜色 / 边框 / 圆角 / 阴影 | ✅ 完全 | 主题 JSON（已有 155 键）+ CSS 变量 |
| 字体 / 字号 / 行高 / 字距 / 内边距 | ✅ 完全 | CSS + 编辑器设置 |
| 自绘图标（活动栏、树视图） | ✅ 完全 | 我们贡献的 `svg` 资源 |
| 元素的**增删**（标题栏加字数、侧栏加页脚） | ⚠️ 间接 | 状态栏项 / 视图 `viewsWelcome` / 自绘 webview；真增删要 patch |
| 活动栏宽度（48px）、标题栏高度（35px）、状态栏高度 | ❌ | 是 TS 里的 layout 常量，改就得 patch |
| 内核菜单项（终端 / 调试 / 源控制） | ❌ 配置级不可 | 只能 `window.menuBarVisibility: hidden` 整体隐藏 |

**决策**：布局常量一个都不改。为 4px 宽度去维护一个 TS 补丁不划算，且会随上游 layout 重构而碎。
视觉差异靠**留白、分割线、字体、色彩**做出来——这也是 `DESIGN.md` 的原则（工具退后）。

---

## 2. 四层结构

| 层 | 落点 | 内容 | 重编壳 |
|---|---|---|---|
| **L1 品牌** | `shell/overlay/product.json` + `resources/win32/*.ico` | 名称、应用 ID、协议、Open VSX、图标 | 是（一次） |
| **L2 挂载点** | `shell/overlay/.../workbench.html` | 一行 `<link>`、`<body class="novelpad">` | 是（一次） |
| **L3 皮肤** | `packages/extension/media/workbench.css` | 全部视觉规则 | **否** |
| **L4 排版** | 扩展：`configurationDefaults` + `TextEditorDecorationType` | 正文排版、标题、场景分隔、批注 | 否 |
| **L5 视图** | 扩展：webview / tree | 书房首页、稿本时间线、图谱 | 否 |

L3 起全部走扩展，**日常调样式只 `pnpm build` + 重载窗口，秒级**。

---

## 3. L2：唯一需要改的上游 HTML

`src/vs/code/electron-sandbox/workbench/workbench.html`（1.85.0，静态 73 行，改动频率极低）。

在 `</head>` 前插入：

```html
<link rel="stylesheet" href="../../../../../extensions/novelpad/media/workbench.css">
```

路径推导（运行时布局）：

```
resources/app/out/vs/code/electron-sandbox/workbench/workbench.html
  ..                  → electron-sandbox
  ../..               → code
  ../../..            → vs
  ../../../..         → out
  ../../../../..      → app          ← 五级
  extensions/novelpad/media/workbench.css
```

`extensions/novelpad` 由 `shell/scripts/embed-extension.mjs` 保证存在。
标准 VS Code 里这个链接 404——**静默失败，不影响使用**，正好实现「同一份扩展，两种外观」。

`<body>` 加 class 便于作用域隔离：

```html
<body class="novelpad" aria-label="">
```

**CSP 风险与验证**：现策略为 `style-src 'self' 'unsafe-inline'`、`font-src 'self' ...`。
上游 CSS 是 loader 用 `<style>` 注入的，没有同源 `<link>` 的先例。
首次接入后必须在壳里开 DevTools 确认：

```js
document.styleSheets.length                      // 是否多出一张
[...document.styleSheets].some(s => s.href?.includes('novelpad'))
document.fonts.check('19px "LXGW WenKai Screen"') // 字体是否真加载
```

被拦的话，二选一（按优先级）：
1. 在 overlay 的 CSP 里给 `style-src` / `font-src` 加 `file:`（一行，风险可控）；
2. 构建期由 `apply.mjs` 把 `workbench.css` 内联进 `<style>`（放弃热更新，但零 CSP 风险）。

---

## 4. L3：皮肤清单

`packages/extension/media/workbench.css`，只用两样东西：**主题变量**（`--vscode-*`）+ **高特异性选择器**。
禁止 `!important` 堆叠；必须覆盖时用 `:is()` 提升特异性。

| # | 目标 | 做法 |
|---|---|---|
| 1 | 正文纸感 | `--vscode-editor-background` 已由主题给出；补 `editor.lineHighlightBackground` 极淡、`editor.selectionBackground` 半透明青 |
| 2 | 侧栏退后 | 侧栏标题栏去掉全大写/加字距、`letter-spacing: .04em`；分组头加 1px 下划分割线 |
| 3 | 活动栏 | 48px 不动；图标 22px、选中态左侧 2px 青条（`activityBar.activeBorder` 已是青）、底部留白 |
| 4 | 标签页 | 去圆角、去阴影、激活页签顶部 2px 青线；未激活页签 `opacity: .72` |
| 5 | 状态栏 | 高度不动；字号 12px、`font-variant-numeric: tabular-nums`（字数不跳动） |
| 6 | 面板 / 输入框 | 圆角 6px、边框 1px、focus 只换边框色不加外发光 |
| 7 | 滚动条 | 宽 10px、无箭头、滑块半透明，hover 加深 |
| 8 | 通知 / 弹窗 | 圆角 10px、`box-shadow: 0 4px 16px rgba(...,.12)`（对应 `--shadow-pop`） |
| 9 | 命令面板 | 居中偏上（`top: 12vh`）、宽 640px、结果行高 26px |
| 10 | Markdown 预览 | 与编辑器同字体同栏宽；`h1` 26px、段距 1.2em、引用左侧 2px 青线 |

> 选择器以**运行时 DOM 实测**为准，不凭记忆写死。做法：壳里 DevTools → Elements → 复制选择器 → 写进 CSS → 截图对比 mockup。
> 建议把一个 `docs/design/dom-map.md` 逐步补全（元素 → 选择器 → 是否稳定），上游升级时只查这张表。

---

## 5. L4：排版——作家真正感知的「深度定制」

VS Code 的 Markdown 编辑器是等宽代码编辑器，直接用来写小说有三个硬伤：无首行缩进、标题与正文同字号、场景分隔看不出节奏。
全部可以在扩展侧解决，不动壳：

### 5.1 设置级（零风险，先做）

`contributes.configurationDefaults`（扩展即可贡献全局默认值，无需 patch）：

```jsonc
{
  "editor.fontFamily": "'LXGW WenKai Screen', 'LXGW WenKai', 'Kaiti SC', 'STKaiti', 'KaiTi', serif",
  "editor.fontSize": 19,
  "editor.lineHeight": 2.0,
  "editor.letterSpacing": 0.4,
  "editor.lineNumbers": "off",
  "editor.minimap.enabled": false,
  "editor.folding": false,
  "editor.renderLineHighlight": "none",
  "editor.glyphMargin": false,
  "editor.cursorSurroundingLines": 6,        // 打字机滚动
  "editor.wordWrap": "on",
  "editor.wrappingIndent": "none",
  "editor.quickSuggestions": { "other": false, "comments": false, "strings": false },
  "workbench.startupEditor": "none",
  "workbench.activityBar.location": "default",
  "workbench.editor.showTabs": "single",
  "workbench.editor.tabSizing": "shrink",
  "workbench.tree.indent": 14,
  "window.menuBarVisibility": "hidden",
  "window.commandCenter": false,
  "window.title": "${activeEditorShort} · NovelPad",
  "breadcrumbs.enabled": false,
  "explorer.compactFolders": false
}
```

只对 Markdown 生效的项用语言级覆盖：`"[markdown]": { ... }`。

### 5.2 装饰级（P1，需实测 1.85 DOM）

`TextEditorDecorationType` 的 `textDecoration` 字段会被写进装饰元素的 `style`，可注入任意 CSS——业界常用做法，但属于半公开行为。

| 效果 | 实现 | 风险 |
|---|---|---|
| 段首缩进 2em | 整行装饰 + `textDecoration: 'none; padding-left: 2em;'` | 中：上游改渲染结构即失效，需降级 |
| 一级标题 26px / 居中 | `textDecoration: 'none; font-size: 26px; font-weight: 600;'` | 中 |
| 场景分隔 `***` 变留白 | 整行装饰 `color: transparent` + `padding: 1.2em 0` | 低 |
| 作者备注 `<!-- -->` 变淡 | `color: var(--vscode-disabledForeground)` | 低 |
| 双链 `[[角色]]` 着色 | `color: accent; textDecoration: underline dotted` | 低 |

失败降级：只用「颜色 + 行高 + 全局字号」，不碰 `font-size`。**永远保证正文可编辑、可选、可复制。**

### 5.3 专注模式

命令 `novelpad.focusMode`：`workbench.action.toggleZenMode` + 记录/恢复布局 + `cursorSurroundingLines` 提到 12 + 渲染 36em 栏宽（`workbench.action.toggleCenteredLayout`）。
不做自研编辑器——Monaco 的输入法、撤销栈、多光标是花了十年打磨的，重写一遍不现实。

> 自研「稿纸编辑器」（ProseMirror）只在 M9+ 作为**可选沉浸模式**评估，不进主线。

---

## 6. L5：书房（替代 Welcome 页）

不上补丁。启动时判断「没有可见编辑器 + 非恢复会话」→ 打开 webview：

```
onStartupFinished
  → 若 window.tabGroups.all 全空 且 config.novelpad.openStudioOnStartup
  → 打开 "NovelPad 书房"（WebviewPanel，ViewColumn.One）
```

内容（复用 `views/graph.ts` 的自绘范式，零依赖）：

- 左：最近作品卡片（封面用首字 + 卷名，不生成图片）
- 右：今日字数环形进度 / 本周曲线（SVG）
- 下：待回收伏笔（`due` 已过）、未完成的章节（`status: draft`）
- 底：新建 / 打开 / 导入 `.npbundle`

Webview 只在「无编辑器」时出现，一旦打开文件就 `dispose`，不占资源。

---

## 7. 字体

| 用途 | 字体 | 分发 |
|---|---|---|
| 正文 | 霞鹜文楷 Screen（`LXGW WenKai Screen`） | OFL，**随包** |
| UI | 鸿蒙黑体 → 退 `system-ui` | 不可分发，仅优先匹配本地已装 |
| 代码 / YAML | JetBrains Mono → `Cascadia Code` → `Consolas` | 不随包 |

**随包方案**：woff2 放 `packages/extension/media/fonts/`，`@font-face` 写在 `workbench.css` 里用相对路径（与上游 codicon 同一机制，`font-src 'self'` 足够）。
只取 Regular + Bold 两个字重，按 `unicode-range` 分片；总量控制在 12MB 内。
超了就退「首次启用时下载到 `globalStorage` + 提示安装到系统字体」——但优先随包，离线可用是写作软件底线。

---

## 8. 验收

- [ ] 四个区域（活动栏 / 侧栏 / 编辑器 / 状态栏）与 `studio.html` 对照，色值、字号、间距逐项核对
- [ ] 深浅两套切换不闪、不丢样式；高对比度主题下不破版
- [ ] DevTools 无 CSP 报错；`document.fonts.check('19px "LXGW WenKai Screen"') === true`
- [ ] 冷启动到可输入 < 3s（字体不阻塞首屏：`font-display: swap`）
- [ ] 移除扩展目录后，壳仍能作为普通编辑器启动（皮肤 404 静默）
- [ ] 上游升级到下一个 tag 后，`patch-check` 仍绿（L2 只有一个文件）

## 9. 工作量

| 项 | 人日 |
|---|---|
| L2 挂载点 + CSP 验证 + 图标 | 0.5 |
| L3 皮肤（10 项 + DOM 测绘） | 2 |
| L4 设置 + 装饰排版 | 2 |
| L5 书房 | 2 |
| 字体接入与体积优化 | 0.5 |
| 截图回归 + 上游兼容验证 | 1 |
| **合计** | **8** |