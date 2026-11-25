/**
 * 导出 Profile：投稿 / 印刷 / 默认的差异全部在这里定义。
 * 用户可在 .novelpad/profiles/<name>.json 覆盖任意字段。
 */
import type { Chapter } from "../types.js";

export interface ExportProfile {
  name: string;
  description: string;

  /** TXT 选项 */
  txt: {
    /** 段首缩进，如 "　　"（两个全角空格）或 "" */
    paragraphIndent: string;
    /** 段落之间是否空一行 */
    blankLineBetweenParagraphs: boolean;
    /** 场景分隔符 */
    sceneBreak: string;
    /** 章节标题模板，可用 {order} {title} {volume} */
    chapterTitleTemplate: string;
    /** 是否输出卷标题 */
    includeVolumeHeadings: boolean;
    /** 卷标题模板 */
    volumeTitleTemplate: string;
    /** 是否输出书名页 */
    includeTitlePage: boolean;
    /** 换行符 */
    newline: "\n" | "\r\n";
  };

  /** DOCX 选项 */
  docx: {
    /** 正文字体（中文） */
    font: string;
    /** 正文字号（磅） */
    fontSize: number;
    /** 行距倍数 */
    lineHeight: number;
    /** 标题字体 */
    headingFont: string;
    /** 章节标题字号（磅） */
    headingFontSize: number;
    /** 页边距（磅） */
    margin: { top: number; right: number; bottom: number; left: number };
    /** 段首缩进字符数（0 = 不缩进，靠段间距） */
    firstLineIndentChars: number;
    /** 段后间距（磅） */
    paragraphSpacing: number;
  };
}

export const DEFAULT_PROFILE: ExportProfile = {
  name: "default",
  description: "默认：首行缩进两格，无段间空行",
  txt: {
    paragraphIndent: "　　",
    blankLineBetweenParagraphs: false,
    sceneBreak: "＊＊＊",
    chapterTitleTemplate: "{title}",
    includeVolumeHeadings: true,
    volumeTitleTemplate: "{volume}",
    includeTitlePage: false,
    newline: "\n",
  },
  docx: {
    font: "宋体",
    fontSize: 12,
    lineHeight: 1.5,
    headingFont: "黑体",
    headingFontSize: 18,
    margin: { top: 72, right: 72, bottom: 72, left: 72 },
    firstLineIndentChars: 2,
    paragraphSpacing: 0,
  },
};

export const SUBMISSION_PROFILE: ExportProfile = {
  name: "submission",
  description: "网文投稿：无缩进，段落间空一行，纯文本友好",
  txt: {
    paragraphIndent: "",
    blankLineBetweenParagraphs: true,
    sceneBreak: "————",
    chapterTitleTemplate: "{title}",
    includeVolumeHeadings: false,
    volumeTitleTemplate: "{volume}",
    includeTitlePage: false,
    newline: "\n",
  },
  docx: {
    font: "宋体",
    fontSize: 12,
    lineHeight: 1.5,
    headingFont: "黑体",
    headingFontSize: 16,
    margin: { top: 72, right: 72, bottom: 72, left: 72 },
    firstLineIndentChars: 0,
    paragraphSpacing: 6,
  },
};

export const PRINT_PROFILE: ExportProfile = {
  name: "print",
  description: "实体书排版：宋体 10.5pt，首行缩进两格，章起新页",
  txt: {
    paragraphIndent: "　　",
    blankLineBetweenParagraphs: false,
    sceneBreak: "＊　＊　＊",
    chapterTitleTemplate: "{title}",
    includeVolumeHeadings: true,
    volumeTitleTemplate: "{volume}",
    includeTitlePage: true,
    newline: "\n",
  },
  docx: {
    font: "宋体",
    fontSize: 10.5,
    lineHeight: 1.6,
    headingFont: "宋体",
    headingFontSize: 16,
    margin: { top: 90, right: 85, bottom: 90, left: 85 },
    firstLineIndentChars: 2,
    paragraphSpacing: 0,
  },
};

export const BUILTIN_PROFILES: Record<string, ExportProfile> = {
  default: DEFAULT_PROFILE,
  submission: SUBMISSION_PROFILE,
  print: PRINT_PROFILE,
};

/** 用户自定义 profile 允许只写要覆盖的字段 */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type ProfileOverride = DeepPartial<ExportProfile>;

/** 深合并用户自定义 profile 到内置 profile 上 */
export function resolveProfile(baseName: string, override?: ProfileOverride): ExportProfile {
  const base = BUILTIN_PROFILES[baseName] ?? DEFAULT_PROFILE;
  if (!override) return base;
  return {
    ...base,
    ...override,
    name: override.name ?? base.name,
    description: override.description ?? base.description,
    txt: { ...base.txt, ...(override.txt ?? {}) },
    docx: { ...base.docx, ...(override.docx ?? {}), margin: { ...base.docx.margin, ...(override.docx?.margin ?? {}) } },
  } as ExportProfile;
}

/** 渲染标题模板 */
export function renderTitle(template: string, ch: Chapter): string {
  return template
    .replaceAll("{order}", String(ch.frontmatter.order))
    .replaceAll("{title}", ch.frontmatter.title)
    .replaceAll("{volume}", ch.frontmatter.volume ?? "");
}
