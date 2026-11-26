/**
 * Novel Copilot 统一注册
 */
import * as vscode from "vscode";
import { draftCharacterCard } from "@novelpad/core";
import { CopilotConfig } from "./config";
import { ContinuationFeature } from "./continue";
import { EditActions } from "./edit";
import { QaFeature, collectFacts } from "./qa";
import type { ProjectStore } from "../store";

export function registerCopilot(context: vscode.ExtensionContext, store: ProjectStore): void {
  const config = new CopilotConfig(context.secrets);
  const continuation = new ContinuationFeature(store, config);
  const edit = new EditActions(store, config);
  const qa = new QaFeature(store, config);

  const d: vscode.Disposable[] = [
    continuation,
    edit,
    edit.codeActions(),
    vscode.commands.registerCommand("novelpad.copilot.continue", async () => {
      const hint = await askHint();
      await continuation.run(hint);
    }),
    vscode.commands.registerCommand("novelpad.copilot.continueDirect", () => continuation.run()),
    vscode.commands.registerCommand("novelpad.copilot.edit", (uri: vscode.Uri, range: vscode.Range, action: Parameters<typeof edit.run>[2]) => edit.run(uri, range, action)),
    vscode.commands.registerCommand("novelpad.copilot.editSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) return void vscode.window.showInformationMessage("先选中要改写的文字");
      const { ACTION_LABEL } = await import("@novelpad/core");
      const action = (await vscode.window.showQuickPick(
        Object.entries(ACTION_LABEL).map(([k, v]) => ({ label: v, value: k as Parameters<typeof edit.run>[2] })),
        { placeHolder: "选择改写方式" },
      ))?.value;
      if (action) await edit.run(editor.document.uri, editor.selection, action);
    }),
    vscode.commands.registerCommand("novelpad.copilot.ask", () => qa.run()),
    vscode.commands.registerCommand("novelpad.copilot.setApiKey", () => CopilotConfig.promptApiKey(config.secrets)),
    // 内部测试钩子（不进命令面板）
    vscode.commands.registerCommand("novelpad._test.setApiKey", async (key: string) => config.setApiKey(key)),
    vscode.commands.registerCommand("novelpad._test.continueAtCursor", () => continuation.run()),
    vscode.commands.registerCommand("novelpad.copilot.testConnection", async () => {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Novel Copilot 连接测试…" }, async () => {
        try {
          const { provider, cfg } = await config.provider();
          const r = await provider.complete({ messages: [{ role: "user", content: "只回复两个字：收到" }], maxTokens: 800, timeoutMs: 30_000 });
          const shown = cfg.hasKey ? "✓" : "（未配置 Key，以匿名访问）";
          void vscode.window.showInformationMessage(`连接成功 ${shown} · ${cfg.baseUrl} · 模型回复：${r.text.slice(0, 40)}`);
        } catch (e) {
          const err = e as Error & { status?: number };
          void vscode.window.showErrorMessage(`连接失败：${err.message}${err.status ? ` [HTTP ${err.status}]` : ""}`);
        }
      });
    }),
    // 从诊断生成角色卡草稿
    vscode.commands.registerCommand("novelpad.copilot.draftCharacter", async (name?: string) => {
      await draftCharacter(store, config, name);
    }),
    vscode.languages.registerCodeActionsProvider(
      { language: "markdown", scheme: "file" },
      {
        provideCodeActions(_document, _range, ctx) {
          const actions: vscode.CodeAction[] = [];
          for (const diag of ctx.diagnostics) {
            if (diag.code !== "novelpad/unknown-character") continue;
            const m = diag.message.match(/「([^」]+)」/);
            const n = m?.[1];
            if (!n) continue;
            const a = new vscode.CodeAction(`用 Novel Copilot 生成「${n}」的角色卡草稿`, vscode.CodeActionKind.QuickFix);
            a.command = { command: "novelpad.copilot.draftCharacter", title: "生成角色卡", arguments: [n] };
            a.diagnostics = [diag];
            actions.push(a);
          }
          return actions;
        },
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  ];
  context.subscriptions.push(...d);
}

async function askHint(): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({
    prompt: "续写要求（可留空直接续写）",
    placeHolder: "如：让沈默推门进来，带一把伞",
    ignoreFocusOut: true,
  });
  if (v === undefined) return undefined; // Esc → 取消
  return v.trim() || undefined;
}

/** 根据正文证据生成角色卡草稿，预览后写入 characters/ */
async function draftCharacter(store: ProjectStore, config: CopilotConfig, name?: string): Promise<void> {
  const project = store.project;
  if (!project) return;
  const n = name ?? (await vscode.window.showInputBox({ prompt: "角色名" }));
  if (!n) return;
  const evidence = project.chapters
    .filter((c) => c.content.includes(n))
    .slice(0, 4)
    .map((c) => {
      const i = c.content.indexOf(n);
      const start = Math.max(0, i - 200);
      return `（第 ${c.frontmatter.order} 章）${c.content.slice(start, i + 300).replace(/\s+/g, " ")}`;
    });
  if (!evidence.length) return void vscode.window.showWarningMessage(`正文中没有出现「${n}」`);

  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Novel Copilot 正在为「${n}」整理角色卡…` }, async () => {
    try {
      const { provider } = await config.provider("edit");
      const yaml = await draftCharacterCard(provider, n, evidence, project.config.title);
      const doc = await vscode.workspace.openTextDocument({ language: "yaml", content: yaml });
      await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
      const pick = await vscode.window.showInformationMessage(`已根据 ${evidence.length} 段正文生成「${n}」的角色卡草稿`, "保存到 characters/", "放弃");
      if (pick !== "保存到 characters/") return;
      const fileName = `${n}.yaml`;
      const uri = vscode.Uri.joinPath(vscode.Uri.file(project.root), "characters", fileName);
      try {
        await vscode.workspace.fs.stat(uri);
        const overwrite = await vscode.window.showWarningMessage(`${fileName} 已存在，覆盖？`, "覆盖", "取消");
        if (overwrite !== "覆盖") return;
      } catch {
        /* 不存在 */
      }
      await vscode.workspace.fs.writeFile(uri, Buffer.from(yaml + "\n", "utf8"));
      store.scheduleRefresh(0);
      await vscode.window.showTextDocument(uri);
    } catch (e) {
      void vscode.window.showErrorMessage(`生成角色卡失败：${(e as Error).message}`);
    }
  });
}

export { collectFacts };
