/**
 * AI 分账（docs/PLAN-VERSIONING.md §5.3）。
 *
 * 目标：作者点「撤销这次续写」时，**只删掉 AI 写进来的段落**，
 * 他在这期间自己改的地方一个字都不能动。
 *
 * 为什么只能按「整段」拆，不能按字拆：
 *   AI 续写是插入，插入的段落与原有段落之间没有可追踪的边界。
 *   `changed` 段落（AI 在作者原句里改了半句）无法区分哪几个字是 AI 的、
 *   哪几个字是作者后来又改的——拆错就是删掉作者的句子。
 *   所以 `changed` 一律不动，只在界面上如实报告「有 N 段混在一起」。
 *
 * 纯函数，无 IO，无 vscode 依赖。
 */
import { diffParagraphs } from "./diff.js";

/* ============================================================
 * frontmatter
 * ============================================================ */

export interface FrontmatterSplit {
  /** 含结尾换行的 frontmatter；没有则为空串 */
  head: string;
  body: string;
}

/**
 * 拆出 frontmatter。
 *
 * 必须拆：frontmatter 里的 `wordCount: 3120` 在 AI 续写后会变成
 * `wordCount: 4210`——那是一个 `changed` 段落。虽然它不会被当作
 * 「AI 新增」删掉，但把它排除在 diff 之外能让统计更干净。
 */
export function splitFrontmatter(text: string): FrontmatterSplit {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  if (!m) return { head: "", body: text };
  return { head: m[0], body: text.slice(m[0].length) };
}

/* ============================================================
 * 段落定位
 * ============================================================ */

interface Span {
  text: string;
  /** 段首在原串中的下标 */
  start: number;
  /** 段尾（不含行尾空白） */
  end: number;
}

/**
 * 扫描出所有段落的**原文偏移**。
 *
 * 不能用 `split` 再累加长度：带捕获组的 `split` 只交出最后一次捕获，
 * 连续空行 "\n\n\n" 会被算成一个 "\n"，累加出来的偏移直接错位——
 * 删掉的就是别人的句子。
 */
function paragraphSpans(text: string): Span[] {
  const spans: Span[] = [];
  const n = text.length;
  let start = -1;
  let i = 0;

  const flush = (endOfLine: number) => {
    if (start < 0) return;
    let end = endOfLine;
    // 段尾的空白（含行尾的 \r）不属于段落正文
    while (end > start && /\s/.test(text[end - 1]!)) end--;
    spans.push({ text: text.slice(start, end), start, end });
    start = -1;
  };

  while (i <= n) {
    let lineEnd = i;
    while (lineEnd < n && text[lineEnd] !== "\n" && text[lineEnd] !== "\r") lineEnd++;
    const blank = text.slice(i, lineEnd).trim().length === 0;

    if (blank) flush(i);
    else if (start < 0) start = i;

    if (lineEnd >= n) break;
    // \r\n 算一个分隔
    i = lineEnd + (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n" ? 2 : 1);
  }
  flush(n);

  return spans;
}

/** 只用于比较：忽略空白差异 */
function normalize(p: string): string {
  return p.replace(/\s+/g, " ").trim();
}

/** 第二级比较：连空白都不要（作者可能重排过空格/全半角间距） */
function squeeze(p: string): string {
  return p.replace(/\s+/g, "");
}

/** 文件主要用哪种换行。AI 段落是 LF，要在 CRLF 文件里找得到 */
function detectEol(text: string): "\r\n" | "\n" {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * 从 `text` 的 `[start, end)` 删掉一段，并连带吃掉一侧的分隔空行。
 *
 * 只删段落不删空行会留下「一段、空行、空行、一段」，
 * 作者下次编辑时看到连续空行，以为编辑器坏了。
 */
function stripAt(text: string, start: number, end: number): string {
  const after = text.slice(end);
  const right = /^[ \t]*(?:\r?\n[ \t]*){2,}/.exec(after);
  if (right) return text.slice(0, start) + after.slice(right[0].length);

  // 段落在文件末尾（后面至多一个换行）→ 改吃左侧的空行
  const before = text.slice(0, start);
  const left = /(?:[ \t]*\r?\n){2,}[ \t]*$/.exec(before);
  if (left) return before.slice(0, left.index) + after;
  return before + after;
}

/* ============================================================
 * 撤销计划
 * ============================================================ */

export interface AIUndoInput {
  /** 这次续写之前的同章存档；undefined 表示没有可比的上文 */
  prevText: string | undefined;
  /** AI 快照里的文件内容 */
  aiText: string;
  /** 此刻磁盘上的文件内容（作者可能又改过） */
  currentText: string;
}

export interface AIUndoPlan {
  /** 应用后应写回的完整文件内容 */
  text: string;
  /** 真正删掉的段数 */
  removed: number;
  /** AI 写过、但作者已经改得对不上原文，因而保留的段数 */
  kept: number;
  /** AI 改动混进作者原有段落的段数（无法自动拆） */
  mixed: number;
  removedParagraphs: string[];
  keptParagraphs: string[];
  /** 什么都没删 */
  noop: boolean;
  /** noop 时的人话原因 */
  reason?: string;
}

export function planAIUndo(input: AIUndoInput): AIUndoPlan {
  const empty = (reason: string): AIUndoPlan => ({
    text: input.currentText,
    removed: 0,
    kept: 0,
    mixed: 0,
    removedParagraphs: [],
    keptParagraphs: [],
    noop: true,
    reason,
  });

  // 没有上一版就无从判断哪些段是 AI 加的。
  // 宁可什么都不做，也不能把作者整章删掉。
  if (input.prevText === undefined) {
    return empty("这一版之前没有同章存档，分不清哪些是 AI 写的");
  }
  if (!input.aiText.trim()) return empty("这一版没有正文内容");

  const prev = splitFrontmatter(input.prevText);
  const ai = splitFrontmatter(input.aiText);
  const cur = splitFrontmatter(input.currentText);

  const diff = diffParagraphs(prev.body, ai.body);
  const added = diff.blocks.filter((b) => b.type === "added").map((b) => b.after);
  const mixed = diff.blocks.filter((b) => b.type === "changed").length;

  if (!added.length) {
    return {
      ...empty(
        mixed > 0
          ? `这次续写是改在原有段落里的（${mixed} 段），没法按段拆开。请用时间线的对比手动改回。`
          : "这一版没有新增段落，没什么可撤销的",
      ),
      mixed,
    };
  }

  const eol = detectEol(cur.body);
  let body = cur.body;
  let cursor = 0;
  let removed = 0;
  let kept = 0;
  const removedParagraphs: string[] = [];
  const keptParagraphs: string[] = [];

  for (const p of added) {
    // diff 里的段落已归一成 LF；文件可能是 CRLF，先折算回文件风格，
    // 否则 indexOf 永远找不到，撤销会静默失效（Windows 上必现）。
    const want = eol === "\r\n" ? p.replace(/\n/g, "\r\n") : p;

    const hit = body.indexOf(want, cursor);
    if (hit >= 0) {
      body = stripAt(body, hit, hit + want.length);
      // 从同一位置继续找：AI 段落保持文档顺序，这样既能处理
      // 「作者把段落挪过位置」，也不会误删前面内容相同的段。
      cursor = hit;
      removed++;
      removedParagraphs.push(p);
      continue;
    }

    // 精确匹配失败：作者可能改了几个字或空格。
    // 按段落扫描 + 归一比较，找到就用它的**实际**偏移删。
    //
    // 两级比较：先忽略空白差异（normalize），再退到完全忽略空白（squeeze）。
    // 中文作者常见的「格式化」是在句号后补空格、或把全角空格换成半角，
    // 这些都会让 normalize 的结果仍然不同（"A， B" vs "A，B"）。
    const target = normalize(p);
    const targetSq = squeeze(p);
    let found = false;
    if (targetSq) {
      for (const span of paragraphSpans(body)) {
        const same = normalize(span.text) === target || squeeze(span.text) === targetSq;
        if (!same) continue;
        body = stripAt(body, span.start, span.end);
        cursor = span.start;
        removed++;
        removedParagraphs.push(span.text);
        found = true;
        break;
      }
    }
    if (!found) {
      kept++;
      keptParagraphs.push(p);
    }
  }

  return {
    text: cur.head + body,
    removed,
    kept,
    mixed,
    removedParagraphs,
    keptParagraphs,
    noop: removed === 0,
    reason: removed === 0 ? "你改过的段落已经和 AI 原文对不上了，没有能安全删掉的部分" : undefined,
  };
}

/* ============================================================
 * 人话摘要
 * ============================================================ */

export function describeUndo(plan: AIUndoPlan): string {
  if (plan.noop) return plan.reason ?? "没有可撤销的内容";
  const parts = [`删掉 ${plan.removed} 段`];
  if (plan.kept) parts.push(`保留 ${plan.kept} 段（你改过）`);
  if (plan.mixed) parts.push(`${plan.mixed} 段是改在原有段落里的，没动`);
  return parts.join("，");
}