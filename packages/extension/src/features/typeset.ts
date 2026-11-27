/**
 * L4 装饰级排版：给正文加「看不见的结构」。
 *
 * 为什么必须用装饰：Monaco 不会为 Markdown 做书籍排版。段首缩进、
 * 场景分隔的留白、备注变淡，这些是写作软件的语言，不是编辑器的语言。
 * 上游没有对应能力（全文搜 firstLineIndent 零命中），只能靠装饰补。
 *
 * ── 只用公开字段 ──
 *
 * 业界常见做法是往 `textDecoration` 里塞分号追加任意 CSS
 * （`textDecoration: 'none; padding-left: 2em;'`）。核实 1.85.0 源码后
 * 确认它**确实有效**（abstractCodeEditorService.ts:587 把值原样拼进样式表），
 * 但这里不用，原因见第 5 项。
 *
 * 全部走 API 支持的字段：color / backgroundColor / borderRadius /
 * textDecoration。它们只改颜色和装饰线，不动字符度量。
 *
 * 各类装饰挂在不同的 DOM 上，这决定了哪些属性有效：
 *   className    (isWholeLine) → 整行覆盖层 div：只收背景与边框
 *   inlineClassName            → 承载文字的 span：收颜色、装饰线
 *
 * 规则本身在 typeset-rules.ts（不依赖 vscode，可单测）。
 */
import * as vscode from "vscode";
import type { ProjectStore } from "../store";
import {
  COMMENT,
  SCENE_BREAK,
  WIKI_LINK,
  linesMatchingTexts,
  paragraphStartsFromTexts,
  spansOf,
} from "./typeset-rules";

interface Deco {
  type: vscode.TextEditorDecorationType;
  compute: (doc: vscode.TextDocument) => readonly vscode.Range[];
}

export class ProseDecorator implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private decos: Deco[] = [];
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly store: ProjectStore) {
    this.build();

    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.window.onDidChangeActiveTextEditor((ed) => {
        if (ed) this.apply(ed);
      }),
      // 作品是异步加载的：激活时 store.root 可能还是 undefined，
      // 那时 inProject 一律 false。等加载完成必须补刷一遍，
      // 否则要等用户切一次标签页才看得到排版。
      this.store.onDidChange(() => this.refreshAll()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        // 只处理可见文档，且节流：打字时每键都重算会卡
        if (vscode.window.visibleTextEditors.some((ed) => ed.document === e.document)) this.scheduleRefresh();
      }),
      // 设置改了就地重建。DecorationType 创建时样式就写进 CSS 了、不可变，
      // 所以只能整组销毁重建。让用户为一个开关重启整个 IDE 是不合适的。
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("novelpad.typeset")) this.rebuild();
      }),
      // 高对比度下要主动让路（见 isHighContrast）。主题切换也是配置变更，
      // 但 affectsConfiguration 对 workbench.colorTheme 不返回 true，
      // 必须单独听。否则切到 HC 后装饰还挂着，破坏对比度。
      vscode.window.onDidChangeActiveColorTheme(() => this.rebuild()),
    );

    this.refreshAll();
  }

  /* ============================================================
   * 装饰定义
   * ============================================================ */

  private build(): void {
    const cfg = vscode.workspace.getConfiguration("novelpad.typeset");

    /* ---------- 1. 章节标题：暖色底纹 ----------
     * 整行覆盖层（className）在 DOM 里先于文字插入（view.ts:216-219），
     * 所以它画在文字**下方**：底色能透出来，也不会挡住鼠标点击和光标。
     *
     * 为什么不用主题色：现成的底色全带语义——findMatchHighlight 是搜索
     * 命中色、lineHighlight 是当前行色，用哪个都会跟真实功能撞色。
     * 这里用一个固定的暖金薄雾（品牌色，配宣纸底），深浅两套都能读。
     *
     * 为什么不用字号 / 字重：它们改变字符实际宽度，而光标定位按字符
     * 宽度累加计算，结果整行光标偏移（见文件头）。
     *
     * 高对比度主题下不画：HC 要求前景背景强对比，一层薄底纹只会干扰。 */
    if (cfg.get<boolean>("headingBand", true) && !isHighContrast()) {
      this.decos.push({
        type: vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: "rgba(198, 160, 90, 0.13)",
          borderRadius: "3px",
        }),
        compute: (doc) => linesMatchingTexts(docLines(doc), /^#{1,6}\s+\S/).map((i) => wholeLine(doc, i)),
      });
    }

    /* ---------- 2. 场景分隔 *** 变留白 ----------
     * 作者写 `***` / `---` / `___` 表示场景切换。把字符变透明，
     * 视觉上就是一段空白；源码里那三个星号仍可点、可改、可复制。 */
    if (cfg.get<boolean>("sceneBreak", true) && !isHighContrast()) {
      this.decos.push({
        type: vscode.window.createTextEditorDecorationType({ color: "transparent" }),
        compute: (doc) => linesMatchingTexts(docLines(doc), SCENE_BREAK).map((i) => wholeLine(doc, i)),
      });
    }

    /* ---------- 3. 作者备注 <!-- --> 变淡 ----------
     * 注释意味着「这不是正文」。用主题的 disabledForeground，
     * 深浅两套自动跟随，不需要自己判断主题。 */
    if (cfg.get<boolean>("dimComments", true) && !isHighContrast()) {
      this.decos.push({
        type: vscode.window.createTextEditorDecorationType({
          color: new vscode.ThemeColor("disabledForeground"),
        }),
        compute: (doc) => spans(doc, COMMENT),
      });
    }

    /* ---------- 4. 双链 [[角色]] 着色 ----------
     * 只配色不动内容：`[[` `]]` 仍可见可编辑，
     * 否则作者会以为语法被吞了、或者不知道自己写错了。 */
    if (cfg.get<boolean>("wikiLinks", true)) {
      this.decos.push({
        type: vscode.window.createTextEditorDecorationType({
          color: new vscode.ThemeColor("textLink.foreground"),
          textDecoration: "underline dotted",
        }),
        compute: (doc) => spans(doc, WIKI_LINK),
      });
    }

    /* ---------- 5. 段首缩进 ----------
     * **默认关闭**，这是有意的，不是漏做。
     *
     * 唯一能让文字真正右移 2em 的办法是 padding-left，而它挂在写字的
     * span 上，会改变字符实际位置；Monaco 的 CharacterMapping 按字符宽度
     * 累加算光标位置，不知道这 2em 的存在。结果是每段首行的光标、选区、
     * 点击定位全部左偏 2em —— 小说几乎每段都是首行，等于全文都错。
     *
     * 结论：**不拿编辑手感换视觉**。段首缩进在导出时做（导出走 CST 排版，
     * 本来就带缩进），编辑区保持光标精确。这个开关留给愿意取舍的人。 */
    if (cfg.get<boolean>("firstLineIndent", false)) {
      this.decos.push({
        type: vscode.window.createTextEditorDecorationType({
          // 唯一的 CSS 注入点：textDecoration 的值被原样拼进样式表。
          // 不在公开契约里，且会破坏光标定位——只在用户显式开启时启用。
          textDecoration: "none; padding-left: 2em;",
        }),
        compute: (doc) => paragraphStartsFromTexts(docLines(doc)).map((i) => wholeLine(doc, i)),
      });
    }
  }

  private rebuild(): void {
    if (this.disposed) return;
    for (const d of this.decos) d.type.dispose();
    this.decos = [];
    this.build();
    this.refreshAll();
  }

  /* ============================================================
   * 应用
   * ============================================================ */

  /** 对当前所有可见编辑器刷一遍 */
  refreshAll(): void {
    if (this.disposed) return;
    for (const ed of vscode.window.visibleTextEditors) this.apply(ed);
  }

  private scheduleRefresh(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refreshAll(), 220);
  }

  private apply(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (doc.languageId !== "markdown" || !this.inProject(doc)) {
      // 非作品内的 Markdown（README、笔记）不该被排版；顺带清掉残留
      for (const d of this.decos) editor.setDecorations(d.type, []);
      return;
    }
    for (const d of this.decos) {
      try {
        editor.setDecorations(d.type, d.compute(doc));
      } catch {
        // 单个装饰失败退化为不装饰：不能影响其他项，更不能影响编辑
        editor.setDecorations(d.type, []);
      }
    }
  }

  private inProject(doc: vscode.TextDocument): boolean {
    const root = this.store.root?.fsPath;
    if (!root) return false;
    const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
    const file = norm(doc.uri.fsPath);
    const base = norm(root).replace(/\/+$/, "");
    return file === base || file.startsWith(base + "/");
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
    for (const d of this.decos) d.type.dispose();
    this.decos = [];
  }
}

/* ============================================================
 * vscode 适配层
 * ============================================================ */

/**
 * 当前是不是高对比度主题。
 *
 * HC 主题的设计前提是「前景/背景必须强对比，不允许额外的装饰干扰识别」。
 * 半透明底纹、变淡的灰色、虚线在 HC 下要么看不见，要么破坏对比度。
 * 高对比度用户往往有视力障碍，这里主动让路——宁可少一层装饰。
 */
function isHighContrast(): boolean {
  const kind = vscode.window.activeColorTheme.kind;
  return (
    kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight
  );
}

function docLines(doc: vscode.TextDocument): string[] {
  const out: string[] = [];
  for (let i = 0; i < doc.lineCount; i++) out.push(doc.lineAt(i).text);
  return out;
}

/**
 * 整行区间。
 *
 * 空行给 1 列：上游对零宽区间有特殊处理，装饰可能挂不上。
 * 场景分隔、标题这些基本都不为空，但兜一下更稳。
 */
function wholeLine(doc: vscode.TextDocument, line: number): vscode.Range {
  return new vscode.Range(line, 0, line, Math.max(1, doc.lineAt(line).text.length));
}

/** 字符偏移区间 → vscode.Range */
function spans(doc: vscode.TextDocument, re: RegExp): vscode.Range[] {
  return spansOf(doc.getText(), re).map((s) => new vscode.Range(doc.positionAt(s.start), doc.positionAt(s.end)));
}