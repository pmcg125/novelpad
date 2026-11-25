# NovelPad

> 作家的 VS Code —— 把编程工具链搬到小说 / OC / 世界观创作中。

- Markdown 为唯一事实来源，Git 原生版本控制
- 设定即代码：角色卡 / 世界观是结构化数据，正文实时「类型检查」
- Novel Copilot：懂你的设定库的 AI 续写 / 润色 / 问答
- 知识图谱：关系云图、剧情发展链、伏笔追踪
- 投稿级导出：TXT / Word / PDF

## 文档

- [开发计划](docs/PLAN.md)
- [设计语言](docs/DESIGN.md)
- 效果图：`docs/design/mockups/`（浏览器直接打开）

## 开发

```bash
pnpm install
pnpm build
pnpm test
```

## 仓库结构

```
packages/
  core/        纯逻辑（解析、索引、lint、导出、RAG、图谱）—— 零 vscode 依赖
  extension/   VS Code 扩展（功能主体）
  cli/         novelpad 命令行（export / check / index）
  theme/       由设计令牌构建的 VS Code 主题
docs/          计划、设计、ADR
shell/         VS Code 源码定制层（M6 启用）
```
