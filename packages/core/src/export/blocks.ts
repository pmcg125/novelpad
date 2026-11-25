/**
 * Markdown 正文 → 块结构（段落 / 场景分隔），供 TXT / DOCX 渲染共用。
 * 作者备注（HTML 注释）在导出时丢弃。
 */
import { stripMarkdown } from "../text/words.js";

export type Block =
  | { type: "paragraph"; text: string }
  | { type: "scene-break" }
  | { type: "quote"; text: string };

const SCENE_BREAK = /^\s*([-*_]\s*){3,}$/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const CODE_FENCE = /^\s*```/;

/**
 * 把章节正文拆成块。首行若与章节标题相同的 H1 会被跳过（避免导出时重复标题）。
 */
export function toBlocks(content: string, chapterTitle: string): Block[] {
  const src = content.replace(/<!--[\s\S]*?-->/g, "");
  const lines = src.split(/\r?\n/);
  const blocks: Block[] = [];
  let buf: string[] = [];
  let inCode = false;
  let skippedFirstHeading = false;

  const flush = () => {
    if (!buf.length) return;
    const text = stripMarkdown(buf.join(" "));
    if (text) blocks.push({ type: "paragraph", text });
    buf = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (CODE_FENCE.test(line)) {
      flush();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      buf.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (SCENE_BREAK.test(line)) {
      flush();
      blocks.push({ type: "scene-break" });
      continue;
    }
    if (HEADING.test(line)) {
      const text = stripMarkdown(line);
      // 跳过与章节标题重复的首个标题；其余标题作为居中段落
      if (!skippedFirstHeading && (text === chapterTitle || text.replace(/^第?[一二三四五六七八九十百零\d]+章\s*/, "") === chapterTitle.replace(/^第?[一二三四五六七八九十百零\d]+章\s*/, ""))) {
        skippedFirstHeading = true;
        continue;
      }
      flush();
      blocks.push({ type: "paragraph", text });
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      blocks.push({ type: "quote", text: stripMarkdown(line) });
      continue;
    }
    // 列表项各自成段
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flush();
      blocks.push({ type: "paragraph", text: stripMarkdown(line) });
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}
