/**
 * 批注锚定 —— 让批注在文本被反复编辑后还能找到原来的位置。
 *
 * 光存 offset 没用：作者在前面加一段，后面所有批注就全错位了。
 * 所以存三件套：引文（quote）+ 前文（prefix）+ 后文（suffix）+ 原始 offset。
 * 重新定位时逐级退让：
 *   1. 精确匹配「prefix + quote + suffix」
 *   2. 匹配「prefix + quote」
 *   3. 匹配 quote（多处出现时取离原 offset 最近的）
 *   4. 全都失败 → orphaned（显式列出，绝不静默丢弃）
 *
 * 纯函数，无 IO。
 */

/* ============================================================
 * 类型
 * ============================================================ */

export type AnnotationStatus = "open" | "accepted" | "rejected" | "resolved" | "orphaned";

/** 锚点：定位所需的最小信息 */
export interface Anchor {
  /** 被批注的原文片段 */
  quote: string;
  /** 引文前若干个字，用于消歧 */
  prefix: string;
  /** 引文后若干个字 */
  suffix: string;
  /** 创建时的字符偏移（退化兜底） */
  offset: number;
}

export interface AnnotationAuthor {
  /** 邮箱或昵称；无账号时为 "local" */
  id: string;
  name?: string;
}

export interface AnnotationThreadItem {
  author: AnnotationAuthor;
  time: string;
  body: string;
}

export interface Annotation {
  id: string;
  author: AnnotationAuthor;
  /** ISO 时间 */
  created: string;
  /** 相对作品根目录的路径，如 chapters/003.md */
  file: string;
  anchor: Anchor;
  kind: "comment" | "suggestion";
  body: string;
  /** kind === "suggestion" 时的替换方案 */
  suggestion?: { before: string; after: string };
  status: AnnotationStatus;
  thread?: AnnotationThreadItem[];
}

/** 定位结果 */
export interface ResolvedRange {
  start: number;
  end: number;
  /** 用哪一级策略命中的 */
  via: "exact" | "prefix" | "quote" | "offset" | "orphaned";
}

/* ============================================================
 * 采集锚点
 * ============================================================ */

/** prefix / suffix 的长度。太短无法消歧，太长占空间且更容易被改动波及 */
export const CONTEXT_LEN = 24;

/** 从正文 + 选区生成锚点 */
export function makeAnchor(text: string, start: number, end: number, contextLen = CONTEXT_LEN): Anchor {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(s, Math.min(end, text.length));
  return {
    quote: text.slice(s, e),
    prefix: text.slice(Math.max(0, s - contextLen), s),
    suffix: text.slice(e, Math.min(text.length, e + contextLen)),
    offset: s,
  };
}

/* ============================================================
 * 重新定位
 * ============================================================ */

/**
 * 在最新正文里重新定位锚点。
 *
 * 返回 `via: "orphaned"` 表示原文已不存在——调用方应把这条批注显示在
 * 「失效批注」区，而不是丢弃。
 */
export function resolveAnchor(text: string, anchor: Anchor): ResolvedRange {
  const { quote, prefix, suffix, offset } = anchor;

  // 空引文无法定位（创建时就没选中内容）
  if (!quote) {
    return { start: Math.min(offset, text.length), end: Math.min(offset, text.length), via: "offset" };
  }

  // 1) 三件套精确匹配
  if (prefix || suffix) {
    const needle = prefix + quote + suffix;
    const hits = allIndices(text, needle);
    if (hits.length) {
      const at = pickNearest(hits, offset - prefix.length);
      const start = at + prefix.length;
      return { start, end: start + quote.length, via: "exact" };
    }
  }

  // 2) prefix + quote（后文被改了）
  if (prefix) {
    const hits = allIndices(text, prefix + quote);
    if (hits.length) {
      const at = pickNearest(hits, offset - prefix.length);
      const start = at + prefix.length;
      return { start, end: start + quote.length, via: "prefix" };
    }
  }

  // 3) 只靠引文（前后文都变了，但句子还在）
  const hits = allIndices(text, quote);
  if (hits.length) {
    const start = pickNearest(hits, offset);
    return { start, end: start + quote.length, via: "quote" };
  }

  // 4) 引文前半段还在（作者改掉了句尾）
  const half = Math.floor(quote.length / 2);
  if (half >= 4) {
    const head = quote.slice(0, half);
    const headHits = allIndices(text, head);
    if (headHits.length) {
      const start = pickNearest(headHits, offset);
      return { start, end: start + head.length, via: "quote" };
    }
  }

  return { start: -1, end: -1, via: "orphaned" };
}

/** 找出 needle 在 haystack 中所有出现位置（不重叠） */
export function allIndices(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    out.push(at);
    from = at + 1; // +1 而不是 +needle.length，允许重叠出现
  }
  return out;
}

/** 多处命中时取离原位置最近的；距离相同时取靠前的 */
function pickNearest(hits: number[], target: number): number {
  let best = hits[0];
  let bestDist = Math.abs(best - target);
  for (const h of hits) {
    const d = Math.abs(h - target);
    if (d < bestDist) {
      best = h;
      bestDist = d;
    }
  }
  return best;
}

/* ============================================================
 * 批量与统计
 * ============================================================ */

export interface ResolvedAnnotation {
  annotation: Annotation;
  range: ResolvedRange;
}

/** 对一批批注（同一文件）统一重新定位 */
export function resolveAll(text: string, annotations: readonly Annotation[]): ResolvedAnnotation[] {
  return annotations.map((annotation) => {
    const range = resolveAnchor(text, annotation.anchor);
    const orphaned = range.via === "orphaned";
    // 调用方据此更新 status；这里不修改入参（纯函数）
    return {
      annotation: orphaned && annotation.status !== "orphaned" ? { ...annotation, status: "orphaned" } : annotation,
      range,
    };
  });
}

export interface AnnotationStats {
  open: number;
  orphaned: number;
  total: number;
}

export function stats(annotations: readonly Annotation[]): AnnotationStats {
  return {
    open: annotations.filter((a) => a.status === "open").length,
    orphaned: annotations.filter((a) => a.status === "orphaned").length,
    total: annotations.length,
  };
}

/** 未解决且未失效的批注才需要画在编辑器里 */
export function isVisible(a: Annotation): boolean {
  return a.status === "open";
}

/* ============================================================
 * 序列化（jsonl：一行一条，git diff 友好）
 * ============================================================ */

export function toJsonl(annotations: readonly Annotation[]): string {
  return annotations.map((a) => JSON.stringify(a)).join("\n") + (annotations.length ? "\n" : "");
}

export function fromJsonl(text: string): Annotation[] {
  const out: Annotation[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Annotation;
      if (o && typeof o.id === "string" && typeof o.file === "string" && o.anchor) out.push(o);
    } catch {
      // 坏行跳过，不让一条坏数据毁掉整个文件
    }
  }
  return out;
}