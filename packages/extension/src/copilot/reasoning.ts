/**
 * 思考过程展示：推理模型的 reasoning 以小说家批注的形式呈现。
 * 共享一个 Webview 面板，续写 / 改写 / 问答都往里推。
 */
import * as vscode from "vscode";
import { marked } from "marked";

let panel: vscode.WebviewPanel | undefined;

export interface ReasoningEntry {
  /** 任务类型 */
  kind: "续写" | "改写" | "问答" | "角色卡";
  /** 思考过程 */
  reasoning?: string;
  /** 最终产出（正文 / 改写结果 / 回答） */
  output: string;
  elapsedMs: number;
}

/** 推入一条记录并打开面板 */
export function showReasoning(entry: ReasoningEntry, opts: { reveal?: boolean } = {}): void {
  const html = renderEntry(entry);
  if (!panel) {
    panel = vscode.window.createWebviewPanel("novelpad.reasoning", "Novel Copilot · 思考过程", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.webview.html = shell();
    panel.onDidDispose(() => {
      panel = undefined;
    });
  }
  panel.webview.postMessage({ type: "append", html });
  panel.title = `Novel Copilot · 思考过程 · ${entry.kind}`;
  if (opts.reveal !== false) panel.reveal(vscode.ViewColumn.Beside, false);
}

/** 在状态栏显示「查看思考过程」入口（点击展开面板） */
export function reasoningStatusBar(entry: ReasoningEntry): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
  const n = entry.reasoning?.length ?? 0;
  item.text = n ? `$(lightbulb) 批注 ${n} 字` : "$(lightbulb) 无批注";
  item.tooltip = `Novel Copilot 的思考过程（点击查看）\n${entry.kind} · ${(entry.elapsedMs / 1000).toFixed(1)}s`;
  item.command = "novelpad.copilot.showLastReasoning";
  item.show();
  const t = setTimeout(() => item.dispose(), 30_000);
  return { dispose: () => { clearTimeout(t); item.dispose(); } };
}

/* ---------- 渲染 ---------- */

function shell(): string {
  const style = `
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px 16px; font-size: 13.5px; line-height: 1.75; }
    .intro { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 14px; }
    .entry { border-left: 2px solid var(--vscode-textLink-foreground); padding: 8px 14px; margin-bottom: 18px; background: var(--vscode-sideBar-background); border-radius: 0 6px 6px 0; }
    .head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
    .kind { font-weight: 600; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11.5px; }
    .reasoning { white-space: pre-wrap; color: var(--vscode-foreground); font-family: "LXGW WenKai", "Kaiti SC", "KaiTi", var(--vscode-font-family); font-size: 14px; opacity: 0.9; }
    .reasoning::before { content: "✎ 批注"; display: block; font-family: var(--vscode-font-family); font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; letter-spacing: .06em; }
    .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
    details { margin-top: 10px; } summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 12px; }
    .output { margin-top: 6px; white-space: pre-wrap; }
    .output p { margin: 0 0 .6em; }
    .fade { animation: fade .25s ease-out; }
    @keyframes fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
    @media (prefers-reduced-motion: reduce) { .fade { animation: none; } }
  `;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${style}</style></head><body>
    <div class="intro">推理模型的思考过程。按 NovelPad 的提示，它应当以小说家的口吻写批注——如果这里出现「用户」「字数」「任务」之类，说明模型没有遵循思考方式。</div>
    <div id="entries"></div>
    <script>
      const vscode = acquireVsCodeApi();
      window.addEventListener("message", e => {
        if (e.data.type === "append") {
          const div = document.createElement("div");
          div.className = "fade";
          div.innerHTML = e.data.html;
          document.getElementById("entries").prepend(div);
        }
      });
    </script></body></html>`;
}

function renderEntry(e: ReasoningEntry): string {
  const reasoningHtml = e.reasoning
    ? `<div class="reasoning">${escapeHtml(e.reasoning.trim())}</div>`
    : `<div class="empty">（这个模型没有返回思考过程，或不是推理模型）</div>`;
  let outputHtml: string;
  try {
    outputHtml = marked.parse(e.output, { async: false }) as string;
  } catch {
    outputHtml = `<p>${escapeHtml(e.output)}</p>`;
  }
  return `<div class="entry">
    <div class="head"><span class="kind">${e.kind}</span><span class="meta">${(e.elapsedMs / 1000).toFixed(1)}s · 产出 ${e.output.length} 字</span></div>
    ${reasoningHtml}
    <details><summary>展开产出</summary><div class="output">${outputHtml}</div></details>
  </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
