/**
 * 排版规则：纯字符串进、纯数字出，**不依赖 vscode**。
 *
 * 单独成模块的理由是可测。区间算错是静默故障——装饰挂到错的行上，
 * 界面看起来只是「排版没生效」，没人会怀疑行号。必须在单测里逐条钉住。
 *
 * 调用方（typeset.ts）负责把行号 / 偏移包成 vscode.Range。
 */

/** 场景分隔：三个以上的 * / - / _ / —，可夹空白 */
export const SCENE_BREAK = /^\s*(\*[\s*]*\*|—{3,}|-{3,}|_{3,})\s*$/;

/**
 * 结构性行：这些行不做段首缩进。
 *
 * 不是洁癖。给 `>` 引用加缩进会破坏引用块对齐；给 `|` 表格加缩进会让列错位；
 * 给围栏代码加缩进会把代码缩进带进正文。宁可少缩进，不可错缩进。
 */
const STRUCTURAL = /^\s*(#{1,6}\s|>|\||[-*+]\s|\d+[.)]\s|```|~~~|<!--|<)/;

/** 这一行是不是场景分隔 */
export function isSceneBreak(text: string): boolean {
  return SCENE_BREAK.test(text);
}

/** 所有匹配的行号（0 基） */
export function linesMatchingTexts(lines: readonly string[], re: RegExp): number[] {
  const out: number[] = [];
  // 逐行 test 会被 g 标志的 lastIndex 拖累：一半匹配会漏。
  // 调用方传进来的正则可能是全局的（复用同一个常量），这里统一兜底。
  const flags = re.flags.replace("g", "");
  const safe = new RegExp(re.source, flags);
  for (let i = 0; i < lines.length; i++) {
    if (safe.test(lines[i] ?? "")) out.push(i);
  }
  return out;
}

/**
 * 段落首行行号。
 *
 * 散文的段落 = 前面是空行（或文件开头）、本行非空、且不是结构性行。
 */
export function paragraphStartsFromTexts(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? "";
    if (!text.trim()) continue;
    // 前面不是空行 → 是同一段的续行
    if (i > 0 && (lines[i - 1] ?? "").trim()) continue;
    if (STRUCTURAL.test(text)) continue;
    // 场景分隔有自己的留白装饰，不叠缩进
    if (isSceneBreak(text)) continue;
    out.push(i);
  }
  return out;
}

/** 文档内的一个区间，用**字符偏移**表示（与 VS Code 无关） */
export interface TextSpan {
  start: number;
  end: number;
}

/**
 * 正则匹配出的区间。
 *
 * 跨行的备注（`<!--` 与 `-->` 不在同一行）必须按全文偏移算，逐行扫会漏——
 * 而作者把整段草稿注掉的时候，正是最需要它变淡的时候。
 */
export function spansOf(text: string, re: RegExp): TextSpan[] {
  const out: TextSpan[] = [];
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const safe = new RegExp(re.source, flags);
  let m: RegExpExecArray | null;
  while ((m = safe.exec(text)) !== null) {
    if (m[0].length === 0) {
      safe.lastIndex++; // 零宽匹配会死循环
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 备注：`<!--` 到 `-->`，可跨行，非贪婪 */
export const COMMENT = /<!--[\s\S]*?-->/g;

/** 双链：`[[角色]]`。限制长度与禁换行，避免把误写的半个括号吃到底 */
export const WIKI_LINK = /\[\[[^\]\n]{1,80}\]\]/g;