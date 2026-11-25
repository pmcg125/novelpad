/**
 * 内置规则：伏笔追踪
 */
import type { Chapter } from "../types.js";
import type { Rule } from "./engine.js";

/** 收集全书伏笔：id → 声明章节 */
export function collectForeshadows(chapters: Chapter[]): Map<string, { declaredIn: Chapter; due?: number; resolvedIn?: Chapter }> {
  const map = new Map<string, { declaredIn: Chapter; due?: number; resolvedIn?: Chapter }>();
  for (const ch of chapters) {
    for (const f of ch.frontmatter.foreshadows ?? []) {
      if (!map.has(f.id)) map.set(f.id, { declaredIn: ch, due: f.due });
    }
  }
  for (const ch of chapters) {
    for (const id of ch.frontmatter.resolves ?? []) {
      const e = map.get(id);
      if (e) e.resolvedIn = ch;
    }
  }
  return map;
}

const CHAPTER_ORDER = (ch: Chapter) => ch.frontmatter.order;

/** 伏笔到期未回收 */
export const foreshadowOverdue: Rule = {
  meta: {
    id: "novelpad/foreshadow-overdue",
    description: "伏笔已超过 due 章节仍未回收",
    defaultSeverity: "warning",
  },
  run({ project, report }) {
    const map = collectForeshadows(project.chapters);
    const maxOrder = project.chapters.length ? Math.max(...project.chapters.map(CHAPTER_ORDER)) : 0;
    for (const [id, e] of map) {
      if (e.resolvedIn || e.due === undefined) continue;
      if (maxOrder >= e.due) {
        report({
          rule: foreshadowOverdue.meta.id,
          file: e.declaredIn.relativePath,
          line: 1,
          message: `伏笔「${id}」应在前 ${e.due} 章回收，当前已写到第 ${maxOrder} 章`,
          relatedId: id,
        });
      }
    }
  },
};

/** 回收了未声明的伏笔 */
export const unknownForeshadow: Rule = {
  meta: {
    id: "novelpad/foreshadow-unknown",
    description: "resolves 引用了未声明的伏笔",
    defaultSeverity: "error",
    perChapter: true,
  },
  run({ chapter, project, report }) {
    if (!chapter) return;
    const map = collectForeshadows(project.chapters);
    for (const id of chapter.frontmatter.resolves ?? []) {
      if (!map.has(id)) {
        report({
          rule: unknownForeshadow.meta.id,
          file: chapter.relativePath,
          line: 1,
          message: `回收的伏笔「${id}」未在任何章节声明`,
          relatedId: id,
        });
      }
    }
  },
};

/** 伏笔在声明之前就被回收 */
export const foreshadowResolvedBeforeDeclared: Rule = {
  meta: {
    id: "novelpad/foreshadow-early",
    description: "伏笔在声明章节之前就被回收",
    defaultSeverity: "error",
    perChapter: true,
  },
  run({ chapter, project, report }) {
    if (!chapter) return;
    const map = collectForeshadows(project.chapters);
    for (const id of chapter.frontmatter.resolves ?? []) {
      const e = map.get(id);
      if (e && CHAPTER_ORDER(e.declaredIn) > CHAPTER_ORDER(chapter)) {
        report({
          rule: foreshadowResolvedBeforeDeclared.meta.id,
          file: chapter.relativePath,
          line: 1,
          message: `伏笔「${id}」在第 ${CHAPTER_ORDER(e.declaredIn)} 章才声明，无法在第 ${CHAPTER_ORDER(chapter)} 章回收`,
          relatedId: id,
        });
      }
    }
  },
};
