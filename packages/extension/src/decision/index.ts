/**
 * RAG + 决策 统一注册
 */
import * as vscode from "vscode";
import { RagManager } from "../rag/manager";
import { DecisionFeature } from "./feature";
import type { ProjectStore } from "../store";
import type { ContinuationFeature } from "../copilot/continue";

export function registerRagAndDecision(
  context: vscode.ExtensionContext,
  store: ProjectStore,
  continuation: ContinuationFeature,
): { rag: RagManager; decision: DecisionFeature } {
  const rag = new RagManager(store);
  const decision = new DecisionFeature(store);
  continuation.rag = rag;
  continuation.decider = decision.provider();

  // 设置变化时刷新 decider
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("novelpad.decision") || e.affectsConfiguration("novelpad.rag")) {
        continuation.decider = decision.provider();
      }
    }),
  );

  const d: vscode.Disposable[] = [
    rag,
    decision,
    vscode.commands.registerCommand("novelpad.rag.rebuild", () => rag.rebuild()),
    vscode.commands.registerCommand("novelpad.rag.search", async () => {
      const q = await vscode.window.showInputBox({ prompt: "在作品里检索（相似场景 / 设定）", placeHolder: "如：残念对过去的态度" });
      if (!q) return;
      const hits = await rag.search(q, { topK: 8 });
      if (!hits.length) return void vscode.window.showInformationMessage("没有命中（索引是否已建立？）");
      const items = hits.map((h) => {
        const m = h.chunk.meta;
        const where = m.kind === "chapter" ? `第 ${m.order} 章` : m.kind === "entity" ? `设定 · ${m.entity}` : m.kind === "lore" ? `世界观 · ${m.title}` : `大纲 · ${m.title}`;
        const section = (m as { section?: string }).section;
        return {
          label: `${(h.score * 100).toFixed(0)}%  ${where}${section ? " / " + section : ""}`,
          description: h.chunk.text.replace(/\s+/g, " ").slice(0, 80),
          detail: h.chunk.text.slice(0, 300),
          meta: m,
        };
      });
      type Item = (typeof items)[number];
      const pick = (await vscode.window.showQuickPick(items as vscode.QuickPickItem[], { title: `检索：${q}`, matchOnDescription: true, matchOnDetail: true })) as Item | undefined;
      if (pick) {
        const root = store.root;
        if (!root) return;
        const uri = vscode.Uri.joinPath(root, ...pick.meta.file.split("/"));
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);
        // 尝试定位 section 标题
        const sec = (pick.meta as { section?: string }).section;
        if (sec) {
          for (let i = 0; i < doc.lineCount; i++) {
            if (doc.lineAt(i).text.includes(sec)) {
              editor.selection = new vscode.Selection(i, 0, i, 0);
              editor.revealRange(new vscode.Range(i, 0, i + 10, 0), vscode.TextEditorRevealType.InCenter);
              break;
            }
          }
        }
      }
    }),
    vscode.commands.registerCommand("novelpad.decision.review", () => decision.reviewActiveChapter()),
    vscode.commands.registerCommand("novelpad.decision.clear", () => decision.clear()),
    vscode.commands.registerCommand("novelpad.decision.resolve", () => decision.resolveSelection()),
    vscode.commands.registerCommand("novelpad.decision.test", async () => {
      const decider = decision.provider();
      if (!decider) return;
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "决策模型连接测试" }, async () => {
        try {
          const r = await decider.decide({
            state: "林晚推门进去，听见身后有人落锁。她握住口袋里的折叠刀，没有回头。",
            questions: { tension: { type: "noul", instructions: "这段文字气氛紧张吗？" } },
          });
          void vscode.window.showInformationMessage(`决策模型 OK · ${r.latencyMs.toFixed(0)}ms · P(紧张)=${(r.answers.tension as { noul: number }).noul.toFixed(2)}`);
        } catch (e) {
          void vscode.window.showErrorMessage(`决策模型失败：${(e as Error).message}`);
        }
      });
    }),
  ];
  context.subscriptions.push(...d);

  // 索引存在时惰性加载 + 首次打开提示建索引
  void store.onDidChange(() => {
    void rag.ensure();
  });

  return { rag, decision };
}
