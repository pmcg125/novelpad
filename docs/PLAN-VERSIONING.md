# M8 · 文章版版本管理 + 共创系统

> 核心判断：**写作者不需要 git。他们需要「昨晚那版」，以及「编辑为什么改了这一句」。**
>
> 底层继续用 git（成熟、可离线、可托管），但**隐藏 git**：没有 stage、没有 commit message 模板、没有分支名。

---

## 1. 为什么不直接让作者用 git

| 痛点 | 说明 |
|---|---|
| 心智负担 | 「暂存」「提交」「推送」对写作者是三个无意义动作，且顺序错了会丢稿 |
| 粒度不对 | git 以文件为单位，作者以**段落 / 一句话**为单位思考（「这句话我改回去了」） |
| diff 无意义 | 行级 diff 在长段落里是一整行红一整行绿，看不出改了哪几个字 |
| 冲突恐怖 | 冲突标记 `<<<<<<<` 出现在正文里，足以让作者放弃工具 |
| 提交信息 | 作者写不出 commit message；「更新」是唯一会出现的词 |

结论：**git 做后端存储，产品层完全重写交互**。

---

## 2. 数据模型

### 2.1 仓库位置

```
my-novel/
├── .novelpad/config.json
├── chapters/…                      # 工作区（作者看到的世界）
└── .git/                           # 版本库（作者看不到）
    └── novelpad/                   # 我们的元数据，不进 git 对象
        ├── snapshots.json          # 快照索引（ID / 时间 / 类型 / 摘要 / 字数）
        ├── session.json            # 当前写作会话（开始时间 / 起始字数 / 已快照）
        └── annotations.jsonl       # 批注（多人协作时用，也可进 git 共享）
```

**作者视角只有一个东西：时间线。** 每一条 = 一个「版本」。

### 2.2 三类版本

| 类型 | 触发 | 存储 | 保留期 |
|---|---|---|---|
| **自动存档** | 空闲 5 分钟 / 切章 / 关闭窗口 | git commit（`refs/novelpad/auto`，非 HEAD） | 48 小时滚动 |
| **里程碑** | 作者点「存一版」/ 完成一章 | git commit + `snapshots.json` 记录（带标题/备注） | 永久 |
| **发布版** | 导出投稿 / 打印 | 里程碑 + 冻结（禁止改写） | 永久 |

自动存档用**平行的 ref** 而不是 commit 到当前分支——不污染 `git log`，作者打开 GitHub 也不会看到 300 条 "auto"。

```
refs/heads/main                 作者手动里程碑（可见、可推送）
refs/novelpad/auto/<chapter>    按章节滚动的自动存档（只留最近 20 个）
refs/novelpad/publish/<tag>     发布冻结版
```

### 2.3 快照记录

```jsonc
{
  "id": "s_20261127_1432_a3f1",
  "ref": "refs/novelpad/auto/ch001",
  "commit": "9c2e...",
  "kind": "auto" | "milestone" | "publish",
  "time": "2026-11-27T14:32:11+08:00",
  "label": "第三章 改完雨夜对峙",       // 里程碑才有
  "note": "把沈默的动机藏得更深一点",     // 可选
  "files": ["chapters/003.md"],         // 本次涉及的文件
  "chapter": 3,
  "words": { "total": 48210, "delta": +312 },
  "parent": "s_20261127_1200_7b2c",     // 链式，便于「撤销到上一版」
  "origin": { "kind": "human" }         // 或 { kind: "ai", prompt: "…", model: "…" }
}
```

`origin` 是共创的基石：**AI 改的和人改的必须能分开**。作者可以「只回滚 AI 的改动」。

---

## 3. 版本捕获（顺序很重要）

```
保存文件
  → ProjectStore.onDidChange
  → VersionManager.onSave(uri, contentBefore, contentAfter)
      ├─ 若同一文件 30s 内连续保存 → 合并进待写快照（不产生新版本）
      ├─ 计算「段落级 diff」，生成 change 摘要（改了几句 / 增删字数）
      ├─ 空闲 5 分钟 → 落盘：git add -A && git commit（挂在 refs/novelpad/auto/…）
      └─ 更新 snapshots.json（原子写：tmp + rename）
```

要点：

- **不拦截保存**（不用 `onWillSaveTextDocument` 改内容），只旁路监听。
- 大文件（>200KB）跳过行级 diff，只记字数变化。
- 仓库不存在时懒初始化：`git init` + `.gitignore`（忽略 `.novelpad/index`、`*.vsix`）。
- 全部走 `child_process.execFile('git', [...])`，**不引入 simple-git**（体积 + 供应链）。

---

## 4. 三个视图

### 4.1 稿本时间线（主视图）

左侧 webview，按天分组，纵向一条线：

```
今天
 ├ 14:32  存一版   第三章 改完雨夜对峙        +312 字   [人]
 ├ 13:05  自动     第3章 · 改了几句           −18 字
 └ 09:20  自动     第3章 · 补了开头            +204 字
昨天
 ├ 22:41  存一版   第三章 初稿                +2840 字  [人]
 └ 20:12  自动     第2章                       +96 字
```

- 悬停某条 → 右侧出现「和上一版比」的**段落级 diff**（见 4.2）
- 右击 → 恢复到此版 / 复制此版正文 / 从此版开分支（共创用）
- 顶部：字数曲线（SVG 折线，横轴时间纵轴字数），鼠标移到某天显示当日净增

**没有 commit hash，没有分支图。** hash 在 tooltip 里，给排错用。

### 4.2 段落级 diff（不是行级）

作者关心的是「这句话变了」，不是「第 47 行变了」。

算法（`packages/core/src/version/diff.ts`，纯函数，可测）：

```
1. 把两版正文按空行切段（散文的天然单位）
2. 段级做 LCS → 得到 相同 / 新增 / 删除 / 修改 四类
3. 「修改」段再做**字级** diff（贪心最长公共子串，中文按字、英文按词）
4. 输出统一结构：
   { blocks: [ { type, before?, after?, inline: [{op,text}] } ], stats: {added,removed,blocks} }
```

渲染：新增段左侧 2px 绿线、删除段左侧 2px 红 + 删除线、修改段内联高亮（`<ins>/<del>`）。
**不做并排双栏**（窄窗口放不下）；做单栏上下叠 + 折叠未变段落（默认折叠 >3 段的连续相同区）。

### 4.3 章节热度条

编辑器装订线（`glyphMargin`）或度量条：每章一条横向小条，颜色深浅 = 该章改动频率（近 7 天）。
一键「这章我改了 20 遍」→ 定位到改动最密集的段落。这是写作者真正需要的「git blame」。

---

## 5. 共创系统

「共创」在写作圈有三种完全不同的形态，**必须先分清，否则会做成一个谁都不好用的东西**：

| 形态 | 场景 | 技术要求 |
|---|---|---|
| **A. 编辑批注** | 作者 → 编辑 → 作者（异步、非实时） | 批注锚定、建议模式、接受/拒绝 |
| **B. 分工合写** | 两人写不同章节 / 不同 POV 线 | 分支合并、章节级归属 |
| **C. 同段共写** | 两人同时改同一段（罕见但存在） | CRDT / OT，实时 |

**决策：A + B 做满，C 不做（M9+ 再评估）。** 理由：
- A 覆盖 90% 的真实需求（编辑、beta 读者、写作搭子提意见）
- B 用 git 分支天然满足（一人一章，冲突几乎为零）
- C 需要常驻服务 + CRDT 库 + 光标同步，成本是 A+B 的 3 倍，而作者绝大多数时间在独处写作

### 5.1 A：批注与建议

存储：`.novelpad/annotations.jsonl`（一行一条，git 友好，可手动编辑）

```jsonc
{
  "id": "a_01HQ...",
  "author": "editor@example.com",
  "created": "2026-11-27T10:00:00Z",
  "file": "chapters/003.md",
  "anchor": { "quote": "伞压得很低", "prefix": "雨幕里，", "suffix": "，露出一截下巴", "offset": 1820 },
  "range": { "start": 1820, "end": 1825 },
  "kind": "comment" | "suggestion",
  "body": "这里可以再压一句，节奏会更紧",
  "suggestion": { "before": "伞压得很低", "after": "伞压得极低，几乎贴着眉骨" },  // kind=suggestion
  "status": "open" | "accepted" | "rejected" | "resolved",
  "thread": [ { "author": "…", "time": "…", "body": "…" } ]
}
```

**锚定用「引文 + 前后文 + 偏移」三件套**（同 Google Docs 的 robust anchoring）：
偏移会因编辑漂移，所以恢复时按 `quote` + `prefix`/`suffix` 重新定位；找不到 → 标记 `status: "orphaned"`，在侧栏「失效批注」里列出，绝不静默丢失。

渲染：
- 有批注的文本 → 波浪下划线（`TextEditorDecorationType` 的 `borderStyle: 'dotted'`），hover 出 `HoverProvider` 显示线程
- 建议 → 编辑器内联 `CodeLens`「接受 / 拒绝」，接受即 `WorkspaceEdit` 替换，拒绝即改 status
- 侧栏树视图：按文件分组，`open` 计数显示在活动栏徽标上

导入导出：`.novelpad/annotations.jsonl` 随 git 走，编辑只需 clone 仓库、用 NovelPad 打开——**不需要账号、不需要服务器**。

### 5.2 B：分工合写

分支即分工，但**分支名用人话**：

```
refs/heads/main              主稿
refs/heads/line/林晚线        某条 POV 线
refs/heads/alt/第七结局       备选走向
```

- 「新建支线」= `git worktree add` 到 `<作品>-林晚线/`，独立目录、独立窗口，互不干扰（**worktree 而不是 checkout**，避免切换时作者找不到自己的稿子）
- 合并粒度：**章节级**。合并前显示「对方改了 3 章，共 +8200 字」，逐章选择采用 / 保留 / 手动
- 章节冲突（两人改了同一章）→ **不做自动文本合并**。显示两版全文，人工挑选段落（复用 4.2 的 diff 渲染，加「用左边这段 / 用右边这段」按钮）

为什么不用 CRDT 做 B：章节是天然的分工边界，冲突率低到不值得引入实时协同的全部复杂度。

### 5.3 与 AI 共创

`origin.kind === "ai"` 的快照在时间线上用青色标记，并支持：

- 「只看 AI 改动」筛选
- 「撤销这次续写」：把该快照引入的段落删掉，保留作者在此期间的其他编辑（需要段落级分账：快照 diff 的 `added` 段落 = AI 产出）
- AI 续写在编辑器中以 `GhostText` 呈现，**接受后才落盘**，未接受的不进版本库（否则时间线会被噪音淹没）

---

## 6. 与 VS Code 内置 SCM 的关系

**不让作者看到内置源代码管理视图。** 做法：

- 壳的默认设置：`"scm.defaultViewMode": "tree"`（保留但空置）
- 扩展侧用自己的「稿本」视图作为唯一入口
- 若检测到用户手动启用内置 SCM，弹出一次提示：「你可以在设置里关闭内置的源代码管理，用稿本时间线代替」——**不强制**

技术上复用 VS Code 的 git 扩展吗？**不复用**。它的 API 面向「提交/推送」，我们要的是「平行 ref + 段落 diff」，抽象层不匹配，改造它的成本高于直接调 git CLI。

---

## 7. 模块划分

```
packages/core/src/version/
├── repo.ts        git 命令封装（execFile，超时/错误归一化）
├── snapshot.ts    快照创建 / 列表 / 恢复 / 清理（48h 滚动）
├── diff.ts        段落级 + 字级 diff（纯函数，重点测试对象）
├── annotate.ts    批注锚定 / 重定位 / 线程（纯函数）
└── merge.ts       章节目录级合并（不含文本自动合并）

packages/extension/src/version/
├── manager.ts     监听保存 / 空闲计时 / 懒初始化仓库
├── timeline.ts    稿本时间线 webview（复刻 graph.ts 范式）
├── inline.ts      批注装饰 / Hover / CodeLens / 接受建议
└── branch.ts      支线 worktree 管理
```

## 8. 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **V1** | 仓库懒初始化、自动存档、里程碑、时间线视图、恢复 | 写 30 分钟 → 时间线有 ≥3 条；恢复后字数一致 |
| **V2** | 段落级 diff + 折叠未变段落 + 字数曲线 | 改 3 段 → diff 恰好标出 3 段，无整章红绿 |
| **V3** | 批注 / 建议 / 接受拒绝 / 失效批注 | 两人 clone 同一仓库，批注互通；改写锚点后仍能定位 |
| **V4** | 支线 worktree + 章节级合并 + AI 快照分账 | 两条支线各写 3 章 → 合并无冲突；撤销 AI 续写不影响人工编辑 |
| **V5** | 托管：GitHub 私有仓库一键创建 + 推送 | 作者全程不输入 git 命令 |

工作量：V1 3 人日，V2 4 人日（diff 打磨），V3 4 人日，V4 4 人日，V5 1 人日，**合计 16 人日**。

## 9. 风险

| 风险 | 对策 |
|---|---|
| git 未安装 | 启动检测；缺失时降级为「本地文件快照」（复制到 `.novelpad/backup/`，无 diff），并提示安装 |
| 大仓库（百万字 + 图片）变慢 | 只用 `git add` 指定路径；`.gitignore` 排除 `index/`；每 90 天 `gc --auto` |
| 自动存档撑爆磁盘 | 48h 滚动 + 按章节 ref 只留 20 个 + 每次 `git gc --prune=now` 在空闲时跑 |
| 作者误「恢复到此版」丢新稿 | 恢复前自动打一个 `before-restore` 快照，可再恢复回来 |
| 批注锚点大面积失效 | 三件套定位 + 失效区显式展示 + 「重新锚定」手动拖选 |
| 与内置 git 扩展打架 | 我们只用独立 ref 与独立视图，不改 `HEAD`、不碰 `index` |

## 10. 不做

- 实时协同编辑（CRDT）——需求占比低、成本高
- 可视化分支图——写作者不需要，分支用「支线」这一个词
- commit message 编辑器——里程碑只有一个可选标题
- 托管服务——首发只做「本地 + 可选推 GitHub 私有库」