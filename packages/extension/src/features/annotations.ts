/**
 * 编辑批注（共创 A）：把 annotate.ts 的锚点算法接到编辑器上。
 *
 * 五个部分，各自对应计划 §5.1 的一条要求：
 *
 *   1. 存储        .novelpad/annotations.jsonl（跟稿子一起进 git）
 *   2. 装饰        有批注的文本画波浪下划线
 *   3. Hover       悬停显示批注正文与线程
 *   4. CodeLens    建议模式显示「接受 / 拒绝」
 *   5. 侧栏树      按文件分组，失效批注单独列出
 *
 * ── 为什么装饰要重算而不是缓存 ──
 *
 * 锚点存的是「引文 + 前后文 + 偏移」，正文一改就要重新定位。
 * 缓存区间会让批注停在旧位置，看起来像「批注跑到别的段落去了」。
 * 所以每次文档变化都重新 resolveAll，代价是线性扫描一遍全文——
 * 单章几十 KB、批注几十条，实测在毫秒级。
 *
 * ── 为什么接受建议要校验 before ──
 *
 * 建议是「把 before 换成 after」。作者可能在编辑提完建议之后自己改过那句，
 * 此时盲目替换会**覆盖作者的新写法**。所以先确认原文仍然是 before，
 * 不一致就提示「原文已变，这条建议需要人工处理」，绝不动手改。
 */
import * as vscode from "vscode";
import path from "node:path";
import {
  type Annotation,
  type AnnotationAuthor,
  type ResolvedAnnotation,
  createAnnotation,
  isVisible,
  resolveAll,
  stats,
} from "@novelpad/core";
import {
  addAnnotation,
  annotationsPath,
  dedupeById,
  loadAnnotations,
  removeAnnotation,
  replyToAnnotation,
  setAnnotationStatus,
} from "@novelpad/core";
import type { ProjectStore } from "../store";
import { escapeMd, statusLabel, truncate } from "./annotations-rules";

const ID = {
  view: "novelpad.annotations",
  refresh: "novelpad.annotations.refresh",
  addComment: "novelpad.annotations.addComment",
  addSuggestion: "novelpad.annotations.addSuggestion",
  resolve: "novelpad.annotations.resolve",
  reopen: "novelpad.annotations.reopen",
  remove: "novelpad.annotations.remove",
  accept: "novelpad.annotations.accept",
  reject: "novelpad.annotations.reject",
  reply: "novelpad.annotations.reply",
  goto: "novelpad.annotations.goto",
} as const;

/** 作者身份。没有账号体系，用 git 配置里的邮箱；拿不到就 local。 */
export interface AuthorResolver {
  (): AnnotationAuthor;
}

export class AnnotationsFeature implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly tree: AnnotationsProvider;
  private readonly commentDeco: vscode.TextEditorDecorationType;
  private readonly suggestionDeco: vscode.TextEditorDecorationType;
  /** CodeLens 要能主动刷新：文本一改，建议的位置就变了 */
  private readonly lenses: SuggestionLenses;
  /** 当前文档 → 已定位的批注；hover / codelens / 接受建议都查这里 */
  private resolved = new Map<string, ResolvedAnnotation[]>();
  /**
   * 实时算出的「失效」批注 id。
   *
   * 为什么不写回文件：锚点失效可能是**暂时的**——切到还没写这一章的分支、
   * 作者正把段落整段重写。一旦把 orphaned 落盘就再也回不去 open
   * （计划里写明「锚点已丢，重新定位没有意义」），切回原分支时批注
   * 就永久报废了。所以这里只做派生状态：原文回来了，批注自动复活。
   *
   * 已落盘的 orphaned（旧版本或手改文件写入的）仍然当作失效处理。
   */
  private orphanedIds = new Set<string>();
  private annotations: Annotation[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ProjectStore,
    private readonly author: AuthorResolver,
    private readonly output: vscode.OutputChannel,
  ) {
    this.tree = new AnnotationsProvider(() => this.effective());
    this.lenses = new SuggestionLenses(this);
    this.commentDeco = vscode.window.createTextEditorDecorationType({
      textDecoration: "none; border-bottom: 1px dotted; border-bottom-color: currentColor;",
      // 用编辑器现有的「有信息但非错误」色，不自己发明颜色
      overviewRulerColor: new vscode.ThemeColor("editorInfo.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.suggestionDeco = vscode.window.createTextEditorDecorationType({
      textDecoration: "none; border-bottom: 1px dashed; border-bottom-color: currentColor;",
      overviewRulerColor: new vscode.ThemeColor("editorWarning.foreground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    // 失效批注不画在正文里（已经没有位置），但在树里要能看见

    this.disposables.push(
      this.commentDeco,
      this.suggestionDeco,
      vscode.languages.registerHoverProvider({ language: "markdown", scheme: "file" }, new AnnotationHover(this)),
      vscode.languages.registerCodeLensProvider({ language: "markdown", scheme: "file" }, this.lenses),
      ...this.registerCommands(),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (this.isProjectDoc(e.document)) this.scheduleResolve(e.document);
      }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshDecorations()),
      this.store.onDidChange(() => void this.reload()),
      // 别人改了 annotations.jsonl（切分支、pull、手改文件）要跟上
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.uri.fsPath === this.path()) void this.reload();
      }),
    );

    void this.reload();
  }

  /* ============================================================
   * 数据
   * ============================================================ */

  private path(): string | undefined {
    const root = this.store.root?.fsPath;
    return root ? annotationsPath(root) : undefined;
  }

  /** 重新读盘 + 重新定位 + 刷新所有界面 */
  async reload(): Promise<void> {
    const root = this.store.root?.fsPath;
    if (!root) {
      this.annotations = [];
      this.resolved.clear();
      this.orphanedIds.clear();
      this.refreshDecorations();
      this.tree.refresh();
      this.syncBadge();
      return;
    }
    this.annotations = dedupeById(loadAnnotations(root));
    for (const ed of vscode.window.visibleTextEditors) this.resolveFor(ed.document);
    this.refreshDecorations();
    this.tree.refresh();
    this.syncBadge();
    this.lenses.refresh();
  }

  /** 给一份文档重新定位全部批注 */
  private resolveFor(doc: vscode.TextDocument): ResolvedAnnotation[] {
    const rel = this.relPath(doc.uri.fsPath);
    if (!rel) return [];
    const mine = this.annotations.filter((a) => a.file === rel);
    if (!mine.length) {
      this.resolved.delete(doc.uri.toString());
      return [];
    }
    const text = doc.getText();
    const out = resolveAll(text, mine);

    // 这一章的失效集合整体重算（不能只增不减，否则改回来也不复活）
    for (const a of mine) this.orphanedIds.delete(a.id);
    for (const r of out) {
      if (r.range.via === "orphaned") this.orphanedIds.add(r.annotation.id);
    }

    this.resolved.set(doc.uri.toString(), out);
    return out;
  }

  /**
   * 叠加派生状态后的批注列表。
   *
   * 树、徽标、命令面板里的选择列表统一走这里，保证「侧栏说失效」
   * 和「正文里没画线」永远一致——两处各算一次必然会漂。
   */
  private effective(): Annotation[] {
    if (this.orphanedIds.size === 0) return this.annotations;
    return this.annotations.map((a) =>
      a.status === "open" && this.orphanedIds.has(a.id) ? { ...a, status: "orphaned" as const } : a,
    );
  }

  private scheduleResolve(doc: vscode.TextDocument): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.resolveFor(doc);
      this.refreshDecorations();
      this.tree.refresh();
      // CodeLens 不跟着刷就会停在旧行；hover 和装饰都重算了，它也必须重算
      this.lenses.refresh();
    }, 260);
  }

  /* ============================================================
   * 装饰
   * ============================================================ */

  private refreshDecorations(): void {
    for (const ed of vscode.window.visibleTextEditors) {
      if (!this.isProjectDoc(ed.document)) {
        ed.setDecorations(this.commentDeco, []);
        ed.setDecorations(this.suggestionDeco, []);
        continue;
      }
      const list = this.resolved.get(ed.document.uri.toString()) ?? this.resolveFor(ed.document);
      const comments: vscode.DecorationOptions[] = [];
      const suggestions: vscode.DecorationOptions[] = [];

      for (const r of list) {
        if (!isVisible(r.annotation)) continue; // accepted / rejected / orphaned 不画
        if (r.range.via === "orphaned" || r.range.start < 0) continue;
        // 运行时判定的失效：resolveAll 只在返回副本上标 orphaned，
        // 所以 status 仍是 open，必须靠 range.via 或 orphanedIds 拦住
        if (this.orphanedIds.has(r.annotation.id)) continue;
        // 防御：文本在这两次计算之间又被改了，区间可能越界
        const max = ed.document.getText().length;
        const start = Math.min(r.range.start, max);
        const end = Math.min(r.range.end, max);
        if (end <= start) continue;

        const opt: vscode.DecorationOptions = {
          range: new vscode.Range(ed.document.positionAt(start), ed.document.positionAt(end)),
          hoverMessage: hoverMarkdown(r.annotation),
        };
        if (r.annotation.kind === "suggestion") suggestions.push(opt);
        else comments.push(opt);
      }

      ed.setDecorations(this.commentDeco, comments);
      ed.setDecorations(this.suggestionDeco, suggestions);
    }
  }

  /* ============================================================
   * 命令
   * ============================================================ */

  private registerCommands(): vscode.Disposable[] {
    const guard = <T extends unknown[]>(fn: (...a: T) => Promise<void> | void) => async (...a: T) => {
      if (!this.store.root) {
        void vscode.window.showWarningMessage("请先打开一个作品");
        return;
      }
      try {
        await fn(...a);
      } catch (e) {
        // 命令里抛异常在 VS Code 里只显示一句「命令失败」，不给原因
        this.output.appendLine(`[annotations] 命令失败：${String(e)}`);
        void vscode.window.showErrorMessage(`批注操作失败：${e instanceof Error ? e.message : String(e)}`);
      }
    };

    return [
      vscode.commands.registerCommand(ID.refresh, guard(() => this.reload())),

      // 从编辑器当前选区加一条
      vscode.commands.registerCommand(
        ID.addComment,
        guard(() => this.addFromSelection("comment")),
      ),
      vscode.commands.registerCommand(
        ID.addSuggestion,
        guard(() => this.addFromSelection("suggestion")),
      ),

      vscode.commands.registerCommand(
        ID.resolve,
        guard(async (node?: AnnotationNode) => {
          const id = node?.annotation.id ?? (await this.pickAnnotation());
          if (id) await this.changeStatus(id, "resolved");
        }),
      ),
      vscode.commands.registerCommand(
        ID.reopen,
        guard(async (node?: AnnotationNode) => {
          const id = node?.annotation.id ?? (await this.pickAnnotation());
          if (id) await this.changeStatus(id, "open");
        }),
      ),
      vscode.commands.registerCommand(
        ID.remove,
        guard(async (node?: AnnotationNode) => {
          const id = node?.annotation.id ?? (await this.pickAnnotation());
          if (!id || !this.store.root) return;
          const hit = this.effective().find((a) => a.id === id);
          const ok = await vscode.window.showWarningMessage(
            `删除这条批注？\n\n${hit ? truncate(hit.body, 60) : ""}`,
            { modal: true },
            "删除",
          );
          if (ok !== "删除" || !this.store.root) return;
          removeAnnotation(this.store.root.fsPath, id);
          await this.reload();
        }),
      ),

      vscode.commands.registerCommand(
        ID.accept,
        guard(async (node?: AnnotationNode) => {
          // 从命令面板调用时没有节点参数，让作者从建议列表里挑一条。
          // 不能静默返回——点了命令却毫无反应是最难查的一类 bug。
          const a = node?.annotation ?? (await this.pickSuggestion());
          if (a) await this.acceptSuggestion(a);
        }),
      ),
      vscode.commands.registerCommand(
        ID.reject,
        guard(async (node?: AnnotationNode) => {
          const a = node?.annotation ?? (await this.pickSuggestion());
          if (!a) return;
          await this.setStatusAndReload(a.id, "rejected");
        }),
      ),

      vscode.commands.registerCommand(
        ID.reply,
        guard(async (node?: AnnotationNode) => {
          const a = node?.annotation;
          if (!a || !this.store.root) return;
          const body = await vscode.window.showInputBox({ prompt: "回复这条批注", placeHolder: "写点什么" });
          if (!body?.trim()) return;
          replyToAnnotation(this.store.root.fsPath, a.id, {
            author: this.author(),
            time: new Date().toISOString(),
            body: body.trim(),
          });
          await this.reload();
        }),
      ),

      vscode.commands.registerCommand(
        ID.goto,
        guard(async (node?: AnnotationNode) => {
          if (node) await this.reveal(node.annotation);
        }),
      ),
    ];
  }

  /** 从当前编辑器选区新建批注 */
  private async addFromSelection(kind: Annotation["kind"]): Promise<void> {
    const root = this.store.root?.fsPath;
    const ed = vscode.window.activeTextEditor;
    if (!root || !ed) {
      void vscode.window.showWarningMessage("请先打开一个章节");
      return;
    }
    if (!this.isProjectDoc(ed.document)) {
      void vscode.window.showWarningMessage("只能在作品内的 Markdown 里加批注");
      return;
    }
    const sel = ed.selection;
    if (sel.isEmpty) {
      void vscode.window.showWarningMessage("先选中要批注的文字");
      return;
    }
    const text = ed.document.getText();
    const start = ed.document.offsetAt(sel.start);
    const end = ed.document.offsetAt(sel.end);
    const quote = text.slice(start, end);

    const body = await vscode.window.showInputBox({
      prompt: kind === "suggestion" ? `为「${truncate(quote, 20)}」提一个改法` : "批注内容",
      placeHolder: kind === "suggestion" ? "说明为什么要改（可留空）" : "这条批注说什么",
    });
    if (body === undefined) return; // 用户取消

    let after: string | undefined;
    if (kind === "suggestion") {
      after = await vscode.window.showInputBox({
        prompt: "改成什么？（原文是你刚选中的那段）",
        value: quote,
        placeHolder: "替换后的文字",
      });
      if (after === undefined) return;
      if (after === quote) {
        void vscode.window.showInformationMessage("改法与原文相同，没有必要提这条建议");
        return;
      }
    }

    const rel = this.relPath(ed.document.uri.fsPath);
    if (!rel) return;

    const a = createAnnotation({
      file: rel,
      text,
      start,
      end,
      body: body.trim() || (kind === "suggestion" ? "建议这样改" : "（无正文）"),
      kind,
      ...(kind === "suggestion" && after !== undefined ? { suggestion: { after } } : {}),
      author: this.author(),
      now: new Date(),
    });

    addAnnotation(root, a);
    await this.reload();
    void vscode.window.setStatusBarMessage(`已添加批注：${truncate(quote, 20)}`, 3000);
  }

  /**
   * 接受建议。
   *
   * 三种失败都要显式告知，不能静默：
   *   1. 找不到 suggestion（数据不全）
   *   2. 锚点已失效（原文被删）
   *   3. 原文已变（作者改过那句）→ **绝不覆盖**，交给人工
   */
  private async acceptSuggestion(a: Annotation | undefined): Promise<void> {
    if (!a) return;
    if (!a.suggestion) {
      void vscode.window.showWarningMessage("这条批注不是建议模式，没有可应用的内容");
      return;
    }
    const root = this.store.root?.fsPath;
    if (!root) return;

    const doc = await this.openFileFor(a.file);
    if (!doc) return;
    const text = doc.getText();

    // 重新定位到当前文本
    const located = resolveAll(text, [a])[0];
    if (!located || located.range.via === "orphaned" || located.range.start < 0) {
      void vscode.window.showWarningMessage("原文已找不到，这条建议无法自动应用。请手动处理。");
      return;
    }

    const { start, end } = located.range;
    const actual = text.slice(start, end);
    if (actual !== a.suggestion.before) {
      // 作者改过那句。覆盖他就是毁掉他的修改。
      const pick = await vscode.window.showWarningMessage(
        `原文已不是你提建议时的样子，不能自动替换。\n\n现在的内容：${truncate(actual, 40)}`,
        "仍然替换",
        "取消",
      );
      if (pick !== "仍然替换") return;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), a.suggestion.after);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      void vscode.window.showErrorMessage("替换失败，文件可能已被其他程序修改");
      return;
    }
    await doc.save();
    await this.setStatusAndReload(a.id, "accepted");
    void vscode.window.setStatusBarMessage("已接受建议", 3000);
  }

  /** 打开某章；已打开就复用，避免开一堆标签 */
  private async openFileFor(rel: string): Promise<vscode.TextDocument | undefined> {
    const root = this.store.root?.fsPath;
    if (!root) return undefined;
    const uri = vscode.Uri.file(path.join(root, rel));
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open;
    try {
      return await vscode.workspace.openTextDocument(uri);
    } catch {
      void vscode.window.showErrorMessage(`打不开 ${rel}`);
      return undefined;
    }
  }

  /** 跳转到批注位置 */
  private async reveal(a: Annotation): Promise<void> {
    const doc = await this.openFileFor(a.file);
    if (!doc) return;
    const located = resolveAll(doc.getText(), [a])[0];
    const ed = await vscode.window.showTextDocument(doc, { preview: false });

    if (!located || located.range.via === "orphaned" || located.range.start < 0) {
      void vscode.window.showWarningMessage("这条批注的原文已不存在，无法定位");
      return;
    }
    const pos = ed.document.positionAt(located.range.start);
    ed.selection = new vscode.Selection(pos, ed.document.positionAt(located.range.end));
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }

  /** 没有树节点参数时的兜底：让用户从列表里选 */
  private async pickAnnotation(): Promise<string | undefined> {
    const open = this.effective().filter((a) => a.status === "open");
    if (!open.length) {
      void vscode.window.showInformationMessage("没有未处理的批注");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      open.map((a) => ({
        label: truncate(a.body, 50),
        description: `${a.file}${a.kind === "suggestion" ? " · 建议" : ""}`,
        id: a.id,
      })),
      { placeHolder: "选一条批注" },
    );
    return pick?.id;
  }

  /** 从命令面板接受/拒绝建议时的兜底选择 */
  private async pickSuggestion(): Promise<Annotation | undefined> {
    const open = this.effective().filter((a) => a.kind === "suggestion" && isVisible(a));
    if (!open.length) {
      void vscode.window.showInformationMessage("没有待处理的修改建议");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      open.map((a) => ({
        label: truncate(a.body, 50),
        description: `${a.file} · 改为「${truncate(a.suggestion?.after ?? "", 30)}」`,
        annotation: a,
      })),
      { placeHolder: "选一条建议" },
    );
    return pick?.annotation;
  }

  private async changeStatus(id: string, status: Annotation["status"]): Promise<void> {
    await this.setStatusAndReload(id, status);
  }

  private async setStatusAndReload(id: string, status: Annotation["status"]): Promise<void> {
    const root = this.store.root?.fsPath;
    if (!root) return;
    setAnnotationStatus(root, id, status);
    await this.reload();
  }

  /* ============================================================
   * 徽标
   *
   * TreeView 实例由 extension.ts 创建后交进来。批注视图的三态
   * （待处理数 / 无 / 失效告警）就在这里同步，不在别处重复算。
   * ============================================================ */

  /** 由外部把 TreeView 实例交进来，用它设徽标 */
  attachBadge(view: vscode.TreeView<unknown>): void {
    this.badgeView = view;
    this.syncBadge();
  }

  private badgeView?: vscode.TreeView<unknown>;

  private syncBadge(): void {
    if (!this.badgeView) return;
    const s = stats(this.effective());
    if (s.orphaned > 0) {
      // 失效批注要显眼：它们是「有东西丢了」的信号，不能和普通待处理混在一起
      this.badgeView.badge =
        s.open > 0
          ? { value: s.open, tooltip: `${s.open} 条待处理，${s.orphaned} 条已失效` }
          : { value: s.orphaned, tooltip: `${s.orphaned} 条批注已失效，需要人工处理` };
      return;
    }
    this.badgeView.badge = s.open > 0 ? { value: s.open, tooltip: `${s.open} 条待处理批注` } : undefined;
  }

  /** 判断文档是否属于作品 */
  isProjectDoc(doc: vscode.TextDocument): boolean {
    return Boolean(this.relPath(doc.uri.fsPath));
  }

  /** 绝对路径 → 作品相对路径；不在作品内返回 undefined */
  relPath(abs: string): string | undefined {
    const root = this.store.root?.fsPath;
    if (!root) return undefined;
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    const base = norm(root).replace(/\/+$/, "");
    const file = norm(abs);
    if (file === base) return "";
    if (!file.startsWith(base + "/")) return undefined;
    return abs.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  }

  /** 供 hover / codelens 查询某文档已定位的批注 */
  forDocument(doc: vscode.TextDocument): ResolvedAnnotation[] {
    return this.resolved.get(doc.uri.toString()) ?? this.resolveFor(doc);
  }

  all(): readonly Annotation[] {
    return this.effective();
  }

  /** 树视图的数据源。TreeView 由 extension.ts 创建（它要拿实例设徽标） */
  treeProvider(): vscode.TreeDataProvider<unknown> {
    return this.tree as unknown as vscode.TreeDataProvider<unknown>;
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    this.lenses.dispose();
  }
}

/* ============================================================
 * Hover：悬停看线程
 * ============================================================ */

class AnnotationHover implements vscode.HoverProvider {
  constructor(private readonly feature: AnnotationsFeature) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const anchors = this.feature.forDocument(doc);
    if (!anchors.length) return undefined;
    const offset = doc.offsetAt(pos);

    const hit = anchors.find(
      (r) => isVisible(r.annotation) && r.range.start >= 0 && offset >= r.range.start && offset <= r.range.end,
    );
    if (!hit) return undefined;

    const md = hoverMarkdown(hit.annotation);
    return new vscode.Hover(md, new vscode.Range(doc.positionAt(hit.range.start), doc.positionAt(hit.range.end)));
  }
}

/* ============================================================
 * CodeLens：建议的接受 / 拒绝
 * ============================================================ */

class SuggestionLenses implements vscode.CodeLensProvider {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChange.event;

  constructor(private readonly feature: AnnotationsFeature) {}

  /**
   * 文本一改，建议的位置就变了，CodeLens 必须重算。
   * 不触发的话「接受 / 拒绝」会停在上一次的旧行上，
   * 作者会点到一个已经和这段文字无关的按钮。
   */
  refresh(): void {
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const out: vscode.CodeLens[] = [];
    for (const r of this.feature.forDocument(doc)) {
      const a = r.annotation;
      if (a.kind !== "suggestion" || !isVisible(a)) continue;
      if (r.range.via === "orphaned" || r.range.start < 0) continue;

      const start = doc.positionAt(r.range.start);
      const range = new vscode.Range(start, start);

      // 必须把批注本身传进去：命令收到 undefined 时只能静默返回，
      // 作者点了「接受建议」却什么都没发生——比报错更难查。
      out.push(
        new vscode.CodeLens(range, {
          title: "接受建议",
          command: ID.accept,
          arguments: [{ kind: "annotation", annotation: a }],
        }),
        new vscode.CodeLens(range, {
          title: "拒绝",
          command: ID.reject,
          arguments: [{ kind: "annotation", annotation: a }],
        }),
      );
    }
    return out;
  }
}

/* ============================================================
 * 侧栏树：按文件分组，失效单独列出
 * ============================================================ */

type Node = FileNode | AnnotationNode | SectionNode;

interface SectionNode {
  kind: "section";
  label: string;
  children: AnnotationNode[];
}

interface FileNode {
  kind: "file";
  file: string;
  children: SectionNode[];
}

interface AnnotationNode {
  kind: "annotation";
  annotation: Annotation;
}

class AnnotationsProvider implements vscode.TreeDataProvider<Node> {
  private readonly _onDidChange = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private readonly getAnnotations: () => readonly Annotation[]) {}

  refresh(): void {
    this._onDidChange.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "file") {
      const n = node.children.reduce((s, c) => s + c.children.length, 0);
      const item = new vscode.TreeItem(node.file, vscode.TreeItemCollapsibleState.Expanded);
      item.description = `${n} 条`;
      item.iconPath = new vscode.ThemeIcon("file");
      item.contextValue = "file";
      return item;
    }
    if (node.kind === "section") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.children.length);
      item.contextValue = "section";
      return item;
    }

    const a = node.annotation;
    const isOpen = a.status === "open";
    const item = new vscode.TreeItem(truncate(a.body, 60), vscode.TreeItemCollapsibleState.None);
    item.id = a.id;
    item.description = [a.kind === "suggestion" ? "建议" : "", a.status === "open" ? "" : statusLabel(a.status), a.author.name ?? a.author.id]
      .filter(Boolean)
      .join(" · ");
    item.tooltip = tooltip(a);
    item.contextValue = isOpen ? (a.kind === "suggestion" ? "annotation.open.suggestion" : "annotation.open") : "annotation.closed";
    item.iconPath = new vscode.ThemeIcon(
      a.status === "orphaned" ? "warning" : a.kind === "suggestion" ? "lightbulb" : "comment-discussion",
    );
    item.command = {
      command: ID.goto,
      title: "跳转",
      arguments: [node],
    };
    return item;
  }

  getChildren(node?: Node): Node[] {
    const all = this.getAnnotations();
    if (!node) return this.rootNodes(all);

    if (node.kind === "file") return node.children;
    if (node.kind === "section") return node.children;
    return [];
  }

  private rootNodes(all: readonly Annotation[]): Node[] {
    // 失效批注放最上面独立一组：它们需要人工处理，藏在文件里会永远没人看
    const orphaned = all.filter((a) => a.status === "orphaned");
    const byFile = new Map<string, Annotation[]>();

    for (const a of all) {
      if (a.status === "orphaned") continue;
      const list = byFile.get(a.file);
      if (list) list.push(a);
      else byFile.set(a.file, [a]);
    }

    const out: Node[] = [];
    if (orphaned.length) {
      out.push({
        kind: "section",
        label: "失效批注（原文已找不到）",
        children: orphaned.map((annotation) => ({ kind: "annotation" as const, annotation })),
      });
    }

    for (const file of [...byFile.keys()].sort()) {
      const list = byFile.get(file)!;
      const open = list.filter((a) => a.status === "open");
      const closed = list.filter((a) => a.status !== "open");
      const children: SectionNode[] = [];
      // 未处理的排前面，处理过的折叠成一组
      if (open.length) children.push({ kind: "section", label: "待处理", children: open.map((annotation) => ({ kind: "annotation", annotation })) });
      if (closed.length) children.push({ kind: "section", label: "已处理", children: closed.map((annotation) => ({ kind: "annotation", annotation })) });
      out.push({ kind: "file", file, children });
    }
    return out;
  }
}

/* ============================================================
 * 渲染辅助
 * ============================================================ */

export function hoverMarkdown(a: Annotation): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false; // 批注正文来自文件，可能是别人写的

  md.appendMarkdown(`**${a.kind === "suggestion" ? "修改建议" : "批注"}** · ${escapeMd(a.author.name ?? a.author.id)}\n\n`);
  md.appendMarkdown(`${escapeMd(a.body)}\n\n`);

  if (a.suggestion) {
    md.appendMarkdown("---\n\n");
    md.appendMarkdown(`原文：${escapeMd(a.suggestion.before)}\n\n`);
    md.appendMarkdown(`改为：${escapeMd(a.suggestion.after)}\n\n`);
  }

  if (a.thread?.length) {
    md.appendMarkdown("---\n\n");
    for (const t of a.thread) {
      md.appendMarkdown(`**${escapeMd(t.author.name ?? t.author.id)}**：${escapeMd(t.body)}\n\n`);
    }
  }

  return md;
}

function tooltip(a: Annotation): vscode.MarkdownString {
  const md = hoverMarkdown(a);
  md.appendMarkdown(`\n\n—\n\n${escapeMd(a.file)} · ${a.created.slice(0, 16).replace("T", " ")}`);
  return md;
}


