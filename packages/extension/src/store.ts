/**
 * 项目状态：跟踪当前作品、文件监听、刷新节流
 */
import * as vscode from "vscode";
import { buildEntityIndex, loadProject, type Entity, type Project } from "@novelpad/core";

export class ProjectStore implements vscode.Disposable {
  private _project: Project | undefined;
  private _root: vscode.Uri | undefined;
  private _index = new Map<string, Entity>();
  private readonly _onDidChange = new vscode.EventEmitter<Project | undefined>();
  readonly onDidChange = this._onDidChange.event;
  private watcher: vscode.FileSystemWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;

  get project(): Project | undefined {
    return this._project;
  }

  get root(): vscode.Uri | undefined {
    return this._root;
  }

  /** 实体名 / 别称 → 实体 */
  get entityIndex(): Map<string, Entity> {
    return this._index;
  }

  /** 解析当前作品根目录：优先工作区里含 .novelpad 的文件夹 */
  async resolve(): Promise<vscode.Uri | undefined> {
    const ws = vscode.workspace.workspaceFolders ?? [];
    // 1) 工作区文件夹本身
    for (const f of ws) {
      if (await hasNovelPad(f.uri)) return f.uri;
    }
    // 2）多根工作区时，查找子目录
    for (const f of ws) {
      const subs = await vscode.workspace.fs.readDirectory(f.uri);
      for (const [name, type] of subs) {
        if (type !== vscode.FileType.Directory || name.startsWith(".")) continue;
        const sub = vscode.Uri.joinPath(f.uri, name);
        if (await hasNovelPad(sub)) return sub;
      }
    }
    return undefined;
  }

  async refresh(): Promise<void> {
    const root = await this.resolve();
    this._root = root;
    if (!root) {
      this._project = undefined;
      this._index = new Map();
      this._onDidChange.fire(undefined);
      return;
    }
    try {
      this._project = loadProject({ root: root.fsPath });
      this._index = buildEntityIndex(this._project);
    } catch (e) {
      this._project = undefined;
      this._index = new Map();
      void vscode.window.showErrorMessage(`NovelPad 读取作品失败：${(e as Error).message}`);
    }
    this._onDidChange.fire(this._project);
  }

  /** 节流刷新（保存 / 文件变化时） */
  scheduleRefresh(delayMs = 150): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delayMs);
  }

  startWatching(): void {
    this.stopWatching();
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.{md,yaml,yml,json}");
    const bump = () => this.scheduleRefresh();
    this.watcher.onDidChange(bump);
    this.watcher.onDidCreate(bump);
    this.watcher.onDidDelete(bump);
  }

  stopWatching(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }

  dispose(): void {
    this.stopWatching();
    if (this.timer) clearTimeout(this.timer);
    this._onDidChange.dispose();
  }
}

async function hasNovelPad(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, ".novelpad"));
    return true;
  } catch {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(uri, "chapters"));
      return true;
    } catch {
      return false;
    }
  }
}
