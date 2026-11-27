/**
 * NovelPad 扩展入口
 */
import * as vscode from "vscode";
import { ProjectStore } from "./store";
import { ChaptersProvider } from "./views/chapters";
import { EntitiesProvider } from "./views/entities";
import { Linter } from "./features/linter";
import { registerLanguageFeatures } from "./features/language";
import { registerCommands } from "./commands";
import { registerFocusMode } from "./features/focus";
import { VersionManager } from "./features/version";
import { registerCopilot } from "./copilot";
import { registerRagAndDecision } from "./decision";
import { openGraph, refreshGraph } from "./views/graph";
import { openTimeline, refreshTimeline } from "./views/timeline";

export function activate(context: vscode.ExtensionContext): void {
  const store = new ProjectStore();
  const chapters = new ChaptersProvider(store);
  const entities = new EntitiesProvider(store);
  const linter = new Linter(store);

  context.subscriptions.push(
    store,
    linter,
    vscode.window.createTreeView("novelpad.chapters", { treeDataProvider: chapters }),
    vscode.window.createTreeView("novelpad.entities", { treeDataProvider: entities }),
    ...registerLanguageFeatures(store),
    ...registerCommands(store, linter, chapters, entities),
    ...registerFocusMode(),
  );

  // Novel Copilot
  const copilot = registerCopilot(context, store);

  // RAG + 决策模型（注入 Copilot）
  registerRagAndDecision(context, store, copilot.continuation);

  // 图谱
  context.subscriptions.push(
    vscode.commands.registerCommand("novelpad.graph.open", () => openGraph(store, "net")),
    vscode.commands.registerCommand("novelpad.graph.chain", () => openGraph(store, "chain")),
  );
  store.onDidChange(() => refreshGraph());

  // 版本管理：自动存档 + 时间线
  const version = new VersionManager(store);
  version.start();
  context.subscriptions.push(
    version,
    vscode.commands.registerCommand("novelpad.timeline", () => openTimeline(store)),
    vscode.commands.registerCommand("novelpad.version.milestone", async () => {
      if (!store.root) return void vscode.window.showWarningMessage("请先打开一个作品");
      const label = await vscode.window.showInputBox({
        prompt: "这一版叫什么？（比如「第三章改完雨夜对峙」）",
        placeHolder: "里程碑名称",
        validateInput: (v) => (v.trim() ? undefined : "写个名字，以后好找"),
      });
      if (!label) return;
      const note = await vscode.window.showInputBox({ prompt: "备注（可留空）", placeHolder: "这版改了什么" });
      const rec = await version.milestone(label.trim(), note?.trim() || undefined);
      if (rec) {
        void vscode.window.showInformationMessage(`已存一版：${rec.label}`);
        refreshTimeline();
      }
    }),
    vscode.commands.registerCommand("novelpad.version.saveNow", async () => {
      await version.flush("manual");
      refreshTimeline();
      void vscode.window.showInformationMessage("已存档");
    }),
  );
  store.onDidChange(() => refreshTimeline());

  // 状态栏：当前章节字数 / 全书字数
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "novelpad.stats";
  context.subscriptions.push(status);

  const updateStatus = () => {
    const cfg = vscode.workspace.getConfiguration("novelpad");
    if (!cfg.get<boolean>("showWordCount", true) || !store.project) {
      status.hide();
      return;
    }
    const total = store.project.chapters.reduce((s, c) => s + c.wordCount, 0);
    const doc = vscode.window.activeTextEditor?.document;
    const ch = doc ? store.project.chapters.find((c) => c.path === doc.uri.fsPath) : undefined;
    status.text = ch ? `$(book) ${ch.wordCount.toLocaleString()} / ${total.toLocaleString()} 字` : `$(book) ${total.toLocaleString()} 字`;
    status.show();
  };

  store.onDidChange(() => {
    chapters.refresh();
    entities.refresh();
    updateStatus();
    if (store.project) void linter.run();
  });

  // 编辑器切换 / 保存
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("novelpad")) updateStatus();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/\.(md|yaml|yml)$/i.test(doc.uri.fsPath)) {
        store.scheduleRefresh();
        linter.runOnSave();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void store.refresh();
    }),
  );

  void store.refresh().then(() => store.startWatching());
}

export function deactivate(): void {
  /* subscriptions 自动 dispose */
}
