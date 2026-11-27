# NovelPad 开发计划

> 把编程开发的工具链（版本控制、Lint、类型系统、CI、Copilot）搬到小说 / OC / 世界观创作中，
> 打造以 **VS Code 源码深度定制为底座**、以 **Markdown 为唯一事实来源**、以 **Novel Copilot + 知识图谱** 为核心竞争力的创作 Studio。

---

## 1. 愿景与定位

**一句话定位**：作家的 VS Code——写小说像写代码一样工程化，且比通用 IDE 更懂「设定」。

**目标用户**：长篇小说作者（尤其网文作者）、OC / 世界观构建爱好者、写作工作室（多人协作）。

**核心差异化**：
1. 文件即数据，Git 原生版本控制（分支写另一种结局、diff 对比两稿）
2. 设定即代码：角色卡 / 世界观是结构化数据，正文写作时实时「类型检查」
3. Novel Copilot：懂你的设定库的 AI 续写 / 润色 / 问答，不串戏、不 OOC
4. 知识图谱：角色关系云图、事件因果链、剧情发展链，伏笔可视可追踪
5. 投稿级导出：TXT / Word / PDF 一键多格式导出，配置档适配各平台投稿格式

---

## 2. 路线决策：源码定制 vs 纯扩展

| 维度 | 纯扩展（标准 VS Code 上开发） | 源码定制（fork microsoft/vscode） |
|---|---|---|
| 启动成本 | 极低 | 高（源码 ~1.4GB，首次构建 30~60 分钟） |
| UI 控制力 | 受限（活动栏、标题栏、Welcome 页不可改） | 完全可控（品牌、布局、默认设置、欢迎页、图标主题） |
| 上游更新 | 自动跟随，零成本 | 每月合并，需维护补丁集 |
| 商标/市场 | 无 | 受微软商标政策约束：**不得使用 VS Code 名称/Logo，不得接入微软 Marketplace**，需换 Open VSX |
| 适用阶段 | 功能验证期 | 产品化 / 发行期 |

### 最终策略：**壳与功能分离——薄定制层 + 插件化功能**

```
┌──────────────────────────────────────────────────┐
│  NovelPad（发行产品）= 定制 VS Code 壳              │
│  ├─ 品牌 / 名称 / Logo / 产品 ID（product.json）     │
│  ├─ 写作专属默认配置 Profile（衬线字体、专注模式）      │
│  ├─ Welcome / 快速入门引导                          │
│  ├─ 默认隐藏开发者向 UI（调试/测试视图/终端）          │
│  ├─ 预装 NovelPad 扩展包                           │
│  └─ Open VSX 扩展市场 + 自有更新源                 │
├──────────────────────────────────────────────────┤
│  NovelPad 扩展包（全部功能，可独立装到标准 VS Code）   │
│  ├─ 章节模型 / 设定库 / 导出 / Copilot / RAG / 图谱  │
│  └─ 开发期：F5 在标准 VS Code 中调试，零源码构建依赖  │
└──────────────────────────────────────────────────┘
```

**收益**：
- 日常开发 95% 时间在写扩展，不碰源码，编译秒级反馈
- 发版时用脚本把补丁应用到上游源码 → 构建出 NovelPad 发行版
- 一举两得：扩展可先发布到 Open VSX 给标准 VS Code 用户用，收集反馈后导流到定制版

---

## 3. 源码定制层（壳）具体改什么

> 原则：**能不改源码就不改**。优先用 `product.json` + 默认设置 + 扩展实现；只有扩展 API 做不到的才进补丁集。

### 3.1 无需改源码（配置级）
- `product.json`：`nameShort` / `nameLong` / `applicationName` / `dataFolderName` / `urlProtocol` / 图标 / 颜色主题
- 预置 `settings.json` 默认值：编辑器字体（霞鹜文楷 / 思源宋体）、关闭行号/小地图、开启打字机模式、字数统计
- 预装扩展列表（`extensionKind` + 内置 `extensions/` 目录）
- 自定义图标主题 + 配色主题（`.tmTheme` / `.json`）

### 3.2 轻度补丁（低维护成本）
- Welcome 页改为 NovelPad 引导（新建作品 / 打开作品 / 导入）
- 默认布局：活动栏固定「章节 / 设定 / 大纲 / 图谱 / Copilot」五个视图容器
- 隐藏菜单项：终端、调试、源控制菜单中开发者向的条目（通过 `menus` 贡献点 + `when` 子句尽量在扩展层做）

### 3.3 重度定制（后期按需）
- 自定义编辑器外观：段落间距、首行缩进渲染、专注模式写作皮肤
- 内置 Webview 面板的深度样式统一

### 3.4 补丁维护流程
```
upstream (microsoft/vscode release/x.y.z)
   │  git subtree / remote fetch
   ▼
novelpad-shell 仓库
   │  patches/ 目录：每个补丁一个 .patch 文件 + 说明
   │  scripts/apply-patches.ps1：按顺序重放，冲突即失败并提示
   ▼
CI：每个上游大版本自动尝试应用补丁 → 生成报告
```

---

## 4. 仓库结构（pnpm monorepo）

```
NovelPad/
├── docs/                       # 计划、设计、ADR
├── packages/
│   ├── core/                   # 纯逻辑，零 vscode 依赖（可复用到 CLI / Web）
│   │   ├── parser/             # Markdown + frontmatter 解析、章节模型
│   │   ├── indexer/            # 设定库索引、中文实体识别（Aho-Corasick）
│   │   ├── rules/              # lint 规则（可插件化）
│   │   ├── exporter/           # txt / docx / html / pdf 生成
│   │   ├── embedding/          # EmbeddingProvider（本地 ONNX / OpenAI 兼容）
│   │   ├── vector/             # SQLite + sqlite-vec 向量库
│   │   ├── graph/              # 实体/关系/事件模型、构建器、LLM 抽取
│   │   ├── rag/                # 检索器：实体识别→图查询+向量检索→上下文包
│   │   └── llm/                # LLM Provider 抽象（OpenAI 兼容协议，覆盖 DeepSeek/GLM/Ollama）
│   ├── extension/              # VS Code 扩展（功能主体）
│   │   ├── views/              # 树视图：章节 / 角色 / 世界观 / 大纲 / 伏笔
│   │   ├── editors/            # 自定义编辑器：角色卡表单 ↔ YAML
│   │   ├── webviews/           # 云图（G6）/ 剧情链 / 时间线 / 看板
│   │   ├── copilot/            # InlineCompletion / Chat Participant / Code Actions
│   │   ├── diagnostics/        # 诊断、CodeLens、补全、悬浮
│   │   └── commands/           # 导出、索引、图谱更新等命令
│   ├── lsp/                    # （可选后期）独立语言服务器，把 lint 抽出扩展
│   ├── cli/                    # novelpad export / check / index（CI 可用）
│   └── schema/                 # 角色卡、世界观条目 JSON Schema
├── shell/                      # 源码定制层
│   ├── product/                # product.json 覆盖、主题、图标
│   ├── patches/                # 上游源码补丁集
│   └── scripts/                # 拉取 / 应用补丁 / 构建发行版
└── examples/                   # 示例作品（用于测试与演示）
```

---

## 5. 数据模型：文件即数据

作品 = 一个文件夹，全部纯文本，Git 友好：

```
my-novel/
├── .novelpad/
│   ├── config.json             # 项目配置（导出 profile、模型配置等）
│   ├── index/                  # 向量索引（gitignore，可重建）
│   └── graph/                  # LLM 抽取结果 JSON（可 diff、可人工编辑）
├── outline/                    # 大纲 Markdown
├── chapters/                   # 正文：一章一文件 + frontmatter
│   ├── 001.md
│   └── 002.md
├── characters/*.yaml           # 角色卡（属性、关系、状态）
├── world/                      # 世界观条目 Markdown
└── .git/
```

**章节 frontmatter**：
```yaml
---
title: 第一章 雨夜
order: 1
pov: 林晚
status: draft        # draft / revision / final
characters: [林晚, 沈默]
locations: [旧城区]
foreshadows: [{ id: fs-umbrella, due: 12 }]
---
```

**正文约定**：GFM；`***` 场景切换；`[[角色名]]` 双链引用设定；`<!-- -->` 作者备注（导出时剔除）。

---

## 6. 功能模块设计

### 6.1 导出流水线
- 入口：`novelpad export --profile <name> --format txt|docx|pdf`
- 三段：收集（按 order 合并）→ 转换（中间表示）→ 渲染
- TXT：去 Markdown 标记、段首全角两格、章节标题格式化
- DOCX：`docx`（纯 JS）直接生成；进阶 pandoc `--reference-doc`
- PDF：Edge headless + Paged.js（Windows 自带，中文排版好）；备选 xelatex
- Profile：起点 / 晋江投稿格式、实体书、简洁稿

### 6.2 设定库与一致性检查
- 角色卡 YAML 走 JSON Schema 校验
- Lint 规则（可插件化，参考 ESLint 架构）：
  - 角色属性冲突（发色 / 瞳色 / 称谓）
  - 时间线冲突（角色不该在场 / 不该知晓的信息）
  - 伏笔到期未回收（`foreshadows.due` 已过）
  - 名词拼写不一致
- 输出到 Problems 面板 + CodeAction 一键修复

### 6.3 Novel Copilot
- **续写**：`InlineCompletionItemProvider`，上下文 = 当前章 + 上章摘要 + 出场角色卡 + 文风样本 + RAG 结果
- **编辑动作**：选中 → 润色 / 扩写 / 缩写 / 换视角 / 口语化，diff 预览后应用
- **Chat `@novelpad`**：带工具（查角色卡 / 列伏笔 / 某角色首次出场章节 / 某段情节前因）
- **Provider 抽象**：OpenAI 兼容协议一套实现覆盖 DeepSeek / GLM / Qwen / Ollama；另适配 `vscode.lm`

### 6.4 Embedding 与向量检索
- 默认本地：`bge-small-zh-v1.5` ONNX（Transformers.js，worker 线程），可切 `bge-m3`
- 可选 API：OpenAI 兼容 `/v1/embeddings`
- 分块：以场景为单位，元数据 `{chapter, order, characters, locations}`
- 增量索引：内容 hash 判断变化，只重嵌改动块
- 存储：SQLite + sqlite-vec，SQL 过滤 + 向量检索一体

### 6.5 知识图谱：云图 / 关系链 / 剧情链
- 显式层（权威）：角色卡 `relations:`、世界观 `related:`
- 隐式层（抽取）：LLM 结构化抽取 `{subject, relation, object, evidence, chapter}`，带证据可溯源、可确认/删除
- 可视化：Webview + AntV G6
  - **关系云图**：节点 = 角色 / 地点 / 势力 / 物品，边 = 关系（颜色敌友、粗细互动频次）；按章节范围过滤看关系演变
  - **剧情发展链**：事件因果 DAG（时间顺序 + `leads_to`），伏笔 = 未闭合的边，与 lint 联动
- 抽取成本控制：章节 `status: revision` 或手动触发才抽取；用便宜模型抽取，贵模型续写

### 6.6 RAG 上下文组装
```
光标位置 / 用户输入
  → 实体识别（Aho-Corasick 匹配角色名/地名/术语）
  → 并行：① 图查询（出场角色卡 + relations）② 向量检索（相似场景 top-k）③ 事件链回溯（最近 N 节点）
  → 去重 + token 预算裁剪 → 上下文包 → LLM
```

---

## 7. 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| **M0 基建** | monorepo 脚手架、`core/` 章节模型 + frontmatter 解析、示例作品、CI（lint/test） | 可解析、可测试 |
| **M1 导出** | TXT / DOCX 导出 + Profile；CLI `novelpad export` | 第一条端到端价值 |
| **M2 设定库** | 树视图、角色卡编辑器、JSON Schema、补全 / 悬浮、基础 lint | 扩展在标准 VS Code 可用 |
| **M3 Copilot v1** | LLM Provider、InlineCompletion 续写、润色动作、`@novelpad` 聊天 | AI 能力上线 |
| **M4 RAG** | 本地 Embedding、sqlite-vec、增量索引、检索器接入 Copilot | 续写「懂设定」 |
| **M5 图谱** | 显式关系 → G6 云图；LLM 抽取 → 事件链 / 剧情发展链 | 可视化护城河 |
| **M6 壳 v1** | 拉取 VS Code 源码、product.json、主题、默认配置、补丁脚本、构建发行版 | NovelPad 独立产品 |
| **M7 界面定制** | 壳挂载点 + 皮肤 CSS + 排版设置 / 装饰 + 书房首页 + 楷体随包（详见 [PLAN-UI.md](./PLAN-UI.md)） | 像写作软件，不像代码编辑器 |
| **M8 版本与共创** | 文章版 git：自动存档 / 里程碑 / 段落级 diff / 批注建议 / 支线合并（详见 [PLAN-VERSIONING.md](./PLAN-VERSIONING.md)） | 作者不用懂 git 也能安心改稿 |
| **M9 生态** | lint 规则插件化、设定包分享、Open VSX 发布、PDF 导出 | 对外发布 |

> M0~M5 全程不依赖源码构建，用标准 VS Code + F5 开发；M6 才引入源码。
> M7 之后**只有一处需要重编壳**（workbench.html 的挂载点），皮肤与排版都在扩展里，秒级迭代。

---

## 8. 技术选型

| 领域 | 选型 | 备注 |
|---|---|---|
| 语言 | TypeScript 全栈 | |
| 包管理 | pnpm workspace | |
| 扩展 | VS Code Extension API、Webview UI Toolkit | |
| 编辑器体验 | 内置 Markdown、ProseMirror（Webview 富编辑可选） | |
| 解析 | `gray-matter`、`mdast-util`（unified） | |
| 导出 | `docx`、Paged.js + Edge headless、pandoc（可选） | |
| Lint | 自研规则引擎（参考 ESLint） | |
| Embedding | Transformers.js（ONNX Runtime Web） | |
| 向量库 | SQLite + sqlite-vec | |
| 图谱 | AntV G6 | |
| 实体识别 | Aho-Corasick（`aho-corasick` 包） | 中文多模式匹配 |
| LLM | OpenAI 兼容 SDK（`openai` 包，baseURL 可配） | |
| 测试 | vitest、`@vscode/test-electron` | |
| 构建 | tsup（扩展打包）、vsce（打包 .vsix） | |

---

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 上游 VS Code 月度更新，合并成本高 | 高 | 薄定制层：功能全在扩展，壳只保留配置 + 少量补丁，CI 自动验证补丁可重放 |
| 首次源码构建慢（30~60 分钟） | 中 | 开发期不碰源码，只在发版时构建 |
| 微软商标 / Marketplace 限制 | 高 | 不用 VS Code 名称 / Logo；接入 Open VSX |
| 本地 Embedding 首次下载模型 ~100MB | 中 | 首次启用时引导下载，提供 API 替代 |
| LLM 抽取 token 成本 | 中 | 手动 / 阶段触发，便宜模型抽取 |
| 中文分词 / 实体识别精度 | 中 | 以设定库实体词典为主（Aho-Corasick 精确匹配），分词为辅 |
| 长篇（百万字）索引性能 | 中 | 增量索引 + worker 线程 + 场景级分块 |

---

## 10. 下一步行动

1. 初始化 pnpm monorepo，搭 `packages/core` + `packages/extension` + `packages/cli` 骨架
2. `core/parser`：frontmatter + 章节模型 + vitest
3. `examples/demo-novel`：一部 3~5 章的示例作品
4. `core/exporter`：TXT / DOCX 导出 + CLI 命令
5. 扩展：树视图 + 补全 / 悬浮，F5 调试通过
6. 同步准备 `shell/scripts/fetch-upstream.ps1`（源码拉取脚本），M6 时启用
