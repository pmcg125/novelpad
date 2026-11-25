/**
 * 纯逻辑单测：命令辅助函数、树视图节点构造
 */
import { describe, expect, it } from "vitest";
import { toId, chapterTemplate, characterTemplate } from "./templates.js";

describe("toId", () => {
  it("英文转小写连字符", () => expect(toId("Lin Wan")).toBe("lin-wan"));
  it("中文保留原名", () => expect(toId("林晚")).toBe("林晚"));
  it("去除首尾连字符", () => expect(toId("--A B--")).toBe("a-b"));
});

describe("chapterTemplate", () => {
  it("生成 frontmatter + 标题", () => {
    const s = chapterTemplate({ order: 3, title: "第三章 来信", volume: "卷一" });
    expect(s.startsWith("---\n")).toBe(true);
    expect(s).toContain("title: 第三章 来信");
    expect(s).toContain("order: 3");
    expect(s).toContain("volume: 卷一");
    expect(s).toContain("status: draft");
    expect(s.endsWith("# 第三章 来信\n\n")).toBe(true);
  });
  it("无 volume 时不输出该行", () => {
    expect(chapterTemplate({ order: 1, title: "第一章" })).not.toContain("volume:");
  });
});

describe("characterTemplate", () => {
  it("含 role", () => {
    const s = characterTemplate({ name: "林晚", role: "protagonist" });
    expect(s).toContain("name: 林晚");
    expect(s).toContain("role: protagonist");
    expect(s).toContain("relations: []");
  });
  it("无 role", () => {
    expect(characterTemplate({ name: "沈默" })).not.toContain("role:");
  });
});
