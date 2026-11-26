# NovelPad

> 作家的 VS Code —— 把编程工具链搬到小说 / OC / 世界观创作中。

- Markdown 为唯一事实来源，Git 原生版本控制
- 设定即代码：角色卡 / 世界观是结构化数据，正文实时「类型检查」
- Novel Copilot：懂你的设定库的 AI 续写 / 润色 / 问答（M3）
- 知识图谱：关系云图、剧情发展链、伏笔追踪（M5）
- 投稿级导出：TXT / Word

## 文档

- [开发计划](docs/PLAN.md)
- [设计语言](docs/DESIGN.md)
- 效果图：`docs/design/mockups/`（浏览器直接打开）

## 开发

```bash
pnpm install
pnpm build          # core → cli → extension → theme
pnpm test           # 全部单元测试
```

### 命令行

```bash
node packages/cli/dist/cli.js stats  examples/demo-novel   # 字数统计
node packages/cli/dist/cli.js check  examples/demo-novel   # 设定一致性检查
node packages/cli/dist/cli.js export examples/demo-novel   # 导出 TXT + DOCX 到 dist/
```

### VS Code 扩展

在 VS Code 里打开本仓库，按 `F5`（需要 `.vscode/launch.json`），或：

```bash
cd packages/extension && pnpm package   # 生成 .vsix
```

扩展功能：章节树 / 设定树、保存时 lint 到问题面板、`[[` 补全、实体名悬浮角色卡、双链跳转、导出命令、宣纸 / 夜墨主题。

### 端到端测试（真实 VS Code 宿主）

```bash
pnpm --filter novelpad run build
node packages/extension/scripts/e2e.mjs                        # 使用本机 VS Code，跳过 LLM 调用
NOVLEPAD_LLM_TEST=1 node packages/extension/scripts/e2e.mjs   # 含真实续写（需 127.0.0.1:8788 反代）
```

core 的真实 LLM 测试同样受 `NOVLEPAD_LLM_TEST=1` 控制（`NOVLEPAD_LLM_URL / KEY / MODEL` 可覆盖）。

## Novel Copilot

| 操作 | 入口 |
|---|---|
| 续写（直接） | `Alt+\` |
| 续写（带要求） | `Alt+Shift+\` |
| 润色 / 扩写 / 缩写 / 换视角 / 口语化 | 选中文字 → 灯泡，或命令面板「Copilot 改写选中文字」 |
| 问问设定 | 命令面板「Copilot 问问设定」——只依据设定库事实回答，可展开查看依据 |
| 生成角色卡 | Problems 里「角色没有角色卡」→ 灯泡 → 根据正文生成 YAML 草稿 |
| 配置 Key | 命令面板「Copilot 设置 API Key」（存 SecretStorage，不进 settings.json） |
| 测试连接 | 命令面板「Copilot 测试连接」 |

默认 provider 为 `custom`（`127.0.0.1:8788/v1`），模型 `deepseek-v4.1-flash`。可在设置 `novelpad.copilot.*` 中切换服务商预设 / baseUrl / 续写与改写模型。

## 仓库结构

```
packages/
  core/        纯逻辑（解析、lint、导出、RAG、图谱）—— 零 vscode 依赖
  cli/         novelpad 命令行（export / check / stats / init）
  extension/   VS Code 扩展（功能主体）
  theme/       由设计令牌生成宣纸 / 夜墨主题
  schema/      角色卡 / 章节 frontmatter / 项目配置 JSON Schema
docs/          计划、设计、ADR
examples/      示例作品 demo-novel
shell/         VS Code 源码定制层（M6 启用）
```

## 里程碑进度

- [x] M0 基建：monorepo、章节模型、frontmatter 解析
- [x] M1 导出：TXT / DOCX + Profile + CLI
- [x] M2 设定库：树视图、lint 诊断、补全 / 悬浮 / 跳转、Schema、主题
- [x] M3 Novel Copilot：续写 / 改写 / 设定问答 / 角色卡草稿；推理过程可见、小说家式思考
- [x] M4 RAG + 决策：Embedding + 向量索引 + Rerank；decision-model 正文审查 / 续写前预判 / 冲突裁决
- [x] M5 图谱：关系云图（力导向、类型/关系着色、章节范围、详情面板）+ 剧情发展链（泳道时间线、伏笔开合因果）
- [ ] M6 壳（源码定制）

## 图谱

活动栏「图谱」视图，或命令「打开关系云图」/「打开剧情发展链」。

- **关系云图**：节点 = 角色 / 地点 / 势力 / 物品 / 伏笔事件，边 = 设定卡 relations（按敌友/亲缘着色）+ 正文推断（同场次数、在场）+ 伏笔因果。支持类型筛选、章节范围滑块、拖拽缩放；点节点看属性 / 状态 / 关系，可跳转正文或问 Copilot
- **剧情发展链**：按出场次数自动选泳道，每章一个场景节点，伏笔埋下 / 回收为虚线框节点，因果连线；点击跳转章节

数据全部从角色卡 `relations`、章节 frontmatter `characters`/`locations`/`foreshadows`/`resolves` 计算，不额外落盘。

## RAG 与决策模型

需要阿里云百炼（DashScope）API Key，在设置 `novelpad.rag.apiKey` 填入（Embedding / Rerank / 决策模型共用）。

| 功能 | 入口 | 说明 |
|---|---|---|
| 建立向量索引 | 命令「建立向量索引（RAG）」 | 章节 / 设定 / 世界观 / 大纲全部分块嵌入，增量更新；状态栏显示索引块数 |
| 检索 | 命令「检索相似场景与设定」 | 向量召回 → `qwen3.7-text-rerank` 精排 → QuickPick 跳转 |
| 续写时自动注入 | 续写命令（`Alt+\`） | RAG 检索相似段落 + 决策模型预判人物情绪 / 节奏 / 位置一致性 → 注入 prompt |
| 审查本章 | 命令「决策模型审查本章」 | `decision-model` 分段判断 OOC / 视角越界 / 设定矛盾 / AI 腔 → Problems |
| 裁决冲突 | 选中含多版本的冲突文本 → 「决策模型裁决选中冲突」 | 解析版本与来源 → 概率表 + 置信度 + 是否可直接定稿 |

`examples/cannian/` 是一套真实的 OC / 世界观语料（17 份文档、引用溯源、48 项冲突清单），用于验证检索与裁决质量。
- [ ] M5 图谱
- [ ] M6 壳（源码定制）
