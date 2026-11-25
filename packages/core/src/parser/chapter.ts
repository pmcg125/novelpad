/**
 * 章节解析：frontmatter + 正文
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import type { Chapter, ChapterFrontmatter, ChapterStatus } from "../types.js";
import { countMarkdownWords } from "../text/words.js";

export interface ParseChapterOptions {
  /** 文件绝对路径 */
  filePath: string;
  /** 作品根目录，用于计算 relativePath */
  projectRoot: string;
}

const VALID_STATUS: ReadonlySet<ChapterStatus> = new Set(["draft", "revision", "final"]);

/**
 * 从文件名推断章节序号，如 001.md → 1，ch-012-title.md → 12。
 * 无法推断返回 undefined。
 */
export function orderFromFilename(fileName: string): number | undefined {
  const base = path.basename(fileName, path.extname(fileName));
  const m = base.match(/(\d+)/);
  if (!m) return undefined;
  return parseInt(m[1], 10);
}

/** 规范化 frontmatter：补默认值、校验类型 */
export function normalizeFrontmatter(
  raw: Record<string, unknown>,
  fallbackOrder?: number,
): ChapterFrontmatter {
  const fm: Record<string, unknown> = { ...raw };

  const title =
    typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : "未命名章节";

  let order: number;
  if (typeof fm.order === "number" && Number.isFinite(fm.order)) {
    order = fm.order;
  } else if (fallbackOrder !== undefined) {
    order = fallbackOrder;
  } else {
    order = Number.MAX_SAFE_INTEGER; // 排到最后
  }

  const status: ChapterStatus =
    typeof fm.status === "string" && VALID_STATUS.has(fm.status as ChapterStatus)
      ? (fm.status as ChapterStatus)
      : "draft";

  const characters = Array.isArray(fm.characters)
    ? fm.characters.filter((c): c is string => typeof c === "string")
    : [];

  const locations = Array.isArray(fm.locations)
    ? fm.locations.filter((c): c is string => typeof c === "string")
    : [];

  const foreshadows = Array.isArray(fm.foreshadows)
    ? fm.foreshadows
        .filter((f): f is Record<string, unknown> => typeof f === "object" && f !== null)
        .map((f) => ({
          id: String(f.id ?? ""),
          due: typeof f.due === "number" ? f.due : undefined,
          resolvedAt: typeof f.resolvedAt === "number" ? f.resolvedAt : undefined,
          note: typeof f.note === "string" ? f.note : undefined,
        }))
        .filter((f) => f.id)
    : [];

  const resolves = Array.isArray(fm.resolves)
    ? fm.resolves.filter((r): r is string => typeof r === "string")
    : [];

  const volume = typeof fm.volume === "string" ? fm.volume : undefined;
  const pov = typeof fm.pov === "string" ? fm.pov : undefined;
  const targetWords = typeof fm.targetWords === "number" ? fm.targetWords : undefined;

  return {
    ...fm,
    title,
    order,
    volume,
    pov,
    status,
    characters,
    locations,
    foreshadows,
    resolves,
    targetWords,
  };
}

/** 解析章节文件 */
export function parseChapter({ filePath, projectRoot }: ParseChapterOptions): Chapter {
  const text = fs.readFileSync(filePath, "utf8");
  const { data, content } = matter(text);
  const relativePath = path.relative(projectRoot, filePath).split(path.sep).join("/");
  const frontmatter = normalizeFrontmatter(data, orderFromFilename(filePath));
  return {
    path: filePath,
    relativePath,
    frontmatter,
    content,
    wordCount: countMarkdownWords(content),
  };
}

/** 从 Markdown 字符串解析章节（用于测试 / 编辑器未保存内容） */
export function parseChapterString(
  text: string,
  opts: { relativePath: string; filePath?: string; projectRoot?: string },
): Chapter {
  const { data, content } = matter(text);
  const frontmatter = normalizeFrontmatter(data, orderFromFilename(opts.relativePath));
  return {
    path: opts.filePath ?? opts.relativePath,
    relativePath: opts.relativePath,
    frontmatter,
    content,
    wordCount: countMarkdownWords(content),
  };
}
