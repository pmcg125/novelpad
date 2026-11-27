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
  describeUndo,
  ensureRepo,
  loadIndex,
  loadProject,
  milestoneSnapshot,
  nodeExec,
  planAIUndo,
  pruneAutoSnapshots,
  readSnapshotFile,
  AUTO_KEEP_PER_CHAPTER,
  type Origin,
  type SnapshotRecord,
} from "@novelpad/core";
import type { ProjectStore } from "../store";

/** 同一文件在该窗口内的连续保存合并，不产生新版本 */
const MERGE_WINDOW_MS = 30_000;
/** 空闲这么久后落一版（作者在思考时不该产生存档） */
const IDLE_SNAPSHOT_MS = 5 * 60_000;
/**
 * AI 标记的有效期。
 *
 * AI 续写插入正文后，作者可能继续写很久才保存。标记过期后
 * 落下的快照就不再算「AI 引入」——否则他会看到一条两小时后的
 * 存档被标成 AI 写的，那条里其实全是他自己后来写的字。
 */
const AI_MARK_TTL_MS = 15 * 60_000;

export class VersionManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private idleTimer: NodeJS.Timeout | undefined;
  /** 待落盘的文件（相对作品根），30s 合并窗口 */
  private pending = new Set<string>();
  private pendingChapter: string | undefined;
  /** 每个文件上次进入 pending 的时间，用于 30s 合并判定 */
  private readonly lastQueued = new Map<string, number>();
  /**
   * 由 AI 引入、还没落盘的改动：文件 → 来源信息。
   *
   * 只记「哪个文件被 AI 动过」而不记「哪几个字」，因为落盘时
   * 整个文件已经混在一起了——真正的分账在撤销时按段落做（planAIUndo）。
   */
  private readonly aiTouched = new Map<string, { origin: Origin; at: number }>();
  /** git 操作串行队列 */
  private queue: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly _onDidSnapshot = new vscode.EventEmitter<SnapshotRecord>();
  /**
   * 存下一版之后触发。
   *
   * 自动备份挂在这里——它必须在**存档之后**推，否则推上去的是
   * 上次保存时的内容。也让时间线能立刻刷新，作者不用手动切一下再看。
   */
  readonly onDidSnapshot = this._onDidSnapshot.event;

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
        // 这次落盘有没有 AI 参与：有就整条快照标 AI，
        // 时间线上用青色徽标区分，撤销时也据此判定。
        origin: this.originFor(files),
      });

      // 标记已消费：下一次普通保存不该还带着 AI 身份
      for (const f of files) this.aiTouched.delete(f);

      if (!out.ok) {
        // 存档失败不该打断写作：只提示，不弹窗阻塞
        console.warn(`[novelpad] 自动存档失败（${reason}）：${out.error}`);
        return;
      }

      // 滚动清理：每章只留最近 N 个（ref 与索引一起删）
      if (chapter) await pruneAutoSnapshots(nodeExec, root, chapter, AUTO_KEEP_PER_CHAPTER);

      // `empty: true` 表示内容和上一版一字不差，没造出记录——
      // 那种情况下不该触发自动备份，否则每按一次 Ctrl+S 都推一次。
      if (out.record) this._onDidSnapshot.fire(out.record);
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
      // 版本存下来了但没接上主干 → 「备份到云端」不会带上它。
      // 不说的话作者会以为存完就安全了。
      if (out.trunkSkipped) {
        void vscode.window.showWarningMessage(`这一版已存进时间线，但没接上备份：${out.trunkSkipped}`);
      }
      if (rec) this._onDidSnapshot.fire(rec);
    });
    return rec;
  }

  /**
   * 标记「这个文件的这次改动来自 AI」。
   *
   * 由 Copilot 在插入/替换正文后调用。不落盘、不进索引——它只在
   * 下一次 flush 时决定「这条快照要不要标 AI」。作者如果在这期间
   * 自己改了很多，标记照样生效（整个文件一起存档），撤销时
   * planAIUndo 会按段落把作者改过的地方留下来。
   */
  markAI(fileUri: vscode.Uri, info: { prompt?: string; model?: string } = {}): void {
    const root = this.store.root;
    if (!root) return;
    const rel = relFrom(root.fsPath, fileUri.fsPath);
    if (!rel) return;

    this.aiTouched.set(rel, {
      origin: { kind: "ai", prompt: info.prompt, model: info.model },
      at: Date.now(),
    });

    // AI 刚写完，很快就会被保存；把它排进队列，
    // 否则标记会等到下一次作者手动保存才生效，而那时
    // 可能已经过了 TTL，或者被后来的普通保存覆盖。
    this.lastQueued.set(rel, Date.now());
    this.pending.add(rel);
    const chapter = chapterKeyOf(rel);
    if (chapter) this.pendingChapter = chapter;
    this.armIdleTimer();
  }

  /** 取这次 flush 的 AI 来源：只有明确标记过且没过期的文件才算 */
  private originFor(files: readonly string[]): Origin | undefined {
    const now = Date.now();
    for (const f of files) {
      const m = this.aiTouched.get(f);
      if (m && now - m.at <= AI_MARK_TTL_MS) return m.origin;
    }
    return undefined;
  }

  /**
   * 撤销某次 AI 续写引入的段落。
   *
   * 只删 AI 新增的段，作者在这期间自己写的一概不动——细节与理由
   * 见 core 的 `planAIUndo`。这里负责三件内核不管的事：
   *   1. 找到「同章节的上一版」作为对比基线
   *   2. 走编辑器 API 改文件（保住撤销栈与保存状态）
   *   3. 改完立刻打一版存档，让时间线上有据可查
   */
  async undoAI(rec: SnapshotRecord): Promise<{ ok: boolean; message: string }> {
    const rootUri = this.store.root;
    if (!rootUri) return { ok: false, message: "没有打开作品" };
    const root = rootUri.fsPath;

    if (rec.origin.kind !== "ai") return { ok: false, message: "这一版不是 AI 写的" };
    const file = rec.files.find((f) => /^chapters\//.test(f)) ?? rec.files[0];
    if (!file) return { ok: false, message: "这一版没有记录改动文件" };

    const idx = loadIndex(root);
    // 基线：同章节、比它早的最近一版。
    // 优先取人写的——如果上一版也是 AI，减出来的「新增」会包含
    // 上一次 AI 的产出，撤销一次就把两次续写都删了。
    const same = idx.snapshots.filter((s) => s.chapter && s.chapter === rec.chapter && s.time < rec.time);
    const prev =
      same.filter((s) => s.origin.kind === "human").sort((a, b) => (a.time < b.time ? 1 : -1))[0] ??
      same.sort((a, b) => (a.time < b.time ? 1 : -1))[0];

    const aiText = await readSnapshotFile(nodeExec, root, rec, file);
    if (aiText === undefined) return { ok: false, message: `这一版里没有 ${file}` };
    const prevText = prev ? await readSnapshotFile(nodeExec, root, prev, file) : undefined;

    // 以磁盘上的当前内容为准：作者可能已经改过，甚至关了编辑器
    const uri = vscode.Uri.joinPath(rootUri, ...file.split("/"));
    let currentText: string;
    try {
      currentText = await vscode.workspace.fs.readFile(uri).then((b) => Buffer.from(b).toString("utf8"));
    } catch {
      return { ok: false, message: `打不开 ${file}` };
    }

    const plan = planAIUndo({ prevText, aiText, currentText });
    if (plan.noop) return { ok: false, message: describeUndo(plan) };

    // 用编辑器改而不是直接写文件：作者可能正开着这一章，
    // 直接写磁盘会让他的编辑器变成「磁盘已变」状态，撤销栈也断了。
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    const ok = await editor.edit((eb) => eb.replace(full, plan.text), {
      undoStopBefore: true,
      undoStopAfter: true,
    });
    if (!ok) return { ok: false, message: "改动被编辑器拒绝，可能文件正被占用" };

    await doc.save();

    // 打完这版再返回：时间线上立刻能看到「撤销」这个动作
    await this.flush("manual");
    return { ok: true, message: describeUndo(plan) };
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
    this._onDidSnapshot.dispose();
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