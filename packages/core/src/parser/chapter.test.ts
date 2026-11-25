import { describe, expect, it } from "vitest";
import { normalizeFrontmatter, orderFromFilename, parseChapterString } from "./chapter.js";

describe("orderFromFilename", () => {
  it("001.md → 1", () => expect(orderFromFilename("001.md")).toBe(1));
  it("ch-012-title.md → 12", () => expect(orderFromFilename("ch-012-title.md")).toBe(12));
  it("no-number.md → undefined", () => expect(orderFromFilename("no-number.md")).toBeUndefined());
});

describe("normalizeFrontmatter", () => {
  it("补默认值", () => {
    const fm = normalizeFrontmatter({}, 5);
    expect(fm.title).toBe("未命名章节");
    expect(fm.order).toBe(5);
    expect(fm.status).toBe("draft");
    expect(fm.characters).toEqual([]);
    expect(fm.foreshadows).toEqual([]);
  });

  it("frontmatter.order 优先于文件名", () => {
    expect(normalizeFrontmatter({ order: 99 }, 5).order).toBe(99);
  });

  it("非法 status 回退 draft", () => {
    expect(normalizeFrontmatter({ status: "bogus" }).status).toBe("draft");
  });

  it("过滤非字符串 characters，丢弃无 id 的伏笔", () => {
    const fm = normalizeFrontmatter({
      characters: ["林晚", 42, "沈默"],
      foreshadows: [{ id: "fs-a", due: 3 }, { note: "no id" }],
    });
    expect(fm.characters).toEqual(["林晚", "沈默"]);
    expect(fm.foreshadows).toEqual([{ id: "fs-a", due: 3, resolvedAt: undefined, note: undefined }]);
  });
});

describe("parseChapterString", () => {
  const md = `---
title: 第一章 雨夜
order: 1
pov: 林晚
status: draft
characters: [林晚, 沈默]
foreshadows:
  - id: fs-umbrella
    due: 12
---

# 第一章 雨夜

雨是从傍晚开始下的。[[林晚]]把伞压低了一些。

<!-- 备注不算字数 -->

「你不该来。」
`;

  it("解析 frontmatter 与正文", () => {
    const ch = parseChapterString(md, { relativePath: "chapters/001.md" });
    expect(ch.frontmatter.title).toBe("第一章 雨夜");
    expect(ch.frontmatter.order).toBe(1);
    expect(ch.frontmatter.pov).toBe("林晚");
    expect(ch.frontmatter.characters).toEqual(["林晚", "沈默"]);
    expect(ch.frontmatter.foreshadows?.[0]?.id).toBe("fs-umbrella");
    expect(ch.content).toContain("雨是从傍晚开始下的");
    expect(ch.content).not.toContain("title:");
  });

  it("字数不含标记与备注", () => {
    const ch = parseChapterString(md, { relativePath: "chapters/001.md" });
    // 第一章雨夜(5) 雨是从傍晚开始下的(9) 林晚把伞压低了一些(9) 你不该来(4) = 27
    expect(ch.wordCount).toBe(27);
  });

  it("无 frontmatter 时从文件名推断 order", () => {
    const ch = parseChapterString("# 随笔\n\n正文", { relativePath: "chapters/007.md" });
    expect(ch.frontmatter.order).toBe(7);
    expect(ch.frontmatter.title).toBe("未命名章节");
  });
});
