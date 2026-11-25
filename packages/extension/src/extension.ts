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
  );

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
