import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { loadProject } from "../project.js";
import { DEFAULT_PROFILE, SUBMISSION_PROFILE, resolveProfile } from "./profile.js";
import { toBlocks } from "./blocks.js";
import { exportTxt } from "./txt.js";
import { exportDocx } from "./docx.js";

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../examples/demo-novel");

describe("toBlocks", () => {
  it("拆分段落与场景分隔，丢弃备注，跳过重复标题", () => {
    const blocks = toBlocks(
      "# 第一章 雨夜\n\n雨是从傍晚开始下的。[[林晚]]把伞压低。\n\n<!-- 备注 -->\n\n***\n\n「你不该来。」",
      "第一章 雨夜",
    );
    expect(blocks).toEqual([
      { type: "paragraph", text: "雨是从傍晚开始下的。林晚把伞压低。" },
      { type: "scene-break" },
      { type: "paragraph", text: "「你不该来。」" },
    ]);
  });

  it("引用块单独标记", () => {
    const blocks = toBlocks("> 晚晚，别再查了。", "x");
    expect(blocks[0]).toEqual({ type: "quote", text: "晚晚，别再查了。" });
  });
});

describe("resolveProfile", () => {
  it("未知名称回退 default", () => {
    expect(resolveProfile("nope").name).toBe("default");
  });
  it("深合并 margin", () => {
    const p = resolveProfile("print", { docx: { margin: { top: 10 } } });
    expect(p.docx.margin.top).toBe(10);
    expect(p.docx.margin.left).toBe(85);
  });
});

describe("exportTxt", () => {
  const p = loadProject({ root: EXAMPLE });

  it("default：首行缩进，无段间空行，含卷标题", () => {
    const txt = exportTxt(p, DEFAULT_PROFILE);
    expect(txt).toContain("卷一 · 雨夜");
    expect(txt).toContain("第一章 雨夜");
    expect(txt).toMatch(/　　雨是从傍晚开始下的/);
    expect(txt).toContain("＊＊＊");
    expect(txt).not.toContain("<!--");
    expect(txt).not.toContain("[[");
    expect(txt).not.toContain("**");
  });

  it("submission：无缩进，段间空行，不含卷标题", () => {
    const txt = exportTxt(p, SUBMISSION_PROFILE);
    expect(txt.startsWith("第一章 雨夜\n\n雨是从傍晚开始下的")).toBe(true);
    expect(txt).not.toContain("卷一");
    expect(txt).toContain("————");
  });

  it("按 status 过滤", () => {
    const txt = exportTxt(p, DEFAULT_PROFILE, { includeStatuses: ["final"] });
    expect(txt).toContain("第二章");
    expect(txt).not.toContain("第三章");
  });

  it("模板使用 order", () => {
    const txt = exportTxt(p, resolveProfile("default", { txt: { chapterTitleTemplate: "第{order}章 {title}" } }));
    expect(txt).toContain("第1章 第一章 雨夜");
  });
});

describe("exportDocx", () => {
  it("生成可被 JSZip 解析的 docx，正文含中文", async () => {
    const buf = await exportDocx(loadProject({ root: EXAMPLE }), DEFAULT_PROFILE);
    expect(buf.byteLength).toBeGreaterThan(1000);
    const zip = await JSZip.loadAsync(buf);
    const doc = await zip.file("word/document.xml")!.async("string");
    expect(doc).toContain("雨是从傍晚开始下的");
    expect(doc).toContain("宋体");
    expect(doc).toContain("w:eastAsia=\"宋体\"");
    expect(doc).not.toContain("<!--");
    // 3 章 → 章起新页用 pageBreakBefore 实现（至少 2 处）+ 卷标题页 1 处
    expect((doc.match(/<w:pageBreakBefore\/>/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
