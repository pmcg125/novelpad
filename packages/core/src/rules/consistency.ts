/**
 * 设定一致性规则：frontmatter 出场角色 / 地点必须存在于设定库
 */
import type { Rule } from "./engine.js";

/** 出场角色未在 characters/ 中定义 */
export const unknownCharacter: Rule = {
  meta: {
    id: "novelpad/unknown-character",
    description: "frontmatter.characters 引用了设定库中不存在的角色",
    defaultSeverity: "warning",
    perChapter: true,
  },
  run({ chapter, project, report }) {
    if (!chapter) return;
    const known = new Set<string>();
    for (const e of project.entities) {
      if (e.kind !== "character") continue;
      known.add(e.name);
      for (const a of e.aliases ?? []) known.add(a);
    }
    for (const c of chapter.frontmatter.characters ?? []) {
      if (!known.has(c)) {
        report({
          rule: unknownCharacter.meta.id,
          file: chapter.relativePath,
          line: 1,
          message: `角色「${c}」没有角色卡（characters/ 中未定义）`,
          relatedId: c,
        });
      }
    }
  },
};

/** 视角人物未定义 */
export const unknownPov: Rule = {
  meta: {
    id: "novelpad/unknown-pov",
    description: "frontmatter.pov 引用了未定义的角色",
    defaultSeverity: "error",
    perChapter: true,
  },
  run({ chapter, project, report }) {
    if (!chapter) return;
    const pov = chapter.frontmatter.pov;
    if (!pov) return;
    const exists = project.entities.some(
      (e) => e.kind === "character" && (e.name === pov || e.aliases?.includes(pov)),
    );
    if (!exists) {
      report({
        rule: unknownPov.meta.id,
        file: chapter.relativePath,
        line: 1,
        message: `视角人物「${pov}」没有角色卡`,
        relatedId: pov,
      });
    }
  },
};

/** 地点未定义（仅提示，不强制建卡） */
export const unknownLocation: Rule = {
  meta: {
    id: "novelpad/unknown-location",
    description: "frontmatter.locations 引用了未定义的地点",
    defaultSeverity: "info",
    perChapter: true,
  },
  run({ chapter, project, report }) {
    if (!chapter) return;
    const known = new Set<string>();
    for (const e of project.entities) {
      if (e.kind !== "location") continue;
      known.add(e.name);
      for (const a of e.aliases ?? []) known.add(a);
    }
    for (const l of chapter.frontmatter.locations ?? []) {
      if (!known.has(l)) {
        report({
          rule: unknownLocation.meta.id,
          file: chapter.relativePath,
          line: 1,
          message: `地点「${l}」没有设定条目`,
          relatedId: l,
        });
      }
    }
  },
};

/** 重复 order */
export const duplicateOrder: Rule = {
  meta: {
    id: "novelpad/duplicate-order",
    description: "多个章节使用相同的 order",
    defaultSeverity: "error",
  },
  run({ project, report }) {
    const seen = new Map<number, string>();
    for (const ch of project.chapters) {
      const o = ch.frontmatter.order;
      const prev = seen.get(o);
      if (prev !== undefined) {
        report({
          rule: duplicateOrder.meta.id,
          file: ch.relativePath,
          line: 1,
          message: `章节序号 ${o} 与 ${prev} 重复`,
        });
      } else {
        seen.set(o, ch.relativePath);
      }
    }
  },
};
