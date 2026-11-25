/**
 * TXT 导出
 */
import type { Chapter, Project } from "../types.js";
import type { ExportProfile } from "./profile.js";
import { renderTitle } from "./profile.js";
import { toBlocks } from "./blocks.js";

export interface TxtOptions {
  /** 是否包含未定稿章节，默认全部包含 */
  includeStatuses?: Chapter["frontmatter"]["status"][];
}

export function exportTxt(project: Project, profile: ExportProfile, opts: TxtOptions = {}): string {
  const { txt } = profile;
  const nl = txt.newline;
  const out: string[] = [];

  if (txt.includeTitlePage) {
    out.push(project.config.title, "", "");
    if (project.config.author) out.push(project.config.author, "", "");
    out.push("");
  }

  let lastVolume: string | undefined;
  for (const ch of project.chapters) {
    if (opts.includeStatuses && !opts.includeStatuses.includes(ch.frontmatter.status ?? "draft")) continue;

    const vol = ch.frontmatter.volume;
    if (txt.includeVolumeHeadings && vol && vol !== lastVolume) {
      out.push(txt.volumeTitleTemplate.replaceAll("{volume}", vol), "");
      lastVolume = vol;
    }

    out.push(renderTitle(txt.chapterTitleTemplate, ch), "");

    for (const b of toBlocks(ch.content, ch.frontmatter.title)) {
      if (b.type === "scene-break") {
        out.push(txt.sceneBreak);
      } else {
        out.push(txt.paragraphIndent + b.text);
      }
      if (txt.blankLineBetweenParagraphs) out.push("");
    }
    out.push("", "");
  }

  // 结尾去掉多余空行
  return out.join(nl).replace(/(\r?\n)+$/, nl) + nl;
}
