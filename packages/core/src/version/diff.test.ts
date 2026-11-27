import { describe, expect, it } from "vitest";
import { diffInline, diffParagraphs, foldBlocks, hasChanges, splitParagraphs, summarize, tokenize } from "./diff.js";

const P = (...ps: string[]) => ps.join("\n\n");

describe("splitParagraphs", () => {
  it("按空行切段，单换行留在段内", () => {
    expect(splitParagraphs("甲\n乙\n\n丙")).toEqual(["甲\n乙", "丙"]);
  });

  it("兼容 CRLF 与连续空行、行尾空格", () => {
    expect(splitParagraphs("甲\r\n\r\n  \r\n乙  ")).toEqual(["甲", "乙"]);
  });

  it("空文本得到空数组", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs("\n\n\n")).toEqual([]);
  });

  it("末尾段落的行尾换行被清掉（否则「文末追加一段」会被误判成修改原末段）", () => {
    // 文件最后一段后面只有一个换行，没有空行，不会被 split 吃掉。
    // 留着它会让同一个段落在前后两版里一个是 "A"、一个是 "A\n"，
    // 段级 LCS 判定为「修改」，时间线与 AI 分账都会看错。
    expect(splitParagraphs("甲\n\n乙\n")).toEqual(["甲", "乙"]);
    expect(splitParagraphs("甲\n\n乙\n")).toEqual(splitParagraphs("甲\n\n乙"));
  });

  it("段末的行尾空格与 \\r 一并清掉（Windows 保存的文件）", () => {
    expect(splitParagraphs("甲  \r\n\r\n乙\t\r\n")).toEqual(["甲", "乙"]);
  });

  it("段首缩进原样保留（作者可能用空格缩进）", () => {
    expect(splitParagraphs("  缩进段\n\n下一段")).toEqual(["  缩进段", "下一段"]);
  });
});

describe("追加段落不会被判成修改", () => {
  it("在文末追加一段：原末段是 same，新段是 added", () => {
    const d = diffParagraphs("甲。\n\n乙。\n", "甲。\n\n乙。\n\n丙。\n");
    expect(d.blocks.map((b) => b.type)).toEqual(["same", "same", "added"]);
    expect(d.stats.changed).toBe(0);
    expect(d.stats.added).toBe(1);
  });
});

describe("tokenize", () => {
  it("中文逐字，拉丁串成词", () => {
    expect(tokenize("他说 OK 了")).toEqual(["他", "说", " ", "OK", " ", "了"]);
  });

  it("数字与含连字符的词不拆", () => {
    expect(tokenize("第 12 章 well-known")).toEqual(["第", " ", "12", " ", "章", " ", "well-known"]);
  });
});

describe("diffInline", () => {
  it("完全相同返回单个 same", () => {
    expect(diffInline("雨下得很大", "雨下得很大")).toEqual([{ op: "same", text: "雨下得很大" }]);
  });

  it("只改中间几个字，前缀后缀保持 same", () => {
    const segs = diffInline("雨下得很大，他撑开伞", "雨下得极大，他撑开伞");
    expect(segs[0]).toEqual({ op: "same", text: "雨下得" });
    expect(segs.some((s) => s.op === "del" && s.text === "很")).toBe(true);
    expect(segs.some((s) => s.op === "ins" && s.text === "极")).toBe(true);
    expect(segs[segs.length - 1]).toEqual({ op: "same", text: "大，他撑开伞" });
  });

  it("纯新增：原句是改后句的前缀", () => {
    expect(diffInline("他走了。", "他走了。雨还在下。")).toEqual([
      { op: "same", text: "他走了。" },
      { op: "ins", text: "雨还在下。" },
    ]);
  });

  it("纯删除", () => {
    expect(diffInline("他走了。雨还在下。", "他走了。")).toEqual([
      { op: "same", text: "他走了。" },
      { op: "del", text: "雨还在下。" },
    ]);
  });

  it("完全相同内容只差一个 emoji 也能定位", () => {
    const segs = diffInline("她把伞收好。", "她把伞收好了。");
    expect(segs.some((s) => s.op === "ins" && s.text === "了")).toBe(true);
  });

  it("空字符串处理", () => {
    expect(diffInline("", "有内容")).toEqual([{ op: "ins", text: "有内容" }]);
    expect(diffInline("有内容", "")).toEqual([{ op: "del", text: "有内容" }]);
    expect(diffInline("", "")).toEqual([]);
  });

  it("相邻同类型片段被合并", () => {
    const segs = diffInline("ab", "xy");
    expect(segs.every((s, i) => i === 0 || s.op !== segs[i - 1].op)).toBe(true);
  });
});

describe("diffParagraphs", () => {
  it("无改动", () => {
    const d = diffParagraphs(P("甲", "乙"), P("甲", "乙"));
    expect(d.stats).toMatchObject({ same: 2, added: 0, removed: 0, changed: 0 });
    expect(hasChanges(d)).toBe(false);
    expect(summarize(d)).toBe("无改动");
  });

  it("改一段：识别为 changed 而非红绿整章", () => {
    const d = diffParagraphs(P("第一段不变。", "雨下得很大。", "第三段不变。"), P("第一段不变。", "雨下得极大。", "第三段不变。"));
    expect(d.stats).toMatchObject({ same: 2, changed: 1, added: 0, removed: 0 });
    const ch = d.blocks.find((b) => b.type === "changed");
    expect(ch).toBeTruthy();
    expect(summarize(d)).toBe("改 1 段");
  });

  it("新增段落", () => {
    const d = diffParagraphs(P("甲", "乙"), P("甲", "乙", "丙"));
    expect(d.stats).toMatchObject({ same: 2, added: 1 });
    expect(summarize(d)).toBe("增 1 段（+1 字）");
  });

  it("删除段落", () => {
    const d = diffParagraphs(P("甲", "乙", "丙"), P("甲", "丙"));
    expect(d.stats).toMatchObject({ same: 2, removed: 1 });
  });

  it("首段被改写", () => {
    const d = diffParagraphs(P("旧开头。", "中间。"), P("新开头。", "中间。"));
    expect(d.stats.changed).toBe(1);
    expect(d.stats.same).toBe(1);
    expect(d.blocks[0].type).toBe("changed");
  });

  it("末段被改写", () => {
    const d = diffParagraphs(P("中间。", "旧结尾。"), P("中间。", "新结尾。"));
    expect(d.stats).toMatchObject({ same: 1, changed: 1 });
  });

  it("段数不等时多出的算增删，不多算修改", () => {
    const d = diffParagraphs(P("甲", "乙"), P("甲", "乙2", "丙", "丁"));
    expect(d.stats.changed).toBe(1);
    expect(d.stats.added).toBe(2);
    expect(d.stats.removed).toBe(0);
  });

  it("空稿到有稿", () => {
    const d = diffParagraphs("", P("甲", "乙"));
    expect(d.stats).toMatchObject({ added: 2, same: 0 });
  });

  it("有稿到空稿", () => {
    const d = diffParagraphs(P("甲", "乙"), "");
    expect(d.stats).toMatchObject({ removed: 2 });
  });

  it("纯排序变动：段落移动呈现为「删除 + 新增」，不当成改写", () => {
    const d = diffParagraphs(P("甲", "乙", "丙", "丁"), P("甲", "丙", "乙", "丁"));
    expect(d.stats.same).toBe(3);
    // 移动的那段被拆成「此处删掉」和「彼处补上」，不会被误渲染成「整段重写」
    expect(d.stats.changed).toBe(0);
    expect(d.stats.added).toBe(1);
    expect(d.stats.removed).toBe(1);
  });

  it("字数增减统计正确", () => {
    const d = diffParagraphs(P("他走了。"), P("他慢慢地走了。"));
    expect(d.stats.wordsAdded).toBe(3);
    expect(d.stats.wordsRemoved).toBe(0);
  });
});

describe("foldBlocks", () => {
  it("连续未变段落超阈值时折叠", () => {
    const before = P("一", "二", "三", "四", "改这段");
    const after = P("一", "二", "三", "四", "改过了这段");
    const d = diffParagraphs(before, after);
    const folded = foldBlocks(d.blocks, 3);
    const fold = folded.find((b) => b.type === "fold");
    expect(fold).toBeTruthy();
    expect(fold && fold.type === "fold" && fold.count).toBe(4);
  });

  it("未达阈值不折叠", () => {
    const d = diffParagraphs(P("一", "二", "改"), P("一", "二", "改了"));
    expect(foldBlocks(d.blocks, 3).some((b) => b.type === "fold")).toBe(false);
  });

  it("折叠块保留原文，展开时不用回查", () => {
    const d = diffParagraphs(P("一", "二", "三", "旧"), P("一", "二", "三", "新"));
    const fold = foldBlocks(d.blocks, 3).find((b) => b.type === "fold");
    expect(fold && fold.type === "fold" && fold.after).toBe(P("一", "二", "三"));
  });
});