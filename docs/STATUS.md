# NovelPad 现状

> 本文只回答「现在是什么样」。设计动机与取舍见
> [PLAN.md](./PLAN.md)、[PLAN-UI.md](./PLAN-UI.md)、[PLAN-VERSIONING.md](./PLAN-VERSIONING.md)、
> [DESIGN.md](./DESIGN.md)。
>
> 快照时间：**2026-11-28 18:40（+08:00）**
> 代码基线：`main@5e5140d`
> 本期范围：**Windows MVP**（linux / macos 暂停）

---

## 1. 一句话

**NovelPad = 作家的 VS Code。** 以 VS Code 1.85.0 源码为底座做薄定制，功能全部由扩展承载；
Markdown 是唯一事实来源，Git 做后端但作者只看到「时间线」。

目标用户：长篇小说作者、OC / 世界观构建者、多人写作工作室。

**两条底线：**

1. 正文永远可编辑、可选、可复制，不拿编辑手感换视觉。
2. 布局常量一个都不改：活动栏 48px / 标题栏 35px / 状态栏 22px。

---

## 2. 代码地图

```
packages/
  core/        纯逻辑，零 vscode 依赖
  cli/         novelpad export / check / stats / init
  extension/   功能主体，可独立装进标准 VS Code
  theme/       设计令牌 → 宣纸 / 夜墨主题（生成器）
  schema/      角色卡 / 章节 frontmatter / 项目配置 JSON Schema
shell/         源码定制层：overlay + patches + 构建校验
docs/          计划、设计、DOM 对照、现状
examples/      demo-novel + cannian（真实 OC 语料）
.github/       Shell Build / Extension CI / Release / Track Upstream
```

### 2.1 core

| 目录 | 职责 |
|---|---|
| `parser/` `project.ts` | frontmatter、章节模型、角色卡 / 世界观解析、作品加载 |
| `rules/` | lint 引擎 + 一致性 / 伏笔 / 文本规则 |
| `export/` | TXT / DOCX、投稿 / 印刷 Profile |
| `llm/` `copilot/` | OpenAI 兼容 Provider、续写 / 改写 / 问答 / 角色卡草稿 |
| `embedding/` | 分块、向量索引、余弦检索、DashScope Rerank |
| `decision/` | 审查、续写前预判、冲突裁决、素材归类 |
| `graph/` | 关系云图模型 + 剧情链模型 |
| `version/` | Git 封装、快照、diff、批注、合并、支线、AI 分账、托管 |

### 2.2 extension

贡献点规模（`packages/extension/package.json`）：

- **55** 条命令
- **5** 个视图：章节 / 设定 / 图谱 / 批注 / 支线
- **42** 个 `configurationDefaults`
- **29** 个 `novelpad.*` 设置
- **7** 组快捷键

### 2.3 shell

```
shell/overlay/product.json                         品牌 / 应用 ID / Open VSX
shell/overlay/.../workbench.html                   L2 挂载点（一行 <link>）
shell/patches/001-menubar-toggle.patch             菜单栏默认 toggle
shell/patches/002-branding.patch                   品牌补丁
shell/scripts/apply.mjs                            overlay + patches 重放
shell/scripts/embed-extension.mjs                  把 vsix 解进壳
shell/scripts/check-*.mjs / verify-*.mjs            静态守卫
```

---

## 3. 已交付能力

| 里程碑 | 状态 | 内容 |
|---|---|---|
| M0 基建 | ✅ | monorepo、章节模型、frontmatter、示例作品 |
| M1 导出 | ✅ | TXT / DOCX、Profile、CLI（PDF 未做） |
| M2 设定库 | ✅ | 树视图、lint、补全 / 悬浮 / 双链跳转、Schema、主题 |
| M3 Copilot | ✅ | `Alt+\` 续写、改写动作、设定问答、角色卡草稿、推理可见 |
| M4 RAG | ✅ | Embedding + 增量索引 + Rerank + 决策模型审查 / 裁决 |
| M5 图谱 | ✅ | 关系云图、剧情发展链、伏笔开合 |
| M6 壳 | ✅ | 源码 overlay + 补丁 + Windows 完整构建 |
| M7 界面 | ✅ | L1~L5 全部落地：品牌、挂载点、皮肤、排版、书房 |
| M8 版本与共创 | ✅ | V1~V5 全部落地：时间线、diff、批注、支线、AI 分账、托管 |

### 3.1 创作基础

- 章节树、设定树、保存时 lint 到 Problems。
- `[[角色名]]` 补全、悬浮角色卡、双链跳转。
- 状态栏字数：当前章 / 全书。
- 导出 TXT / Word，支持 default / submission / print 三套 Profile。

### 3.2 Copilot

| 操作 | 入口 |
|---|---|
| 续写（直接） | `Alt+\` |
| 续写（带要求） | `Alt+Shift+\` |
| 润色 / 扩写 / 缩写 / 换视角 / 口语化 | 选中文字 → 灯泡 / 命令 |
| 问问设定 | 命令「Copilot 问问设定」 |
| 生成角色卡 | Problems 灯泡 → 根据正文生成 YAML 草稿 |
| 查看上次思考 | 命令「查看上次思考过程」 |

- 推理过程用小说家口吻显示，续写完成后状态栏可点开。
- API Key 存 SecretStorage，不进 `settings.json`。
- 默认 provider `custom`（`127.0.0.1:8788/v1`），模型 `deepseek-v4.1-flash`。

### 3.3 RAG 与决策

- DashScope Embedding / Rerank / 决策模型共用 `novelpad.rag.apiKey`。
- 命令：建立向量索引、检索相似场景与设定、审查本章、裁决选中冲突。
- 续写前自动检索相似段落 + 预判人物情绪 / 节奏 / 位置一致性。

### 3.4 图谱

- 关系云图：角色 / 地点 / 势力 / 物品 / 伏笔事件；设定卡 relations + 正文同场推断 + 伏笔因果。
- 剧情发展链：按出场次数选泳道，每章场景节点，伏笔埋下 / 回收。
- 纯 SVG 自绘，零依赖，只吃 `--vscode-*` 变量。

### 3.5 界面定制（M7）

| 层 | 落点 | 是否重编壳 |
|---|---|---|
| L1 品牌 | `shell/overlay/product.json` + 图标 | 是（一次） |
| L2 挂载点 | `workbench.html` 一行 `<link>` + `body.novelpad` | 是（一次） |
| L3 皮肤 | `packages/extension/media/workbench.css` | 否 |
| L4 排版 | `configurationDefaults` + 装饰 API | 否 |
| L5 视图 | 书房 / 时间线 / 图谱等 webview | 否 |
| **L0 默认值** | `shell/patches/003-shell-defaults.patch` + 扩展运行时 | 是（一次） |

- 标准 VS Code 里 `<link>` 404 静默失败 → 同一份扩展，两种外观。
- 正文霞鹜文楷随包：**97 片 woff2，约 4.4MB**，构建时校验分片与 CSS 双向一致。
- 系统 UI 优先鸿蒙黑体，缺失回退 `system-ui`（不随包分发）。
- 书房只在没有可见编辑器时打开，启动判断延迟 700ms。
- 段首缩进默认关闭（CSS 缩进会让光标定位左偏 2em）。
- 正文栏宽走上游「居中版式」+ `centeredLayoutFixedWidth`（900px ≈ 46 字），
  不用 CSS 限宽——Monaco 按容器实测尺寸排版，CSS 盖内部宽度会和每次
  layout 打架，光标点选错位。
- 中文界面：语言包随包内置（`vscode-language-pack-zh-hans` 1.85.0，
  370KB），菜单是「文件 / 编辑 / 查看」而不是 File / Edit / View。

**L0 为什么单列**：这四件事都无法由扩展在运行时解决，只能改壳的默认值或
在启动早期补文件。它们的问题形态都一样——**没有任何报错，只是看起来
「没做」**，所以每条都配了机器守卫：

| 问题 | 根因 | 修法 |
|---|---|---|
| 主题从未激活 | `contributes.themes` 只登记不设默认值，皮肤里 `var(--vscode-*)` 全取默认深色 | 扩展在壳内首次启动写 `window.autoDetectColorScheme` + 两个 preferred 主题 |
| 图标全变空方块 | UI 字体规则选中 `.monaco-workbench .part`（图标住在大容器里） | 只给真正承载文字的元素设字体，`.codicon` 显式保住图标字体 |
| 正文铺满 1900px | `wordWrap:on` 按窗口宽度换行 | 居中版式 + 固定 900px |
| **受限模式扩展不激活** | manifest 缺 `capabilities.untrustedWorkspaces`，上游默认 `supported=false` | 声明 `supported: true` |
| 首启动信任弹窗 | `security.workspace.trust.enabled` 默认 true | 补丁改默认值 false |
| 首启动英文界面 | `argv.json` 与 `languagepacks.json` 都在「读取时还不存在」 | 单一 bootstrap 补两份文件 |

### 3.6 版本管理与共创（M8）

| 能力 | 状态 |
|---|---|
| 自动存档（空闲 / 切章 / 关窗） | ✅ 每章保留 20 个 |
| 里程碑（作者「存一版」） | ✅ 推进主干 |
| 时间线（按天分组、自动存档折叠） | ✅ |
| 段落级 + 字级 diff、未变段落折叠 | ✅ |
| 编辑批注（波浪线、悬停线程、接受建议） | ✅ |
| 支线（worktree、按章并回主稿） | ✅ |
| AI 分账（撤销这次续写） | ✅ |
| GitHub 一键连接 / 备份 / 取回 | ✅ |

---

## 4. 版本管理当前实现

### 4.1 数据模型

```
refs/heads/main                    作者的主稿（托管推的就是它）
refs/novelpad/auto/<章>/<时间戳>    自动存档，每章滚动保留 20 个
refs/novelpad/milestone/<id>       里程碑，永久
refs/novelpad/publish/<tag>        发布版，永久

.novelpad/version/snapshots.json   本地索引（故意不进 git）
.novelpad/annotations.jsonl        批注（随 git 共享）
```

**索引是缓存，ref 才是真相。** 索引丢了可以从 ref 重建；换机器取回则用
`backfillFromRefs` 只补缺失项，不覆盖作者写的标签 / 备注 / 字数 / AI 来源。

### 4.2 快照

- 用临时索引（`GIT_INDEX_FILE`）+ `commit-tree`，不碰作者 HEAD / index。
- 自动存档 `parent: "none"`，一个快照一个独立根提交，滚动清理只删 ref。
- **`base` 语义**：不传 = 从空树起步，树只含本次 paths；在已有分支上追加提交必须传
  `base`，否则其余章节会从历史里消失。
- 没有 git 身份时用环境变量兜底（`GIT_AUTHOR_*`），不写仓库配置。

### 4.3 主干

- `resolveTrunk` 解析当前分支；分离 HEAD 返回 `undefined`，不硬造分支名。
- 里程碑落主干：`base = trunk.tip`、`parent = trunk.tip`。
- 主干未出生时造独立根提交，且 `paths` 强制 `["."]`。
- 推进主干用带旧值的 `update-ref`（乐观锁，`raced`），必须跟
  `reset --mixed <新> -- .`，否则 `git status` 会显示整部稿子被删。
- 内容与主干一致时不造新提交，但里程碑 ref 补挂到主干顶端，避免标签丢失。

### 4.4 托管

- 凭据顺序：SecretStorage → `gh auth token` → 作者粘 PAT。
- 一次性 `GIT_ASKPASS` + 环境变量，**绝不写 `.git/config`**。
- `push()` 必须显式 `<分支>:<分支>`，并额外推 `refs/novelpad/{milestone,publish}/*`；
  不推 `auto`。
- `ensureHostingFetch()` 把额外 refspec 写进 `remote.<name>.fetch`，否则 clone / fetch
  只取 `refs/heads/*`，时间线永远回不来。
- `pull()` 不用 `git pull`（多 refspec 会报 `Cannot fast-forward to multiple branches`），
  改为 `fetch` + `merge --ff-only`。
- 备份顺序固定：`saveNow` → `ensureRepo` → `syncTrunk` → `push`。
- 推成功但主干没前进，必须报「云端只到上一版」。
- 取回后**先 `backfillFromRefs` 再判断 `updated`**：新机器首次取回正文已最新，
  但里程碑 ref 是这次才回来的。

### 4.5 共创

- 批注锚定：quote + prefix/suffix + 偏移四级回退；失配标 `orphaned`，不静默丢失。
- 支线：`git worktree` 到作品目录外平级；建线前 `ensureBaseline`；
  本地索引写 `.git/info/exclude`，不碰作者 `.gitignore`。
- 合并粒度是**章**，冲突时人工挑选，不做文本自动合并。
- AI 标记 15 分钟 TTL、用一次即消费；撤销时只删 AI 新增段，`changed` 段一律不动。

### 4.6 必须保持的不变量

1. 快照不污染作者索引 / 暂存区 / 分支指针。
2. 在已有历史上追加提交必须带 `base`。
3. 推进主干必须 CAS + `reset --mixed`。
4. push 必须显式 refspec；里程碑 ref 必须随推。
5. 托管配置必须让 fetch 能取回 `refs/novelpad/*`。
6. pull 只快进，不自动合并。
7. 取回只补索引，不重建覆盖。
8. 任何「存了但没接上主干」都必须如实告诉作者。

---

## 5. 构建与发布

### 5.1 Shell Build

`.github/workflows/shell-build.yml`：

| Job | 内容 |
|---|---|
| `prepare` | 计算 `gulp=true/false`、生成矩阵（默认仅 windows） |
| `build-extension` | 构建并打包 `novelpad.vsix` |
| `shell` | checkout 上游 1.85.0 → overlay/patches → 依赖 → `gulp vscode-win32-x64` → 嵌入扩展 → 取语言包 → 内置语言包 → 两个默认值守卫 → zip |
| `patch-check` | 不编译，验证补丁可重放 + 13 项静态检查 |

`patch-check` 的 13 项检查：

1. 内置扩展链路
2. 验证壳默认值补丁（真跑 `git apply` + argv 模板求值，17 项）
3. 皮肤选择器
4. `configurationDefaults`（含 `capabilities.untrustedWorkspaces`）
5. 字体分片
6. 字形覆盖
7. 主题颜色完整性
8. 构建闸门（7 种事件组合）
9. workflow shell 安全性
10. workflow shell 判据自检（5 例）
11. 版本管理端到端（真实 git）
12. 产物体检判据自检（16 例合成 zip）
13. 补丁重放

**workflow shell 守卫为什么必要**：windows runner 默认 shell 是
PowerShell，不认 bash 的 `\` 续行。这类错误只有 windows job 真跑到那一步
才暴露，而前面的 gulp 编译要 30 分钟——本轮就是编译成功之后才炸在
`内置中文语言包` 上，报错是 `ParserError: Unexpected token '\'`，
与「跑一个 node 脚本」看起来毫无关系。

`shell` job 里另有 4 步与首启动默认值相关：

```
取中文语言包           从 Open VSX 取 1.85.0，sha256 校验
内置中文语言包         解压到 extensions/，生成相对路径模板
壳默认值自检判据       用真实产物做正反 3 例（证明守卫能分辨对错）
检查壳默认值           三件事都编进产物 + bootstrap 时序正确
```

**构建闸门**：只有手动触发且明确勾掉 `gulpBuild` 才走占位；
push / tag 一律真编译。`check-gate.mjs` 从 YAML 抠 bash 正文跑 7 种组合，
防止再次出现「空壳全绿」。

### 5.2 Extension CI

`.github/workflows/extension.yml`：

- windows + ubuntu：install → build → typecheck → unit tests → package vsix
- windows 再跑真实 VS Code 宿主 e2e

### 5.3 Release

`.github/workflows/release.yml`：

- tag `v*` 触发
- 构建 vsix → 等同一 ref 的 Shell Build → 下载 `NovelPad-windows` → 发 Release
- 发布说明标注「本期仅 Windows」

⚠️ 仓库至今**没有打过 tag**，这条链路尚未端到端跑通。

### 5.4 上游跟踪

`.github/workflows/upstream-track.yml`：每月 3 日检查新版；
补丁重放成功开 PR，失败开 Issue。

---

## 6. 当前状态（2026-11-28 18:40）

### 6.1 Git

| 项 | 状态 |
|---|---|
| 分支 | `main`，已推 `origin/main` |
| HEAD | `5e5140d docs: 记下批量化排查方法 + 守卫的两个环境陷阱` |
| tag | `v0.1.0-demo`（在 `94bec27`，Release 已发布） |
| 工作区 | 仅用户自己的改动（见下） |

用户自己的改动，**不要提交 / 不要动**：

- `M README.md`
- `M docs/design/mockups/lore.css`
- `D docs/design/preview/{compare,graph,lore,studio-dark,studio-light}.png`
- `D shell/scripts/shot-mockups.mjs`

### 6.2 CI

| 运行 | 提交 | 状态 |
|---|---|---|
| Shell Build `46143657915` | `1ff506b` | ✅ **success（全绿）** |
| Extension CI `46143657925` | `1ff506b` | ✅ success |
| Shell Build `46132869052` | `284c548` | ❌ failure（两个新守卫自身跑不起来，已修） |
| Shell Build `46116774493` | `0966aa4` | ❌ failure（语言包步骤 PowerShell 语法崩，已修） |
| Extension CI `46115089442` | `4af0742` | ❌ failure（测试用盘符造路径，已修） |
| Shell Build `46108630776` | `94bec27` | ✅ success（真编译，tag 触发） |
| Release `46108630738` | `94bec27` | ✅ success |

`46143657915` 的关键步骤（全部 OK）：

```
patch-check
  验证壳默认值补丁          17/17（真跑 git apply + argv 模板求值）
  检查 workflow shell 安全性  4 个 workflow 全过
  workflow shell 判据自检     8/8
  产物体检判据自检            16/16
windows
  构建（gulp vscode-win32-x64）
  取中文语言包               sha256 校验
  内置中文语言包
  壳默认值判据自检            8/8（合成夹具）
  检查壳默认值                6/6
  产物体检                   含语言包与模板两项
```

### 6.3 产物

| 产物 | 说明 |
|---|---|
| `NovelPad-1.85.0-windows.zip`（`94bec27`） | 131.4MB，已发布在 Release `v0.1.0-demo` |
| `novelpad.vsix` | 4.6MB，已发布在 Release |
| Shell 压缩包（`1ff506b`） | CI 已产出；应含语言包与首启动模板 |

### 6.4 首启动实测（本地真机，2026-11-28）

用 CDP 接运行中的窗口读真实计算值，模拟**全新安装**（删 `argv.json` +
空 `userData`），一次启动：

```
argv.json 生成且中文          ✓
languagepacks.json 生成       ✓
clp 缓存生成（真读了翻译）    ✓
扩展已激活                    ✓
界面中文 8/8 菜单             ✓  文件(F) 编辑(E) 选择(S) 查看(V) ...
无信任对话框 / 无受限横幅     ✓
主题生效 #201f1c（夜墨）      ✓
栏宽生效（2 个 margin，600px）✓
```

切换系统深浅色后界面实时跟随：`#201f1c` → `#f7f3e8`（宣纸），无需重启。

---

## 7. 验证基线

最近一次完整验证（2026-11-28 14:30）：

| 项 | 结果 |
|---|---|
| core 单测 | **422 passed / 9 skipped** |
| extension 单测 | **206 passed**（9 个文件） |
| `e2e-version.mjs` | **61 项全过**（真实 git，含 clone → 取回 → 重建时间线） |
| `probe-trunk.mjs` | **31/31**（主干 / 托管链路探针） |
| `tsc --noEmit` | core / extension / cli 均干净 |
| Windows 完整壳构建 | run `46108630776`，约 37 分钟 |
| 首启动真机（CDP） | **9/9**（见 §6.4） |
| `check-themes.mjs` | 13 项全过 |
| `verify-artifact-selftest.mjs` | **16/16** |
| `verify-patch-003.mjs` | **17/17**（含真跑 `git apply` + argv 模板求值） |
| `verify-shell-defaults-selftest.mjs` | **3/3**（未打补丁红 / 打上绿 / 改回红） |
| `check-gate.mjs` | 10/10 |
| `check-workflow-shells.mjs` | 4 个 workflow 全过（零依赖） |
| `check-workflow-shells-selftest.mjs` | **8/8**（含扫描器自身正确性） |

新增的守卫都是「先证明它能分辨对错」才接进 CI：产物体检用合成 zip 做正反
16 例，壳默认值用真实产物做正反 3 例，补丁用临时目录真跑 `git apply` 并
**抽出 argv 模板数组求值**。只会报错的守卫比没有守卫更糟。

真实模型测试默认跳过，需要显式打开：

```bash
NOVLEPAD_LLM_TEST=1
NOVLEPAD_EMBED_TEST=1
NOVLEPAD_DECISION_TEST=1
```

---

## 8. 已知限制与技术债

| 项 | 影响 | 计划 |
|---|---|---|
| 只做 Windows | linux / macos 用户暂时没有壳 | 本期不做；矩阵分支保留，手动传 `platform=linux` 或 `platform=darwin` 仍可编 |
| 无 PDF 导出 | 只有 TXT / DOCX | M9 再评估（Edge headless + Paged.js） |
| 真实模型测试默认跳过 | CI 不覆盖线上 API 行为 | 本地显式开环境变量跑 |
| 上游补丁漂移 | 每月 VS Code 更新可能冲突 | `upstream-track` 自动试重放，冲突开 Issue；现有 3 个补丁都有独立验证脚本 |
| 主题 JSON 是生成产物 | 手改会被构建覆盖 | 只改 `packages/theme/scripts/build.mjs` |
| 构建慢 | 单平台 30~60 分钟 | 日常只改扩展；壳按需构建 |
| README 里程碑清单过期 | 与实际状态不一致 | README 是用户正在改的文件，暂不动 |
| 无 OAuth / 无 CRDT | 设计取舍，不是缺陷 | 借 `gh` 登录态；共创只做批注 + 分工 |
| `novelpad-test.vsix` 过期 | 容易误用 | 以 `novelpad.vsix` 或 CI artifact 为准 |
| 语言包固定 1.85.0 | 上游升版本时翻译键可能对不上 | `fetch-language-pack.mjs` 里版本与 sha256 一起改；不匹配会当场红 |
| 首启动 bootstrap 只补不覆盖 | 作者手工改过 argv.json 后不再动它 | 有意为之：不覆盖用户选择 |
| 中文语言包只内置简体 | 繁体 / 日文用户看到英文 | 需要时按同一脚本加第二个 locale |

**已修的四个「静默失效」**（都表现为「看起来没做」，无报错）：

| 问题 | 修法 | 守卫 |
|---|---|---|
| 主题从未激活 | 壳内首次启动写 autoDetect + preferred 主题 | 首启动真机 9/9 |
| 图标变空方块 | 字体规则不再选中 `.part` 容器 | CDP 读 computed font-family |
| 正文铺满整屏 | 居中版式 + 固定 900px | CDP 数 `.centered-layout-margin` |
| 受限模式扩展不激活 | `capabilities.untrustedWorkspaces` | `verify-defaults.mjs` |

---

## 9. 下一步

按优先级：

1. **等 `46116774493` 完成**（`0966aa4`）
   - 重点看三个新守卫：`验证壳默认值补丁` / `壳默认值自检判据` / `检查壳默认值`
   - 以及产物体检里新增的语言包与模板两项
2. **下载产物做本机真机验证**
   - 本地那 9/9 是「补丁语义模拟」，CI 产物才是真编译结果，两者必须都过
   - 解压 → `NovelPad.exe --user-data-dir=<临时>` → CDP 读 lang / 菜单 /
     主题色 / margins / 信任弹窗
3. **回到功能主线**
   - 继续 M7 / M8 的界面与体验打磨
   - 用户优先级：先做软件，再解决工程问题

已完成的（本轮）：
- ✅ 主题激活、图标字体、正文栏宽
- ✅ 受限模式能力声明
- ✅ 信任机制默认关闭
- ✅ 首启动中文（语言包内置 + 双 bootstrap）

---

## 10. 常用命令

```bash
# 安装与构建
pnpm install
pnpm build
pnpm typecheck
pnpm test

# CLI
node packages/cli/dist/cli.js stats  examples/demo-novel
node packages/cli/dist/cli.js check  examples/demo-novel
node packages/cli/dist/cli.js export examples/demo-novel

# 扩展
cd packages/extension && pnpm package     # 生成 novelpad.vsix

# 壳相关静态检查（需要上游源码）
node shell/scripts/apply.mjs upstream
node shell/scripts/check-css.mjs upstream packages/extension/media/workbench.css
node shell/scripts/verify-defaults.mjs upstream packages/extension
node shell/scripts/check-fonts.mjs packages/extension/media/fonts
node shell/scripts/check-themes.mjs packages/extension
node shell/scripts/check-gate.mjs
node shell/scripts/e2e-version.mjs

# 壳默认值相关（不需上游源码，秒级）
node shell/scripts/verify-patch-003.mjs          # 补丁可落地 + argv 模板求值
node shell/scripts/fetch-language-pack.mjs .lp   # 取语言包并校验 sha256

# 拿到构建产物后（<app> = resources/app）
node shell/scripts/embed-language-pack.mjs <app> .lp/*.vsix --locale zh-cn
node shell/scripts/verify-shell-defaults-selftest.mjs <app>   # 判据自检 3 例
node shell/scripts/verify-shell-defaults.mjs <app>            # 守卫 6 项
node shell/scripts/verify-artifact.mjs NovelPad-*.zip --expect-flat
node shell/scripts/verify-artifact-selftest.mjs               # 判据自检 16 例

# e2e（真实 VS Code 宿主）
node packages/extension/scripts/e2e.mjs
NOVLEPAD_LLM_TEST=1 node packages/extension/scripts/e2e.mjs
```

改上游补丁的正确流程（**不要手写 hunk 头**）：

```bash
node shell/scripts/make-patch-003.mjs    # 从真实上游生成 003
node shell/scripts/verify-patch-003.mjs  # 真跑 git apply + 语义检查
```

hunk 头是手算的，数错一个数字就报 `corrupt patch`；更隐蔽的是「数对了但
上下文少一行」——那会变成一个能 apply 却把代码改错位置的补丁。所以 003
由脚本生成，源头只有 `make-patch-003.mjs`。

本机注意：

- PowerShell 会破坏中文与引号：改文件用编辑工具，一次性脚本写成 `.mjs` 再执行。
- 提交信息走文件：`git commit -F msg.txt`。内联 `-m` 里带 `"C:\"` 这类内容
  会被 PowerShell 解析坏（实测报 `fatal: Invalid path '/fake'`）。
- vitest 在本机建议 `--pool=forks --poolOptions.forks.singleFork=true`。
- core 全量测试约 225 秒。
- 改 core 导出后先 `pnpm --filter @novelpad/core run build`，再跑 extension typecheck。
- 单测里**不要**用 `path.join("C:", ...)` 造路径：Windows 上是盘符，Linux 上
  只是普通目录名，`path.join` 会把它当相对路径拼，同一个测试两个平台结果不同
  （CI 就这样红过一次）。用 `os.tmpdir()`。
- 真机验证靠 CDP，不靠截图：这台机器上终端窗口会盖住 NovelPad，截屏拿到的是
  终端。用 `Page.captureScreenshot`，它截的是渲染器自己的画面。
- 连 CDP 用 `http.request` + `127.0.0.1`，不要用 `fetch`：undici 在慢启动场景下
  会报 `fetch failed` / `ECONNREFUSED`，而同端口的 `http` 请求是通的。
- 杀进程后要等它真的消失再启动：Electron 单实例锁未释放时新进程会直接退出，
  表现为端口永远不开。
- **改运行时的 `workbench.desktop.main.js` 会让完整性校验红掉**，弹「安装似乎
  损坏」。真实构建里补丁在 gulp 之前应用、checksums 在编译之后计算，不会出现。
- 守卫脚本**不要依赖 node_modules**：`patch-check` 为了秒级出结果，把所有
  静态检查放在 `pnpm install` 之前。用 js-yaml 解析 workflow 就栽在这上面
  （报「找不到 js-yaml」）。需要的话手写极简扫描器，或把这一步挪到 install 之后。
- 守卫的**夹具不要拿构建产物**：CI 产物是打过补丁的，而自检常要断言
  「未打补丁必须红」。用合成的最小夹具，几十行假文件就够，且完全确定。
- **同一个判据在不同层写法不同**，比如 locale：源码是 `'\t"locale": "zh-cn",'`、
  编译产物是 `"\t\"locale\": \"zh-cn\","`、argv.json 成品是 `"locale": "zh-cn"`。
  判据要认全三种，否则在真实产物上永远红——而这个漏洞只有在守卫真被跑到
  时才暴露。

### 排查方法：先批量，再统一修

连续踩了多次「修一处坏一处」，都是因为在 CI 上逐个试（一次 35 分钟）。
正确做法是**先把可能原因全列出来一次性验证**：

1. 把失败步骤的日志一次抓全，不要一次只看一条报错
2. 对每个失败项问「这个脚本在 CI 环境里和本地有什么不同」——
   依赖？路径？平台？产物状态？（本轮四个可能原因里有两个就是「产物状态」）
3. 本地造出**与 CI 相同的环境**再验证：无 `node_modules`、已打补丁的产物、
   空 userData。造不出来就先别推
4. 修完跑一遍**全量回归**（所有守卫一起跑），别只跑刚改的那个
5. 提交信息里写清「为什么会出现这类问题」，不只是「改了什么」

---

## 11. 关键文件索引

| 想改什么 | 看哪里 |
|---|---|
| 产品计划 / 里程碑 | `docs/PLAN.md` |
| 界面五层 / 书房 / 字体 | `docs/PLAN-UI.md` |
| 版本管理 / 共创 / 托管 | `docs/PLAN-VERSIONING.md` |
| 颜色 / 字体 / 组件规范 | `docs/DESIGN.md` |
| 皮肤选择器对照 | `docs/design/dom-map.md` |
| 主题颜色 | `packages/theme/scripts/build.mjs` |
| 扩展入口 | `packages/extension/src/extension.ts` |
| 版本接入层 | `packages/extension/src/features/version.ts` |
| 托管接入层 | `packages/extension/src/features/host.ts` |
| 时间线视图 | `packages/extension/src/views/timeline.ts` |
| 书房视图 | `packages/extension/src/views/studio.ts` |
| git 内核 | `packages/core/src/version/repo.ts` |
| 快照 / 主干 / 索引 | `packages/core/src/version/snapshot.ts` |
| 推送 / 拉取 / 远端 | `packages/core/src/version/remote.ts` |
| 壳 overlay | `shell/overlay/` |
| 补丁 | `shell/patches/`（003 由 `make-patch-003.mjs` 生成，别手改） |
| 壳默认值（信任 / 语言 / bootstrap） | `shell/patches/003-shell-defaults.patch` |
| 壳默认值的守卫 | `shell/scripts/verify-shell-defaults.mjs` |
| 补丁生成器 | `shell/scripts/make-patch-003.mjs` |
| 语言包下载 / 内置 | `shell/scripts/fetch-language-pack.mjs`、`embed-language-pack.mjs` |
| 皮肤 L3 | `packages/extension/media/workbench.css` |
| 主题激活 / 栏宽 | `packages/extension/src/features/shell-theme.ts`、`measure.ts` |
| 扩展能力声明 | `packages/extension/package.json` 的 `capabilities` |
| 构建流程 | `.github/workflows/shell-build.yml` |
| 发布流程 | `.github/workflows/release.yml` |
