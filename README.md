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
node packages/extension/scripts/e2e.mjs
```

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
- [ ] M3 Novel Copilot
- [ ] M4 RAG
- [ ] M5 图谱
- [ ] M6 壳（源码定制）
