/**
 * 版本管理接入层：把编辑器事件翻译成快照动作。
 *
 * 分工：
 *   - `@novelpad/core` 的 version/* 只管 git 与数据结构，不认识 vscode。
 *   - 这里管「什么时候存」「存哪些文件」「算多少字」，并保证：
 *       1. **不拦截保存**（只旁路监听 onDidSaveTextDocument）
 *       2. 同一文件 30s 内的连续保存合并成一次快照
 *       3. 空闲 5 分钟自动落一版
 *       4. 关窗 / 切章时补一版，不丢最后几分钟
 *   - 所有 git 操作串行排队：并发 `git add` 会抢 index.lock。
 */
import * as vscode from "vscode";
import {
  autoSnapshot,
  ensureRepo,
  loadIndex,
  loadProject,
  milestoneSnapshot,
  nodeExec,
  pruneAutoSnapshots,
  AUTO_KEEP_PER_CHAPTER,
  type SnapshotRecord,
} from "@novelpad/core";
import type { ProjectStore } from "../store";

/** 同一文件在该窗口内的连续保存合并，不产生新版本 */
const MERGE_WINDOW_MS = 30_000;
/** 空闲这么久后落一版（作者在思考时不该产生存档） */
const IDLE_SNAPSHOT_MS = 5 * 60_000;

export class VersionManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  /** 待落盘的文件（相对作品根），30s 合并窗口 */
  private pending = new Set<string>();
  private pendingChapter: string | undefined;
  /** 每个文件上次进入 pending 的时间，用于 30s 合并判定 */
  private readonly lastQueued = new Map<string, number>();
  /** git 操作串行队列 */
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly store: ProjectStore) {}

  /** 由 extension.activate 调用；作品根可用时才开始 */
  start(): void {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc)),
      // 切章 / 关标签时把待写的补上
      vscode.window.onDidChangeActiveTextEditor(() => this.flushIfStale()),
      vscode.workspace.onDidCloseTextDocument(() => this.flushIfStale()),
    );
  }

  /* ============================================================
   * 事件
   * ============================================================ */

  private onSave(doc: vscode.TextDocument): void {
    if (doc.languageId !== "markdown" && doc.languageId !== "yaml") return;
    const root = this.store.root;
    if (!root) return;
    const rel = relFrom(root.fsPath, doc.uri.fsPath);
    if (!rel) return; // 作品目录之外的文件不管

    // 同一文件 30s 内的连续保存只是「同一段思考的反复修改」，
    // 并进同一个待写集合即可 —— 落盘时一次快照就含全部改动。
    // 所以这里不加额外判断：pending 是集合，重复 add 天然合并。
    this.lastQueued.set(rel, Date.now());
    this.pending.add(rel);

    // 章节 key 用于自动存档分桶与保留策略
    const chapter = chapterKeyOf(rel);
    if (chapter) this.pendingChapter = chapter;

    this.armIdleTimer();
  }

  /** 切章 / 关文档：有待写项且已经过了合并窗口就落一版 */
  private flushIfStale(): void {
    if (!this.pending.size) return;
    const now = Date.now();
    const newest = Math.max(...[...this.pending].map((f) => this.lastQueued.get(f) ?? 0));
    if (now - newest >= MERGE_WINDOW_MS) void this.flush("switch");
  }

  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.flush("idle"), IDLE_SNAPSHOT_MS);
  }

  /* ============================================================
   * 落盘
   * ============================================================ */

  /** 把 pending 里的文件打成一次自动存档。重复调用安全（无待写项时直接返回） */
  async flush(reason: "idle" | "switch" | "manual" | "dispose"): Promise<void> {
    if (this.disposed && reason !== "dispose") return;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (!this.pending.size) return;

    const files = [...this.pending];
    const chapter = this.pendingChapter ?? chapterKeyOf(files[0] ?? "");
    this.pending.clear();
    this.pendingChapter = undefined;

    const store = this.store;
    const rootUri = store.root;
    if (!rootUri) return;
    const root = rootUri.fsPath;

    await this.enqueue(async () => {
      await ensureRepo(nodeExec, root);

      // 从磁盘重新读一遍：store 里的字数可能是保存前的旧值，
      // 用它算净增会得出「改了很多字，净增 0」这种自相矛盾的记录。
      let project = this.store.project;
      try {
        project = loadProject({ root });
      } catch {
        /* 读失败就退回 store 的缓存版本 */
      }
      if (!project) return;

      // 全书总字数：自动存档记的是「此刻全书写到多少」
      const totalWords = project.chapters.reduce((s, c) => s + c.wordCount, 0);

      // 上一版的总字数：用于算净增
      const idx = loadIndex(root);
      const prev = idx.snapshots
        .filter((s) => s.kind === "auto" || s.kind === "milestone")
        .sort((a, b) => (a.time < b.time ? 1 : -1))[0];
      const delta = prev?.words ? totalWords - prev.words.total : totalWords;

      const out = await autoSnapshot(nodeExec, {
        root,
        chapterKey: chapter || "misc",
        files,
        totalWords,
        deltaWords: delta,
      });

      if (!out.ok) {
        // 存档失败不该打断写作：只提示，不弹窗阻塞
        console.warn(`[novelpad] 自动存档失败（${reason}）：${out.error}`);
        return;
      }

      // 滚动清理：每章只留最近 N 个（ref 与索引一起删）
      if (chapter) await pruneAutoSnapshots(nodeExec, root, chapter, AUTO_KEEP_PER_CHAPTER);
    });
  }

  /** 手动「存一版」：里程碑，永久保留 */
  async milestone(label: string, note?: string): Promise<SnapshotRecord | undefined> {
    const rootUri = this.store.root;
    if (!rootUri) {
      void vscode.window.showWarningMessage("请先打开一个作品");
      return undefined;
    }
    const root = rootUri.fsPath;

    // 里程碑应包含此刻磁盘上的全部内容，而不只是最近改过的文件
    this.pending.clear();
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }

    let rec: SnapshotRecord | undefined;
    await this.enqueue(async () => {
      await ensureRepo(nodeExec, root);
      let project = this.store.project;
      try {
        project = loadProject({ root });
      } catch {
        /* 退回缓存 */
      }
      if (!project) return;

      const totalWords = project.chapters.reduce((s, c) => s + c.wordCount, 0);
      const idx = loadIndex(root);
      const prev = idx.snapshots
        .filter((s) => s.kind === "auto" || s.kind === "milestone")
        .sort((a, b) => (a.time < b.time ? 1 : -1))[0];
      const out = await milestoneSnapshot(nodeExec, {
        root,
        label,
        note,
        totalWords,
        deltaWords: prev?.words ? totalWords - prev.words.total : totalWords,
      });
      if (!out.ok) {
        void vscode.window.showErrorMessage(`存版本失败：${out.error}`);
        return;
      }
      rec = out.record;
    });
    return rec;
  }

  /* ============================================================
   * 串行队列
   * ============================================================ */

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task, task);
    return this.queue;
  }

  dispose(): void {
    // 关窗前最后一版：这里不能 await，用 flag 让进行中的任务继续
    this.disposed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}

/* ============================================================
 * 路径换算
 * ============================================================ */

/** 绝对路径 → 作品相对路径（正斜杠）；不在作品内返回 undefined */
function relFrom(root: string, file: string): string | undefined {
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const f = norm(file);
  // Windows 盘符大小写不敏感
  const same = process.platform === "win32" ? f.toLowerCase().startsWith(r.toLowerCase() + "/") : f.startsWith(r + "/");
  if (!same) return undefined;
  return f.slice(r.length + 1);
}

/** 从作品相对路径推断章节 key：chapters/003.md → "003" */
function chapterKeyOf(rel: string): string | undefined {
  const m = /(?:^|\/)chapters\/(.+)\.[a-z]+$/i.exec(rel);
  if (!m) return undefined;
  return m[1];
}