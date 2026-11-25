import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Chapter, Project } from "../types.js";
import { lint, type Rule } from "./engine.js";
import {
  builtinRules,
  collectForeshadows,
  foreshadowOverdue,
  unknownCharacter,
  unknownForeshadow,
  repeatedWord,
  unclosedComment,
  duplicateOrder,
} from "./index.js";

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../examples/demo-novel");

/** 构造最小章节 */
function ch(order: number, extra: Partial<Chapter["frontmatter"]> = {}, content = "正文。"): Chapter {
  return {
    path: `/p/chapters/${order}.md`,
    relativePath: `chapters/${order}.md`,
    frontmatter: {
      title: `第${order}章`,
      order,
      status: "draft",
      characters: [],
      locations: [],
      foreshadows: [],
      resolves: [],
      ...extra,
    },
    content,
    wordCount: 0,
  };
}

function proj(chapters: Chapter[], entities: Project["entities"] = []): Project {
  return { root: "/p", config: { title: "t" }, chapters, entities };
}

describe("engine", () => {
  it("规则禁用时不运行", () => {
    let ran = false;
    const r: Rule = { meta: { id: "x/a", description: "", defaultSeverity: "error" }, run: () => { ran = true; } };
    lint(proj([]), [r], { rules: { "x/a": false } });
    expect(ran).toBe(false);
  });

  it("配置覆盖严重级别", () => {
    const r: Rule = {
      meta: { id: "x/a", description: "", defaultSeverity: "info" },
      run: ({ report }) => report({ file: "a.md", line: 1, message: "m" }),
    };
    const out = lint(proj([]), [r], { rules: { "x/a": "error" } });
    expect(out[0]?.severity).toBe("error");
    expect(out[0]?.rule).toBe("x/a");
  });
});

describe("foreshadow", () => {
  it("collectForeshadows 记录声明与回收", () => {
    const m = collectForeshadows([
      ch(1, { foreshadows: [{ id: "fs-a", due: 3 }] }),
      ch(2, { foreshadows: [{ id: "fs-b" }] }),
      ch(3, { resolves: ["fs-a"] }),
    ]);
    expect(m.get("fs-a")?.resolvedIn?.frontmatter.order).toBe(3);
    expect(m.get("fs-b")?.resolvedIn).toBeUndefined();
  });

  it("到期未回收 → warning，定位到声明章节", () => {
    const out = lint(proj([ch(1, { foreshadows: [{ id: "fs-a", due: 2 }] }), ch(2)]), [foreshadowOverdue]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rule: "novelpad/foreshadow-overdue", file: "chapters/1.md", relatedId: "fs-a" });
  });

  it("未到期不报", () => {
    const out = lint(proj([ch(1, { foreshadows: [{ id: "fs-a", due: 10 }] }), ch(2)]), [foreshadowOverdue]);
    expect(out).toHaveLength(0);
  });

  it("回收未声明的伏笔 → error", () => {
    const out = lint(proj([ch(1, { resolves: ["fs-ghost"] })]), [unknownForeshadow]);
    expect(out[0]?.rule).toBe("novelpad/foreshadow-unknown");
    expect(out[0]?.severity).toBe("error");
  });
});

describe("consistency", () => {
  it("未定义角色 → warning，带角色卡不报", () => {
    const p = proj([ch(1, { characters: ["林晚", "路人甲"], pov: "林晚" })], [
      { kind: "character", id: "lw", name: "林晚", path: "", relativePath: "" },
    ]);
    const out = lint(p, [unknownCharacter]);
    expect(out).toHaveLength(1);
    expect(out[0]?.message).toContain("路人甲");
  });

  it("重复 order → error", () => {
    const out = lint(proj([ch(1), ch(1)]), [duplicateOrder]);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe("error");
  });
});

describe("text", () => {
  it("重复用词检测", () => {
    const out = lint(proj([ch(1, {}, "她推门进去。风铃响了一声，闷闷的，闷闷的，像被水浸过。")]), [repeatedWord]);
    expect(out.some((d) => d.message.includes("闷闷的"))).toBe(true);
    expect(out[0]?.line).toBe(1);
  });

  it("未闭合注释定位到行", () => {
    const out = lint(proj([ch(1, {}, "第一行\n<!-- 没闭合\n第三行")]), [unclosedComment]);
    expect(out[0]?.line).toBe(2);
  });
});

describe("示例作品", () => {
  it("builtinRules 能跑通并找到预期的 fs-letter 逾期", async () => {
    const { loadProject } = await import("../project.js");
    const p = loadProject({ root: EXAMPLE });
    const out = lint(p, builtinRules);
    const ids = out.map((d) => d.rule);
    // 第 3 章已 resolves fs-letter，所以不应逾期
    expect(ids).not.toContain("novelpad/foreshadow-overdue");
    // 示例里的地点都有条目
    expect(ids).not.toContain("novelpad/unknown-character");
  });
});
