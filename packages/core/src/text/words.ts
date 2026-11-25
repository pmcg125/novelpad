/**
 * 字数统计：面向中文写作。
 * - 汉字 / 假名 / 韩文 每字计 1
 * - 连续拉丁字母 / 数字串计 1（如 "OK" 算 1 词）
 * - 标点、空白、Markdown 标记不计
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
const LATIN_WORD = /[A-Za-z0-9]+(?:[''\-][A-Za-z0-9]+)*/;

/**
 * 剥除 Markdown 语法标记，保留文本内容。
 * 处理：标题井号、强调星号/下划线、行内代码围栏、链接语法（保留文字）、
 * 图片（丢弃）、HTML 注释（丢弃）、引用标记、列表标记、水平线、双链方括号。
 */
export function stripMarkdown(md: string): string {
  return md
    // 代码块围栏（保留内部文字）
    .replace(/^```.*$/gm, "")
    // HTML 注释（作者备注）整段丢弃
    .replace(/<!--[\s\S]*?-->/g, "")
    // 图片 ![alt](src) → 丢弃
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // 链接 [text](src) → text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    // 双链 [[name|alias]] → alias，[[name]] → name
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, name: string, alias?: string) => alias ?? name)
    // 行内代码 `code` → code
    .replace(/`([^`]*)`/g, "$1")
    // 强调：先处理双字符，再处理单字符
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\*([^*\n]+?)\*/g, "$1")
    .replace(/_([^_\n]+?)_/g, "$1")
    // 引用、列表、标题
    .replace(/^\s*(#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    // 水平线整行删除
    .replace(/^\s*([-*_]\s*){3,}$/gm, "")
    .trim();
}

/** 统计纯文本字数 */
export function countWords(text: string): number {
  let count = 0;
  let inLatin = false;
  for (const ch of text) {
    if (CJK.test(ch)) {
      count += 1;
      inLatin = false;
    } else if (/[A-Za-z0-9]/.test(ch)) {
      if (!inLatin) count += 1;
      inLatin = true;
    } else {
      inLatin = false;
    }
  }
  return count;
}

/** 统计 Markdown 正文字数（先剥除语法） */
export function countMarkdownWords(md: string): number {
  return countWords(stripMarkdown(md));
}

/** 辅助：拉丁词提取（供需要词级的场景使用） */
export function latinWords(text: string): string[] {
  return text.match(LATIN_WORD) ?? [];
}
