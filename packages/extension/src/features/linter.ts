/**
 * 诊断：lint 结果 → Problems 面板
 */
import * as vscode from "vscode";
import type { Project } from "@novelpad/core";
import { lintProject, type Diagnostic } from "@novelpad/core";
import type { ProjectStore } from "../store";

const SEVERITY: Record<Diagnostic["severity"], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export class Linter implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection("novelpad");

  constructor(private readonly store: ProjectStore) {}

  /** 对整个作品 lint 并发布诊断 */
  async run(project?: Project): Promise<Diagnostic[]> {
    const p = project ?? this.store.project;
    this.collection.clear();
    if (!p) return [];
    const diags = lintProject(p, { rules: p.config.rules });
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of diags) {
      const uri = vscode.Uri.joinPath(vscode.Uri.file(p.root), ...d.file.split("/"));
      // 折叠为 [line, line] 单行范围；有 column 时定位到列
      const line = Math.max(0, d.line - 1);
      const col = Math.max(0, (d.column ?? 1) - 1);
      const len = Math.max(1, guessLength(d.message));
      const range = new vscode.Range(line, col, line, col + len);
      const vd = new vscode.Diagnostic(range, d.message, SEVERITY[d.severity]);
      vd.source = "NovelPad";
      vd.code = d.rule;
      if (d.relatedId) {
        vd.relatedInformation = [
          new vscode.DiagnosticRelatedInformation(
            new vscode.Location(uri, new vscode.Range(line, 0, line, 0)),
            `相关：${d.relatedId}`,
          ),
        ];
      }
      const arr = byFile.get(uri.toString()) ?? [];
      arr.push(vd);
      byFile.set(uri.toString(), arr);
    }
    for (const [key, arr] of byFile) this.collection.set(vscode.Uri.parse(key), arr);
    return diags;
  }

  /** 保存单个章节时的快速 lint（仍跑全书规则，因为伏笔 / 一致性是跨章的） */
  runOnSave(): void {
    const cfg = vscode.workspace.getConfiguration("novelpad");
    if (cfg.get<boolean>("lintOnSave", true)) void this.run();
  }

  dispose(): void {
    this.collection.dispose();
  }
}

/** 从消息里猜一个合理的高亮长度（粗略：取引号内文本长度，否则 8） */
function guessLength(message: string): number {
  const m = message.match(/[「『"']([^」』"']+)[」』"']/);
  return m?.[1]?.length ?? 8;
}
