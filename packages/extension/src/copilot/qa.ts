/**
 * 设定问答：从设定库检索事实 → 只依据事实回答（避免编造）
 */
import * as vscode from "vscode";
import { marked } from "marked";
import { askQuestion, collectForeshadows, type Chapter } from "@novelpad/core";
import type { ProjectStore } from "../store";
import type { CopilotConfig } from "./config";
import { CopilotPrompt } from "./continue";

/** 从作品里检索与问题相关的事实 */
export function collectFacts(project: NonNullable<ProjectStore["project"]>, question: string, max = 12): string[] {
  const facts: string[] = [];
  const idx = new Map<string, (typeof project.entities)[number]>();
  for (const e of project.entities) {
    idx.set(e.name, e);
    for (const a of e.aliases ?? []) idx.set(a, e);
  }

  // 1. 问题里提到的实体 → 完整设定
  const mentioned = [...idx.keys()].sort((a, b) => b.length - a.length).filter((n) => question.includes(n));
  const seen = new Set<string>();
  for (const name of mentioned) {
    const e = idx.get(name)!;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    facts.push(entityFact(e));
    for (const r of e.relations ?? []) facts.push(`${e.name} 与 ${r.target}：${r.type}${r.note ? `（${r.note}）` : ""}${r.source === "ai" && !r.confirmed ? "（AI 抽取，待确认）" : ""}`);
  }

  // 2. 问题涉及伏笔
  if (/伏笔|回收|铺垫/.test(question)) {
    const all = collectForeshadows(project.chapters);
    for (const [id, f] of all) {
      const note = f.declaredIn.frontmatter.foreshadows?.find((x) => x.id === id)?.note;
      facts.push(`伏笔「${id}」${note ? `（${note}）` : ""}：第 ${f.declaredIn.frontmatter.order} 章埋下${f.due ? `，应第 ${f.due} 章前回收` : ""}${f.resolvedIn ? `，已在第 ${f.resolvedIn.frontmatter.order} 章回收` : "，尚未回收"}`);
    }
  }

  // 3. 问题涉及出场 / 首次出现
  const chapterHits = mentioned.length
    ? project.chapters.filter((c) => mentioned.some((m) => c.frontmatter.characters?.includes(m) || c.content.includes(m)))
    : [];
  for (const name of mentioned.slice(0, 3)) {
    const e = idx.get(name)!;
    const first = chapterHits.find((c) => c.content.includes(name) || c.frontmatter.characters?.includes(e.name));
    if (first) facts.push(`${name} 首次出现在第 ${first.frontmatter.order} 章「${first.frontmatter.title}」`);
    const count = chapterHits.filter((c) => c.content.includes(name) || c.frontmatter.characters?.includes(e.name)).length;
    if (count) facts.push(`${name} 共出场 ${count} 章`);
  }

  // 4. 问题提到章节号 → 该章 frontmatter 摘要
  const chMatch = question.match(/第\s*(\d+)\s*章/);
  if (chMatch) {
    const n = parseInt(chMatch[1]!, 10);
    const ch = project.chapters.find((c) => c.frontmatter.order === n);
    if (ch) facts.push(chapterFact(ch));
  }

  // 5. 问题涉及「视角」→ 当前 pov
  if (/视角/.test(question)) {
    const povs = new Map<string, number[]>();
    for (const c of project.chapters) {
      const p = c.frontmatter.pov;
      if (!p) continue;
      if (!povs.has(p)) povs.set(p, []);
      povs.get(p)!.push(c.frontmatter.order);
    }
    for (const [p, orders] of povs) facts.push(`${p} 担任视角的章节：${orders.join("、")}`);
  }

  // 6. 问题涉及状态（知道/在哪/情绪）
  if (/知道|在哪|位置|情绪|状态/.test(question)) {
    for (const name of mentioned) {
      const e = idx.get(name)!;
      if (e.kind === "character" && e.state) {
        const parts: string[] = [];
        if (e.state.emotion) parts.push(`情绪「${e.state.emotion}」`);
        if (e.state.location) parts.push(`位置「${e.state.location}」`);
        if (e.state.knows?.length) parts.push(`已知晓「${e.state.knows.join("、")}」`);
        facts.push(`${name} 当前状态（第 ${e.state.since ?? "?"} 章）：${parts.join("，") || "无"}`);
      }
    }
  }

  return facts.slice(0, max);
}

function entityFact(e: NonNullable<ProjectStore["project"]>["entities"][number]): string {
  const parts = [`${e.name}（${{ character: "角色", location: "地点", faction: "势力", item: "物品", lore: "世界观" }[e.kind]}${e.aliases?.length ? `，又称${e.aliases.join("、")}` : ""}）`];
  if (e.kind === "character" && e.role) parts.push(`定位 ${e.role}`);
  if (e.summary) parts.push(e.summary);
  if (e.attrs) parts.push(Object.entries(e.attrs).map(([k, v]) => `${k}=${v}`).join("；"));
  return parts.join("：");
}

function chapterFact(ch: Chapter): string {
  const fm = ch.frontmatter;
  const parts = [`第 ${fm.order} 章「${fm.title}」`];
  if (fm.pov) parts.push(`视角 ${fm.pov}`);
  if (fm.characters?.length) parts.push(`出场 ${fm.characters.join("、")}`);
  if (fm.locations?.length) parts.push(`地点 ${fm.locations.join("、")}`);
  if (fm.foreshadows?.length) parts.push(`埋伏笔 ${fm.foreshadows.map((f) => f.id).join("、")}`);
  if (fm.resolves?.length) parts.push(`回收 ${fm.resolves.join("、")}`);
  parts.push(`${ch.wordCount} 字`);
  return parts.join("，");
}

/** 问答面板 */
export class QaFeature {
  constructor(
    private readonly store: ProjectStore,
    private readonly config: CopilotConfig,
  ) {}

  async run(): Promise<void> {
    const project = this.store.project;
    if (!project) return void vscode.window.showWarningMessage("NovelPad：请先打开一部作品");
    const q = await vscode.window.showInputBox({
      prompt: `问问《${project.config.title}》的设定（如：林晚在第 5 章应该知道沈默在商会吗？）`,
      placeHolder: "输入问题…",
      ignoreFocusOut: true,
    });
    if (!q?.trim()) return;

    const facts = collectFacts(project, q);
    const editor = vscode.window.activeTextEditor;
    const chapterOrder = project.chapters.find((c) => c.path === editor?.document.uri.fsPath)?.frontmatter.order;

    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Novel Copilot 查阅设定中…" }, async () => {
      try {
        const { provider } = await this.config.provider("edit");
        const answer = await askQuestion(provider, q, { title: project.config.title, chapterOrder, facts });
        const answerHtml = marked.parse(answer, { async: false }) as string;
        const factsHtml = facts.length
          ? `<details><summary>查看依据（${facts.length} 条）</summary><ul>${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul></details>`
          : "";
        const panel = vscode.window.createWebviewPanel("novelpad.qa", `Novel Copilot · ${q.slice(0, 20)}`, vscode.ViewColumn.Beside, { enableScripts: false });
        panel.webview.html = webviewHtml(q, answerHtml, factsHtml, chapterOrder);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (/API Key|401|403/.test(msg)) void CopilotPrompt.missingKey(this.config);
        else void vscode.window.showErrorMessage(`Novel Copilot 回答失败：${msg}`);
      }
    });
  }
}

/** 问答页面（使用 VS Code 主题变量，自动适配宣纸 / 夜墨） */
function webviewHtml(q: string, answerHtml: string, factsHtml: string, chapterOrder?: number): string {
  const style = `
    body { font-family: var(--vscode-font-family); padding: 16px 20px; color: var(--vscode-foreground); line-height: 1.8; font-size: 14px; }
    .q { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
    .q b { color: var(--vscode-foreground); }
    .a { background: var(--vscode-sideBar-background); border-left: 2px solid var(--vscode-textLink-foreground); padding: 10px 14px; border-radius: 0 6px 6px 0; }
    .a p { margin: 0 0 .6em; } .a p:last-child { margin-bottom: 0; }
    details { margin-top: 12px; } summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 12px; }
    ul { font-size: 12px; color: var(--vscode-descriptionForeground); padding-left: 18px; }
    li { margin: 2px 0; }
    code { background: var(--vscode-textCodeBlock-background); padding: 1px 4px; border-radius: 3px; }
  `;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${style}</style></head><body>
    <div class="q">你问：<b>${escapeHtml(q)}</b>${chapterOrder ? ` <small>（第 ${chapterOrder} 章）</small>` : ""}</div>
    <div class="a">${answerHtml}</div>
    ${factsHtml}
  </body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
