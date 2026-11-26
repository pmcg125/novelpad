/**
 * 续写：手动触发（Alt+\），以 inline progress + 可撤销替换的方式插入。
 * 推理模型响应慢，用 status bar 进度提示而不是让用户以为卡死。
 */
import * as vscode from "vscode";
import { assembleContext, continueStory } from "@novelpad/core";
import type { ProjectStore } from "../store";
import { CopilotConfig } from "./config";

/** 把文档文本按光标切分，得到 frontmatter 之后的正文偏移 */
function splitAtCursor(doc: vscode.TextDocument, cursor: vscode.Position): { before: string; offset: number } {
  const full = doc.getText();
  const off = doc.offsetAt(cursor);
  // 定位 frontmatter 结束位置
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(full);
  const bodyStart = m ? m[0].length : 0;
  return { before: full.slice(Math.min(bodyStart, off), off), offset: off };
}

export class ContinuationFeature {
  private status: vscode.StatusBarItem;
  private running = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly config: CopilotConfig,
  ) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    this.status.text = "$(sparkle) 思考中…";
    this.status.tooltip = "Novel Copilot 正在续写";
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** 主入口：从当前光标续写 */
  async run(hint?: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || this.running) return;
    const project = this.store.project;
    if (!project) {
      void vscode.window.showWarningMessage("NovelPad：请先打开一部作品");
      return;
    }
    const chapter = project.chapters.find((c) => c.path === editor.document.uri.fsPath);
    if (!chapter) {
      void vscode.window.showWarningMessage("NovelPad：当前文件不是章节（chapters/*.md）");
      return;
    }
    const cfg = this.config.read();
    if (!cfg.enabled) return;

    // 用编辑器里的实时内容（可能未保存）替换章节正文
    const { before } = splitAtCursor(editor.document, editor.selection.active);
    const live = editor.document.getText();
    const fmEnd = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(live)?.[0].length ?? 0;
    const liveChapter = { ...chapter, content: live.slice(fmEnd), wordCount: 0 };

    const ctx = assembleContext(project, { chapter: liveChapter, textBeforeCursor: before });
    const cursor = editor.selection.active;

    this.running = true;
    this.status.show();
    const t0 = Date.now();
    try {
      const { provider } = await this.config.provider("continue");
      const text = await continueStory(provider, { ctx, hint });
      const clean = text.trim();
      if (!clean) {
        void vscode.window.showInformationMessage("Novel Copilot 没有返回内容，再试一次？");
        return;
      }
      // 插入到光标处，作为一次可撤销编辑；选中以便用户直接改写或 Esc 后 Ctrl+Z
      await editor.edit(
        (eb) => {
          const insertAt = editor.selection.active;
          const prefix = needsSpaceBefore(editor, insertAt) ? "" : "";
          eb.insert(insertAt, prefix + clean);
        },
        { undoStopBefore: true, undoStopAfter: true },
      );
      // 选中刚插入的文字
      const start = cursor.with(undefined, cursor.character);
      const end = editor.document.positionAt(editor.document.offsetAt(start) + clean.length);
      editor.selection = new vscode.Selection(start, end);
      void vscode.window.setStatusBarMessage(`Novel Copilot · ${clean.length} 字 · ${((Date.now() - t0) / 1000).toFixed(1)}s（Ctrl+Z 撤销）`, 4000);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      if (/API Key|401|403/.test(msg)) void CopilotPrompt.missingKey(this.config);
      else void vscode.window.showErrorMessage(`Novel Copilot 续写失败：${msg}`);
    } finally {
      this.running = false;
      this.status.hide();
    }
  }

  dispose(): void {
    this.status.dispose();
  }
}

function needsSpaceBefore(editor: vscode.TextEditor, pos: vscode.Position): boolean {
  return pos.character > 0 && !/\s/.test(editor.document.lineAt(pos.line).text[pos.character - 1] ?? "");
}

/** 导出便于复用的提示 */
export const CopilotPrompt = {
  async missingKey(config: CopilotConfig): Promise<void> {
    const r = await vscode.window.showWarningMessage("Novel Copilot 需要配置 API Key", "配置 Key", "打开设置");
    if (r === "配置 Key") await CopilotConfig.promptApiKey(config.secrets);
    else if (r === "打开设置") void vscode.commands.executeCommand("workbench.action.openSettings", "novelpad.copilot");
  },
};
