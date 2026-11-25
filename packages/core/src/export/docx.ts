/**
 * DOCX 导出：基于 docx（纯 JS）直接从块结构生成。
 * 中文字体需要同时设置 ascii / eastAsia，否则 Word 会用默认字体渲染中文。
 */
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun, type FileChild } from "docx";

/** 分页：作为段落属性 pageBreakBefore 更稳妥 */
function pageBreak(): Paragraph {
  return new Paragraph({ pageBreakBefore: true, spacing: { after: 0 }, children: [] });
}
import type { Chapter, Project } from "../types.js";
import type { ExportProfile } from "./profile.js";
import { renderTitle } from "./profile.js";
import { toBlocks } from "./blocks.js";

export interface DocxOptions {
  includeStatuses?: Chapter["frontmatter"]["status"][];
}

/** 中文字体 run：同时指定 ascii / hAnsi / eastAsia */
function fontRun(text: string, font: string, size: number, bold = false): TextRun {
  return new TextRun({
    text,
    bold,
    size: size * 2, // docx 以半磅为单位
    font: { ascii: font, hAnsi: font, eastAsia: font, cs: font },
  });
}

export async function exportDocx(project: Project, profile: ExportProfile, opts: DocxOptions = {}): Promise<Buffer> {
  const { docx } = profile;
  const children: FileChild[] = [];

  if (profile.txt.includeTitlePage) {
    children.push(
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 2400 } }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
        children: [fontRun(project.config.title, docx.headingFont, 28, true)],
      }),
    );
    if (project.config.author) {
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [fontRun(project.config.author, docx.font, 14)],
        }),
      );
    }
    children.push(pageBreak());
  }

  let lastVolume: string | undefined;
  let firstChapter = true;

  for (const ch of project.chapters) {
    if (opts.includeStatuses && !opts.includeStatuses.includes(ch.frontmatter.status ?? "draft")) continue;

    const vol = ch.frontmatter.volume;
    if (profile.txt.includeVolumeHeadings && vol && vol !== lastVolume) {
      if (!firstChapter) children.push(pageBreak());
      children.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          spacing: { before: 600, after: 600 },
          children: [fontRun(vol, docx.headingFont, docx.headingFontSize + 4, true)],
        }),
        pageBreak(),
      );
      lastVolume = vol;
    }

    // 章起新页（非首章）
    if (!firstChapter) children.push(pageBreak());
    firstChapter = false;

    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 400, after: 600 },
        children: [fontRun(renderTitle(profile.txt.chapterTitleTemplate, ch), docx.headingFont, docx.headingFontSize, true)],
      }),
    );

    for (const b of toBlocks(ch.content, ch.frontmatter.title)) {
      if (b.type === "scene-break") {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 300, after: 300 },
            children: [fontRun(profile.txt.sceneBreak, docx.font, docx.fontSize)],
          }),
        );
        continue;
      }
      children.push(
        new Paragraph({
          spacing: { line: Math.round(docx.lineHeight * 240), after: docx.paragraphSpacing * 20 },
          indent: docx.firstLineIndentChars ? { firstLine: docx.firstLineIndentChars * docx.fontSize * 20 } : undefined,
          border: b.type === "quote"
            ? { left: { style: BorderStyle.SINGLE, size: 6, color: "999999", space: 8 } }
            : undefined,
          children: [fontRun(b.text, docx.font, docx.fontSize)],
        }),
      );
    }
  }

  const doc = new Document({
    creator: project.config.author ?? "NovelPad",
    title: project.config.title,
    styles: {
      default: {
        document: {
          run: { font: { ascii: docx.font, hAnsi: docx.font, eastAsia: docx.font, cs: docx.font }, size: docx.fontSize * 2 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: docx.margin.top,
              right: docx.margin.right,
              bottom: docx.margin.bottom,
              left: docx.margin.left,
            },
          },
        },
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
