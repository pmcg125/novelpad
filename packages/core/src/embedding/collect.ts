/**
 * 从 Project 收集所有可索引的块：章节正文、设定卡、世界观条目、大纲
 */
import fs from "node:fs";
import type { Project } from "../types.js";
import { chunkByHeadings, chunkChapter, type Chunk } from "./store.js";

export interface CollectOptions {
  /** 是否索引章节正文（默认是） */
  chapters?: boolean;
  /** 是否索引设定 */
  entities?: boolean;
  /** 是否索引大纲目录 */
  outline?: boolean;
}

export function collectChunks(project: Project, opts: CollectOptions = {}): Chunk[] {
  const out: Chunk[] = [];
  const o = { chapters: true, entities: true, outline: true, ...opts };

  if (o.chapters) {
    for (const ch of project.chapters) {
      out.push(
        ...chunkChapter(ch.content, {
          kind: "chapter",
          file: ch.relativePath,
          order: ch.frontmatter.order,
          title: ch.frontmatter.title,
          characters: ch.frontmatter.characters,
          locations: ch.frontmatter.locations,
        }),
      );
    }
  }

  if (o.entities) {
    for (const e of project.entities) {
      // 把结构化字段也变成可检索文本
      const head: string[] = [];
      if (e.summary) head.push(e.summary);
      if (e.attrs) head.push(...Object.entries(e.attrs).map(([k, v]) => `${k}：${v}`));
      if (e.relations?.length) head.push(...e.relations.map((r) => `${e.name}与${r.target}：${r.type}${r.note ? `，${r.note}` : ""}`));
      if (e.kind === "character" && e.state) {
        const s = e.state;
        head.push(`当前状态：${[s.emotion && `情绪${s.emotion}`, s.location && `在${s.location}`, s.knows?.length && `已知晓${s.knows.join("、")}`].filter(Boolean).join("，")}`);
      }
      const description = e.description ?? (e.kind === "lore" ? e.content : "");
      const body = [head.join("\n"), description].filter(Boolean).join("\n\n");
      // 设定卡按字段 / 标题切
      const text = e.kind === "lore" && e.content ? e.content : body;
      const titleLine = `# ${e.name}\n`;
      out.push(
        ...chunkByHeadings(titleLine + text, {
          kind: "entity",
          file: e.relativePath,
          entity: e.name,
          entityKind: e.kind,
        }),
      );
    }
  }

  if (o.outline && project.config.outlineDir) {
    const dir = `${project.root}/${project.config.outlineDir}`;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.md$/i.test(f)) continue;
        const text = fs.readFileSync(`${dir}/${f}`, "utf8");
        const rel = `${project.config.outlineDir}/${f}`;
        // 大纲目录里的 .md：带"大纲/总纲"字样视为 outline，否则视为世界观条目
        const title = f.replace(/\.md$/i, "");
        const isOutline = /大纲|总纲|outline/i.test(title) || /^#\s*(大纲|总纲)/m.test(text);
        out.push(
          ...chunkByHeadings(
            text,
            isOutline ? { kind: "outline", file: rel, title } : { kind: "lore", file: rel, title },
          ),
        );
      }
    }
  }

  // 项目根目录下的 .md（总览 / 冲突清单 / 补充集等），视为世界观条目
  for (const f of fs.readdirSync(project.root)) {
    if (!/\.md$/i.test(f) || /^readme$/i.test(f.replace(/\.md$/i, ""))) continue;
    const text = fs.readFileSync(`${project.root}/${f}`, "utf8");
    out.push(...chunkByHeadings(text, { kind: "lore", file: f, title: f.replace(/\.md$/i, "") }));
  }

  return out;
}
