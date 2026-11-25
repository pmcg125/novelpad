/**
 * 作品扫描：读取 .novelpad/config.json，收集章节与设定实体
 */
import fs from "node:fs";
import path from "node:path";
import type { Chapter, Entity, Project, ProjectConfig } from "./types.js";
import { parseChapter } from "./parser/chapter.js";
import { parseEntityFile, kindFromPath } from "./parser/entity.js";

export const CONFIG_DIR = ".novelpad";
export const CONFIG_FILE = "config.json";

const DEFAULT_CONFIG: ProjectConfig = {
  title: "未命名作品",
  chaptersDir: "chapters",
  outlineDir: "outline",
};

export interface LoadProjectOptions {
  /** 作品根目录 */
  root: string;
  /** 是否读取章节正文（false 时 content 为空，仅元数据；用于快速列表） */
  readContent?: boolean;
}

/** 读取项目配置；不存在则返回默认值 */
export function loadConfig(root: string): ProjectConfig {
  const file = path.join(root, CONFIG_DIR, CONFIG_FILE);
  if (!fs.existsSync(file)) return { ...DEFAULT_CONFIG };
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ProjectConfig>;
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** 判断目录是否为 NovelPad 作品（存在 .novelpad/ 或 chapters/） */
export function isNovelPadProject(root: string): boolean {
  return (
    fs.existsSync(path.join(root, CONFIG_DIR)) ||
    fs.existsSync(path.join(root, DEFAULT_CONFIG.chaptersDir!))
  );
}

/** 递归列出目录下所有文件（遵循 .gitignore 风格跳过隐藏目录与 node_modules） */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function loadProject({ root, readContent = true }: LoadProjectOptions): Project {
  const config = loadConfig(root);
  const chaptersDir = path.join(root, config.chaptersDir ?? "chapters");

  // ---- 章节 ----
  const chapterFiles = walk(chaptersDir).filter((f) => /\.(md|markdown)$/i.test(f));
  const chapters: Chapter[] = [];
  for (const file of chapterFiles) {
    try {
      const ch = parseChapter({ filePath: file, projectRoot: root });
      chapters.push(readContent ? ch : { ...ch, content: "" });
    } catch {
      // 单个文件解析失败不阻塞整体扫描；诊断由 lint 阶段给出
    }
  }
  chapters.sort((a, b) => a.frontmatter.order - b.frontmatter.order);

  // ---- 设定实体 ----
  const entities: Entity[] = [];
  for (const dir of ["characters", "world"]) {
    for (const file of walk(path.join(root, dir))) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      if (!kindFromPath(rel)) continue;
      try {
        const e = parseEntityFile(file, root);
        if (e) entities.push(e);
      } catch {
        // 同上
      }
    }
  }

  return { root, config, chapters, entities };
}

/** 按 ID 查找实体 */
export function findEntity(project: Project, id: string): Entity | undefined {
  return project.entities.find((e) => e.id === id || e.name === id || e.aliases?.includes(id));
}

/** 构建实体名称 → 实体的索引（含别称），供 Aho-Corasick / 补全使用 */
export function buildEntityIndex(project: Project): Map<string, Entity> {
  const idx = new Map<string, Entity>();
  for (const e of project.entities) {
    idx.set(e.name, e);
    for (const a of e.aliases ?? []) idx.set(a, e);
  }
  return idx;
}

export { DEFAULT_CONFIG };
