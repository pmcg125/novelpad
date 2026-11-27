/**
 * 编辑动作：选中文字 → 灯泡 / 命令 → 润色/扩写/缩写/换视角/口语化 → diff 预览 → 应用
 */
import * as vscode from "vscode";
import { ACTION_LABEL, assembleContext, editText, type AssembledContext, type CopilotAction } from "@novelpad/core";
import type { ProjectStore } from "../store";
import type { CopilotConfig } from "./config";
import { CopilotPrompt, setLastReasoning } from "./continue";
import { showReasoning, type ReasoningEntry } from "./reasoning";
import type { VersionManager } from "../features/version";

function emptyContext(doc: vscode.TextDocument): AssembledContext {
  return {
    title: "",
    chapter: { title: "", order: 0 },
    characters: [],
    locations: [],
    foreshadows: [],
    prevChapterTail: "",
    recentText: doc.getText().slice(-1500),
    styleSamples: [],
    constraints: [],
    estimatedTokens: 0,
  };
}

export class EditActions implements vscode.Disposable {
  private status: vscode.StatusBarItem;
  private running = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly config: CopilotConfig,
    private readonly version?: VersionManager,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    this.status.tooltip = "Novel Copilot 正在改写";
  }

  /** 当前章节的上下文（非章节文件返回 undefined） */
  private contextFor(doc: vscode.TextDocument): AssembledContext | undefined {
    const project = this.store.project;
    if (!project) return undefined;
    const chapter = project.chapters.find((c) => c.path === doc.uri.fsPath);
    if (!chapter) return undefined;
    const live = doc.getText();
    const fmEnd = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(live)?.[0].length ?? 0;
    return assembleContext(project, { chapter: { ...chapter, content: live.slice(fmEnd), wordCount: 0 } });
  }

  /** 灯泡菜单：选中 ≥4 字时出现 */
  codeActions(): vscode.Disposable {
    const provided: vscode.CodeActionProvider = {
      provideCodeActions(document, range) {
        if (range.isEmpty || document.languageId !== "markdown") return undefined;
        if (document.getText(range).trim().length < 4) return undefined;
        const actions = (Object.keys(ACTION_LABEL) as CopilotAction[]).map((action) => {
          const a = new vscode.CodeAction(`${ACTION_LABEL[action]}（Novel Copilot）`, vscode.CodeActionKind.RefactorRewrite);
          a.command = { command: "novelpad.copilot.edit", title: ACTION_LABEL[action], arguments: [document.uri, range, action] };
          return a;
        });
        return actions;
      },
    };
    return vscode.languages.registerCodeActionsProvider({ language: "markdown", scheme: "file" }, provided, {
      providedCodeActionKinds: [vscode.CodeActionKind.RefactorRewrite],
    });
  }

  /** 主入口 */
  async run(uri: vscode.Uri, range: vscode.Range, action: CopilotAction): Promise<void> {
    if (this.running) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const original = doc.getText(range);
    if (!original.trim()) return;

    let povName: string | undefined;
    if (action === "switch-pov") {
      const chars = this.store.project?.entities.filter((e) => e.kind === "character").map((e) => e.name) ?? [];
      const pick = await vscode.window.showQuickPick(chars, { placeHolder: "切换到谁的视角" });
      if (!pick) return;
      povName = pick;
    }

    const ctx = this.contextFor(doc) ?? emptyContext(doc);
    this.running = true;
    this.status.text = `$(sparkle) ${ACTION_LABEL[action]}中…`;
    this.status.show();
    try {
      const { provider } = await this.config.provider("edit");
      const out = await editText(provider, action, original, ctx, povName);
      const r = out.result;
      if (!r.rewritten.trim() || r.rewritten.trim() === original.trim()) {
        void vscode.window.showInformationMessage("Novel Copilot 认为这里不需要改动");
        return;
      }
      // 思考过程
      const entry: ReasoningEntry = { kind: "改写", reasoning: out.reasoning, output: r.rewritten, elapsedMs: out.elapsedMs };
      setLastReasoning(entry);
      if (this.config.read().showReasoning && out.reasoning) showReasoning(entry, { reveal: false });
      const decision = await this.preview(doc.uri, r.rewritten, ACTION_LABEL[action], r.changes, original.length, out.elapsedMs);
      if (decision === true) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, range, r.rewritten);
        await vscode.workspace.applyEdit(edit);
        // 版本管理据此把这条快照标成 AI 引入，时间线可「撤销这次改写」
        this.version?.markAI(doc.uri, { model: this.config.read().editModel });
      } else if (decision === false) {
        await this.run(uri, range, action);
      }
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/API Key|401|403/.test(msg)) void CopilotPrompt.missingKey(this.config);
      else void vscode.window.showErrorMessage(`Novel Copilot ${ACTION_LABEL[action]}失败：${msg}`);
    } finally {
      this.running = false;
      this.status.hide();
    }
  }

  /** 并排 diff 预览。true 应用 / false 重新生成 / undefined 放弃 */
  private async preview(srcUri: vscode.Uri, rewritten: string, label: string, changes: string[], originalLen: number, elapsedMs: number): Promise<boolean | undefined> {
    // 预览文档顶部放批注（折叠），下方是改写结果
    const preview = await vscode.workspace.openTextDocument({ language: "markdown", content: rewritten });
    await vscode.commands.executeCommand("vscode.diff", srcUri, preview.uri, `${label} · Novel Copilot 预览`, { preview: true });
    const detail = changes.length ? `改动：${changes.slice(0, 3).join("；")}` : "";
    const pick = await vscode.window.showInformationMessage(
      `Novel Copilot：${label}完成（${rewritten.length} 字，原 ${originalLen} 字，${(elapsedMs / 1000).toFixed(1)}s）${detail}`,
      "应用",
      "重新生成",
      "放弃",
    );
    if (pick === "应用") return true;
    if (pick === "重新生成") return false;
    return undefined;
  }

  dispose(): void {
    this.status.dispose();
  }
}
