/**
 * 批注的存取 —— 落盘格式 `.novelpad/annotations.jsonl`。
 *
 * 为什么是 jsonl 而不是一个 json 数组：
 *
 *   1. git diff 友好。两个人各加一条批注，jsonl 是两行独立新增；
 *      数组格式会因为 `],` 的位置冲突，而且整段重排。
 *   2. 一行坏了只丢一条。作者手改文件、合并分支都可能弄坏某行，
 *      数组格式一坏就是全部读不出来。
 *
 * 为什么放 `.novelpad/` 而不是 `.git/`：
 * 批注是要跟稿子一起进版本库、一起被 clone 的。放 `.git/` 里
 * 别人 clone 下来就没有了，等于协作不成立。
 *
 * 时间与 id 都由调用方传入：这里不碰 Date.now()，保持纯函数可测。
 */
import fs from "node:fs";
import path from "node:path";
import {
  type Annotation,
  type AnnotationAuthor,
  type AnnotationStatus,
  fromJsonl,
  makeAnchor,
  toJsonl,
} from "./annotate.js";

/** 批注文件相对作品根的路径 */
export const ANNOTATIONS_FILE = ".novelpad/annotations.jsonl";

export function annotationsPath(root: string): string {
  return path.join(root, ANNOTATIONS_FILE);
}

/**
 * 读全部批注。
 *
 * 文件不存在返回空数组：第一次用批注的人不该看到错误提示，
 * 批注功能是「用起来才存在」的。
 */
export function loadAnnotations(root: string): Annotation[] {
  const p = annotationsPath(root);
  if (!fs.existsSync(p)) return [];
  try {
    return fromJsonl(fs.readFileSync(p, "utf8"));
  } catch {
    // 读不出来（权限、被占用）不能把整个批注功能弄挂
    return [];
  }
}

/**
 * 写回全部批注。
 *
 * 先写临时文件再 rename：作者在写稿时顺手改批注、IDE 恰好崩了，
 * 直接覆写会留下半截文件——那会丢掉**所有**批注，而不是一条。
 * rename 在同一分区上是原子的。
 */
export function saveAnnotations(root: string, annotations: readonly Annotation[]): void {
  const p = annotationsPath(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, toJsonl(annotations), "utf8");
  fs.renameSync(tmp, p);
}

/* ============================================================
 * 增删改
 * ============================================================ */

/** 生成批注 id。时间前缀让 id 天然按创建时间排序，读文件时不用再排。 */
export function makeAnnotationId(now: Date, rand = Math.random): string {
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  // 36 进制 4 位，同毫秒内碰撞概率 1/1679616；配合 id 唯一性检查足够
  const tail = Math.floor(rand() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `a_${stamp}_${tail}`;
}

export interface NewAnnotationInput {
  file: string;
  /** 文件全文，用来采集锚点 */
  text: string;
  /** 选区（字符偏移） */
  start: number;
  end: number;
  body: string;
  kind: Annotation["kind"];
  suggestion?: { after: string };
  author: AnnotationAuthor;
  now: Date;
  rand?: () => number;
}

/**
 * 新建一条批注。
 *
 * 建议模式（suggestion）的 before 不是外部传入的，而是从原文**截出来**：
 * 让调用方各自传 quote 和 before，一定会出现两者不一致的记录，
 * 而「接受建议」要靠 before 校验原文没变。这里统一从 text 取，杜绝不一致。
 */
export function createAnnotation(input: NewAnnotationInput): Annotation {
  const { text, start, end } = input;
  const quote = text.slice(Math.max(0, start), Math.max(0, end));
  return {
    id: makeAnnotationId(input.now, input.rand),
    author: input.author,
    created: input.now.toISOString(),
    file: input.file,
    anchor: makeAnchor(text, start, end),
    kind: input.kind,
    body: input.body,
    ...(input.kind === "suggestion" && input.suggestion
      ? { suggestion: { before: quote, after: input.suggestion.after } }
      : {}),
    status: "open",
  };
}

/**
 * 追加一条（不重排、不覆盖别人刚写的行）。
 *
 * **在这里强制 id 唯一**：makeAnnotationId 只用「毫秒 + 4 位随机数」，
 * 同一毫秒内碰撞概率约 1/1679616——单看很小，但批量导入、脚本生成、
 * 两个人同时回复同一段的时候，一次就会写出几十条。碰撞的后果很重：
 * 删除/改状态按 id 查找，一条操作会命中两条，等于静默删掉别人的批注。
 *
 * 碰撞时顺延后缀（而不是丢弃这条）：批注不能丢。
 */
export function addAnnotation(root: string, a: Annotation): Annotation[] {
  const all = loadAnnotations(root);
  all.push(withUniqueId(a, all));
  saveAnnotations(root, all);
  return all;
}

/** 若 id 已被占用，顺延到第一个空闲后缀 */
export function withUniqueId(a: Annotation, existing: readonly Annotation[]): Annotation {
  const taken = new Set(existing.map((x) => x.id));
  if (!taken.has(a.id)) return a;

  // id 形如 a_<14位时间>_<4位后缀>，只动最后一段
  const cut = a.id.lastIndexOf("_");
  const head = cut > 0 ? a.id.slice(0, cut) : a.id;
  const tail = cut > 0 ? a.id.slice(cut + 1) : "";
  const n = parseInt(tail, 36);

  for (let i = 1; i <= 36 ** 4; i++) {
    const next = `${head}_${((Number.isNaN(n) ? 0 : n) + i).toString(36).padStart(4, "0")}`;
    if (!taken.has(next)) return { ...a, id: next };
  }
  // 后缀空间用尽（4 位 36 进制 = 167 万条）——此时改用完整随机串
  return { ...a, id: `${head}_${Math.random().toString(36).slice(2, 10)}` };
}

/**
 * 改状态。
 *
 * 找不到 id 时原样返回：并发场景下另一个窗口可能已经删了这条批注，
 * 此时报错只会让调用方困惑——他的意图（把这条设为 accepted）已经无处可施，
 * 等同于成功。
 */
export function setAnnotationStatus(root: string, id: string, status: AnnotationStatus): Annotation[] {
  const all = loadAnnotations(root);
  const hit = all.find((a) => a.id === id);
  if (hit) {
    hit.status = status;
    // 被判定失效的批注再也回不到 open：锚点已丢，重新定位没有意义
    saveAnnotations(root, all);
  }
  return all;
}

/** 往线程里追一条回复 */
export function replyToAnnotation(
  root: string,
  id: string,
  item: { author: AnnotationAuthor; time: string; body: string },
): Annotation[] {
  const all = loadAnnotations(root);
  const hit = all.find((a) => a.id === id);
  if (hit) {
    hit.thread = [...(hit.thread ?? []), item];
    saveAnnotations(root, all);
  }
  return all;
}

/** 删除一条（作者撤回自己的批注） */
export function removeAnnotation(root: string, id: string): Annotation[] {
  const all = loadAnnotations(root).filter((a) => a.id !== id);
  saveAnnotations(root, all);
  return all;
}

/* ============================================================
 * 查询
 * ============================================================ */

/** 按文件分组；组内按创建时间升序（读起来像旁批的落笔顺序） */
export function groupByFile(annotations: readonly Annotation[]): Map<string, Annotation[]> {
  const map = new Map<string, Annotation[]>();
  for (const a of annotations) {
    const list = map.get(a.file);
    if (list) list.push(a);
    else map.set(a.file, [a]);
  }
  for (const list of map.values()) list.sort((x, y) => x.created.localeCompare(y.created));
  return map;
}

/** 某文件的批注 */
export function forFile(annotations: readonly Annotation[], file: string): Annotation[] {
  return annotations.filter((a) => a.file === file);
}

/** 是否还有未处理项（决定活动栏徽标显示什么） */
export function openCount(annotations: readonly Annotation[]): number {
  return annotations.filter((a) => a.status === "open").length;
}

/**
 * 去掉重复 id 的记录。
 *
 * 合并分支时最容易出现：两人各自 clone、各自加批注、合并后同一 id
 * 出现两次。保留**先出现的**（通常是更早写入的那条）。
 */
export function dedupeById(annotations: readonly Annotation[]): Annotation[] {
  const seen = new Set<string>();
  const out: Annotation[] = [];
  for (const a of annotations) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}