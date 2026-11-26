/**
 * 决策模型集成：正文审查 → Problems 诊断；冲突裁决；连接测试
 */
import * as vscode from "vscode";
import {
  DecisionProvider,
  assembleContext,
  resolveAttrConflict,
  reviewText,
  reviewToDiagnostics,
  type AttributeConflict,
} from "@novelpad/core";
import type { ProjectStore } from "../store";

export const DECISION_CFG = {
  enabled: "novelpad.decision.enabled",
  workspaceId: "novelpad.decision.workspaceId",
  model: "novelpad.decision.model",
} as const;

export class DecisionFeature implements vscode.Disposable {
  private readonly collection: vscode.DiagnosticCollection;
  private _provider: DecisionProvider | undefined;

  constructor(private readonly store: ProjectStore) {
    this.collection = vscode.languages.createDiagnosticCollection("novelpad-decision");
  }

  /** 创建决策 Provider（apiKey 复用 rag.apiKey，都是 DashScope） */
  provider(): DecisionProvider | undefined {
    const c = vscode.workspace.getConfiguration();
    const apiKey = c.get<string>("novelpad.rag.apiKey", "");
    if (!apiKey) return undefined;
    if (!this._provider) {
      this._provider = new DecisionProvider({
        workspaceId: c.get<string>(DECISION_CFG.workspaceId, "WORKSPACE_REDACTED"),
        apiKey,
        model: c.get<"decision-model" | "decision-model-preview">(DECISION_CFG.model, "decision-model"),
      });
    }
    return this._provider;
  }

  /** 审查当前章节：分段请求，结果进 Problems */
  async reviewActiveChapter(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const project = this.store.project;
    const decider = this.provider();
    if (!editor || !project) return void vscode.window.showWarningMessage("请先打开一部作品的章节");
    if (!decider) return void this.promptKey();
    const chapter = project.chapters.find((c) => c.path === editor.document.uri.fsPath);
    if (!chapter) return void vscode.window.showWarningMessage("当前文件不是章节（chapters/*.md）");

    const live = editor.document.getText();
    const fmEnd = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(live)?.[0].length ?? 0;
    const body = live.slice(fmEnd);
    const liveChapter = { ...chapter, content: body, wordCount: 0 };
    const ctx = assembleContext(project, { chapter: liveChapter });
    const lore = project.entities.filter((e) => e.kind !== "character").map((e) => `${e.name}：${e.summary ?? ""}`);

    // 按段落分批（每批 ≤ 1200 字），记录每批起始偏移用于定位诊断
    const paras = body.split(/(\n\s*\n)/);
    const batches: { text: string; start: number }[] = [];
    let buf = "";
    let start = 0;
    let pos = 0;
    for (const p of paras) {
      if (buf.length + p.length > 1200 && buf.trim()) {
        batches.push({ text: buf, start });
        buf = "";
        start = pos;
      }
      buf += p;
      pos += p.length;
    }
    if (buf.trim()) batches.push({ text: buf, start });

    this.collection.clear();
    let total = 0;
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "NovelPad 决策模型审查中", cancellable: true },
      async (progress, token) => {
        for (let i = 0; i < batches.length; i++) {
          if (token.isCancellationRequested) return;
          const b = batches[i]!;
          progress.report({ message: `${i + 1}/${batches.length}`, increment: 100 / batches.length });
          try {
            const v = await reviewText(decider, {
              text: b.text.replace(/<!--[\s\S]*?-->/g, ""),
              characters: ctx.characters.map((c) => ({ name: c.name, summary: c.summary, attrs: c.attrs, state: c.state })),
              pov: ctx.chapter.pov,
              lore,
            });
            const diags = reviewToDiagnostics(v);
            const uri = editor.document.uri;
            const base = fmEnd + b.start;
            // 定位到批内第一行
            const line = editor.document.positionAt(base).line;
            for (const d of diags) {
              const range = new vscode.Range(line, 0, line + Math.max(1, b.text.split("\n").length - 1), 0);
              const vd = new vscode.Diagnostic(range, d.message, d.severity === "error" ? vscode.DiagnosticSeverity.Error : d.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Information);
              vd.source = "NovelPad · 决策";
              vd.code = d.rule;
              this.collection.set(uri, [...(this.collection.get(uri) ?? []), vd]);
              total++;
            }
          } catch (e) {
            void vscode.window.showErrorMessage(`审查第 ${i + 1} 段失败：${(e as Error).message}`);
          }
        }
      },
    );
    void vscode.window.setStatusBarMessage(`NovelPad 审查完成：${batches.length} 段，${total} 个提示`, 5000);
  }

  /** 清除决策诊断 */
  clear(): void {
    this.collection.clear();
  }

  /** 冲突裁决面板：解析选中的冲突文本 → 决策 */
  async resolveSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const decider = this.provider();
    if (!editor || editor.selection.isEmpty) return void vscode.window.showInformationMessage("先选中一段冲突描述（含多个版本与来源）");
    if (!decider) return void this.promptKey();
    const text = editor.document.getText(editor.selection);
    // 从「- 值【来源】」或「- **值**：说明【来源】」的行里抽版本
    const versions: AttributeConflict["versions"] = [];
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*[-*]\s+(?:\*\*)?([^：:*【]{1,40}?)(?:\*\*)?\s*[：:]?\s*(.*?)$/.exec(line);
      if (!m) continue;
      const value = m[1]!.trim();
      const rest = m[2] ?? "";
      const src = rest.match(/【([^】]+)】/)?.[1] ?? rest.match(/来源[:：]\s*([^\s，；]+)/)?.[1] ?? "";
      const rank = /助手/.test(rest) ? "assistant" : /用户/.test(rest) ? "user" : "unknown";
      if (value.length >= 1 && !/^(建议|未定|注)/.test(value)) versions.push({ value, source: src, rank, note: rest.replace(/【[^】]+】/g, "").trim().slice(0, 80) || undefined });
    }
    if (versions.length < 2) return void vscode.window.showWarningMessage(`没从选中文本里解析出 ≥2 个版本（识别到 ${versions.length} 个）`);

    const attr = (await vscode.window.showInputBox({ prompt: "属性名", value: "发长" })) ?? "属性";
    const entity = (await vscode.window.showInputBox({ prompt: "属于谁", value: this.store.project?.entities.find((e) => e.kind === "character")?.name ?? "" })) ?? "角色";
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `决策模型裁决「${entity} · ${attr}」` }, async () => {
      try {
        const v = await resolveAttrConflict(decider, { entity, attr, versions });
        const idx = parseInt(v.adopt.choice.replace("v", ""), 10);
        const chosen = versions[idx - 1];
        const auto = v.autoResolve.noul > 0.7;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`## 冲突裁决：${entity} · ${attr}\n\n`);
        md.appendMarkdown(`**建议采用**：${chosen ? `「${chosen.value}」（${chosen.source || "来源未标注"}）` : "需重新确认"}\n\n`);
        md.appendMarkdown(`置信度 **${(v.adopt.confidence * 100).toFixed(0)}%** · 可信度 ${v.reliability.score.toFixed(1)}/3 · ${auto ? "✓ 可直接定稿" : "⚠ 建议人工复核"}\n\n`);
        md.appendMarkdown("| 版本 | 值 | 来源 | 概率 |\n|---|---|---|---|\n");
        versions.forEach((ver, i) => {
          const p = v.adopt.probabilities[`v${i + 1}`] ?? 0;
          md.appendMarkdown(`| v${i + 1} | ${ver.value} | ${ver.source || "—"} | ${(p * 100).toFixed(1)}%${v.adopt.choice === `v${i + 1}` ? " ✓" : ""} |\n`);
        });
        md.appendMarkdown(`\n耗时 ${v.raw.latencyMs.toFixed(0)}ms · ${v.raw.usage.inputTokens} tokens`);
        const panel = vscode.window.createWebviewPanel("novelpad.decision", `裁决 · ${entity} · ${attr}`, vscode.ViewColumn.Beside, { enableScripts: false });
        panel.webview.html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
          body{font-family:var(--vscode-font-family);padding:16px 20px;color:var(--vscode-foreground);line-height:1.7}
          table{border-collapse:collapse;margin:8px 0}td,th{border:1px solid var(--vscode-panel-border);padding:4px 10px;text-align:left}
          th{background:var(--vscode-sideBar-background)}
        </style></head><body>${markdownToHtml(md.value)}</body></html>`;
      } catch (e) {
        void vscode.window.showErrorMessage(`裁决失败：${(e as Error).message}`);
      }
    });
  }

  private promptKey(): void {
    void vscode.window.showWarningMessage("决策模型需要阿里云 DashScope API Key", "打开设置").then((r) => {
      if (r) void vscode.commands.executeCommand("workbench.action.openSettings", "novelpad.rag");
    });
  }

  dispose(): void {
    this.collection.dispose();
  }
}

/** 极简 markdown → html（表格 / 粗体 / 标题） */
export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inTable = false;
  for (const raw of lines) {
    let line = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    if (line.startsWith("| ")) {
      if (/^\|\s*-+/.test(line)) continue;
      if (!inTable) {
        out.push("<table>");
        inTable = true;
        out.push("<tr>" + line.split("|").slice(1, -1).map((c) => `<th>${c.trim()}</th>`).join("") + "</tr>");
        continue;
      }
      out.push("<tr>" + line.split("|").slice(1, -1).map((c) => `<td>${c.trim()}</td>`).join("") + "</tr>");
      continue;
    }
    if (inTable) {
      out.push("</table>");
      inTable = false;
    }
    if (!line.trim()) continue;
    if (line.startsWith("## ")) out.push(`<h2>${line.slice(3)}</h2>`);
    else out.push(`<p>${line}</p>`);
  }
  if (inTable) out.push("</table>");
  return out.join("\n").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}
