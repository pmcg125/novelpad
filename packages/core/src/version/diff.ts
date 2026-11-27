/**
 * 段落级正文 diff —— 面向写作者，不是面向程序员。
 *
 * 为什么不用行级 diff：散文一段就是一行，行级 diff 会把「改了三个字」渲染成
 * 整段红 + 整段绿，作者看不出改了什么。
 *
 * 两步：
 *   1. 按空行切段（散文的天然单位）→ 段级 LCS → 相同 / 新增 / 删除 / 修改
 *   2. 「修改」的段再做字级 diff（中文按字，拉丁按词）→ 内联高亮
 *
 * 纯函数，无 IO，无 vscode 依赖。
 */
import { countWords } from "../text/words.js";

/* ============================================================
 * 类型
 * ============================================================ */

/** 内联片段：相同 / 新增 / 删除 */
export interface InlineSegment {
  op: "same" | "ins" | "del";
  text: string;
}

export type DiffBlock =
  | { type: "same"; before: string; after: string }
  | { type: "added"; after: string }
  | { type: "removed"; before: string }
  | { type: "changed"; before: string; after: string; inline: InlineSegment[] };

/** 折叠后的块：连续未变段落压成一条 */
export type FoldedBlock =
  | DiffBlock
  | { type: "fold"; count: number; before: string; after: string };

export interface DiffStats {
  /** 未变段落数 */
  same: number;
  /** 新增段落数 */
  added: number;
  /** 删除段落数 */
  removed: number;
  /** 修改段落数 */
  changed: number;
  /** 新增字数（按段落整体计） */
  wordsAdded: number;
  /** 删除字数 */
  wordsRemoved: number;
}

export interface ParagraphDiff {
  blocks: DiffBlock[];
  stats: DiffStats;
}

/** 性能护栏：单元格数超过此值就退化为「整段替换」 */
const MAX_DP_CELLS = 4_000_000;

/* ============================================================
 * 切段
 * ============================================================ */

/** 段落的唯一分隔是空行；单换行是段内折行，作者常用来断句 */
export function splitParagraphs(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    // 只清掉段首的空白行和段末的行尾空白；段首缩进的空格不动（可能是缩进写法）
    .map((p) => p.replace(/^(?:[ \t]*\n)+/, "").replace(/[ \t]+$/, ""))
    .filter((p) => p.length > 0 && p.trim().length > 0);
}

/* ============================================================
 * 字级 diff
 * ============================================================ */

/** 拉丁字母/数字串算一个词，其余每个字符一个 token（中文按字） */
const TOKEN_RE = /[A-Za-z0-9'’\-]+|[\s\S]/g;

export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? [];
}

/**
 * 字级差异。先砍掉公共前后缀——绝大多数编辑都是「中间改几个字」，
 * 砍完通常只剩十几 token，LCS 几乎不花时间。
 */
export function diffInline(before: string, after: string): InlineSegment[] {
  if (before === after) return before ? [{ op: "same", text: before }] : [];

  const a = tokenize(before);
  const b = tokenize(after);

  // 公共前缀
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // 公共后缀（不与前缀重叠）
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const segs: InlineSegment[] = [];
  if (start > 0) segs.push({ op: "same", text: a.slice(0, start).join("") });

  for (const s of lcsSegments(midA, midB)) segs.push(s);

  if (endA < a.length) segs.push({ op: "same", text: a.slice(endA).join("") });

  // 合并相邻同类型，减少渲染节点
  return mergeSegments(segs);
}

function lcsSegments(a: string[], b: string[]): InlineSegment[] {
  if (!a.length) return b.length ? [{ op: "ins", text: b.join("") }] : [];
  if (!b.length) return [{ op: "del", text: a.join("") }];
  if (a.length * b.length > MAX_DP_CELLS) {
    // 太长：不猜了，整段换掉
    return [
      { op: "del", text: a.join("") },
      { op: "ins", text: b.join("") },
    ];
  }

  const n = a.length;
  const m = b.length;
  const w = m + 1;
  // Uint32Array 比 number[] 省一半以上内存
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }

  const out: InlineSegment[] = [];
  let i = 0;
  let j = 0;
  const push = (op: InlineSegment["op"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      push("del", a[i]);
      i++;
    } else {
      push("ins", b[j]);
      j++;
    }
  }
  while (i < n) push("del", a[i++]);
  while (j < m) push("ins", b[j++]);
  return out;
}

function mergeSegments(segs: InlineSegment[]): InlineSegment[] {
  const out: InlineSegment[] = [];
  for (const s of segs) {
    if (!s.text) continue;
    const last = out[out.length - 1];
    if (last && last.op === s.op) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/* ============================================================
 * 段级 diff
 * ============================================================ */

/** 段级 LCS，返回相同段的下标对（用于切分 added/removed/changed 区间） */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  if (!n || !m || n * m > MAX_DP_CELLS) return [];
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * 段级 diff。
 * 未变段之间的空隙里，若有删有增且数量相等 → 视为「修改」，配字级 diff；
 * 数量不等 → 多出来的部分算新增 / 删除。这样常见的「改了 N 段」能对上。
 */
export function diffParagraphs(before: string, after: string): ParagraphDiff {
  const A = splitParagraphs(before);
  const B = splitParagraphs(after);

  const pairs = lcsPairs(A, B);
  const blocks: DiffBlock[] = [];
  const stats: DiffStats = { same: 0, added: 0, removed: 0, changed: 0, wordsAdded: 0, wordsRemoved: 0 };

  const emitGap = (aFrom: number, aTo: number, bFrom: number, bTo: number) => {
    const dels = A.slice(aFrom, aTo);
    const inss = B.slice(bFrom, bTo);
    const common = Math.min(dels.length, inss.length);
    for (let k = 0; k < common; k++) {
      blocks.push({ type: "changed", before: dels[k], after: inss[k], inline: diffInline(dels[k], inss[k]) });
      stats.changed++;
      const wb = countWords(dels[k]);
      const wa = countWords(inss[k]);
      if (wa > wb) stats.wordsAdded += wa - wb;
      else stats.wordsRemoved += wb - wa;
    }
    for (let k = common; k < dels.length; k++) {
      blocks.push({ type: "removed", before: dels[k] });
      stats.removed++;
      stats.wordsRemoved += countWords(dels[k]);
    }
    for (let k = common; k < inss.length; k++) {
      blocks.push({ type: "added", after: inss[k] });
      stats.added++;
      stats.wordsAdded += countWords(inss[k]);
    }
  };

  let ai = 0;
  let bi = 0;
  for (const [pa, pb] of pairs) {
    if (pa > ai || pb > bi) emitGap(ai, pa, bi, pb);
    blocks.push({ type: "same", before: A[pa], after: B[pb] });
    stats.same++;
    ai = pa + 1;
    bi = pb + 1;
  }
  if (ai < A.length || bi < B.length) emitGap(ai, A.length, bi, B.length);

  return { blocks, stats };
}

/* ============================================================
 * 折叠：连续未变段落压成一条
 * ============================================================ */

/** 默认把连续 ≥ `minRun` 段未变内容折叠成一条，避免「改了三个字要滚三屏」 */
export function foldBlocks(blocks: DiffBlock[], minRun = 3): FoldedBlock[] {
  const out: FoldedBlock[] = [];
  let run: DiffBlock[] = [];
  const flush = () => {
    if (!run.length) return;
    if (run.length >= minRun) {
      out.push({
        type: "fold",
        count: run.length,
        before: run.map((b) => (b as { before: string }).before).join("\n\n"),
        after: run.map((b) => (b as { after: string }).after).join("\n\n"),
      });
    } else {
      for (const b of run) out.push(b);
    }
    run = [];
  };
  for (const b of blocks) {
    if (b.type === "same") run.push(b);
    else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
}

/* ============================================================
 * 人话摘要
 * ============================================================ */

/** 「改 3 段、增 2 段、删 1 段（+312 / −18 字）」 */
export function summarize(diff: ParagraphDiff): string {
  const parts: string[] = [];
  const { changed, added, removed, wordsAdded, wordsRemoved } = diff.stats;
  if (changed) parts.push(`改 ${changed} 段`);
  if (added) parts.push(`增 ${added} 段`);
  if (removed) parts.push(`删 ${removed} 段`);
  if (!parts.length) return "无改动";
  const words: string[] = [];
  if (wordsAdded) words.push(`+${wordsAdded}`);
  if (wordsRemoved) words.push(`−${wordsRemoved}`);
  return parts.join("、") + (words.length ? `（${words.join(" / ")} 字）` : "");
}

/** 是否有实质改动（只有空白差异时返回 false） */
export function hasChanges(diff: ParagraphDiff): boolean {
  const s = diff.stats;
  return s.added + s.removed + s.changed > 0;
}