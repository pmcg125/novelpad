/**
 * L4 排版规则的纯函数单测。
 *
 * 只测「哪些行 / 哪些区间该被装饰」，不测 VS Code 渲染。
 * 区间算错是静默的：装饰挂到错的行上，界面看起来只是「排版没生效」，
 * 没人会怀疑是行号算错了。所以这里把边界逐条钉住。
 */
import { describe, expect, it } from "vitest";
import {
  COMMENT,
  SCENE_BREAK,
  WIKI_LINK,
  isSceneBreak,
  linesMatchingTexts,
  paragraphStartsFromTexts,
  spansOf,
} from "./typeset-rules.js";

const lines = (s: string) => s.split("\n");

describe("场景分隔识别", () => {
  it.each(["***", "* * *", "---", "___", "———", "   ***   "])("识别 %s", (s) => {
    expect(isSceneBreak(s)).toBe(true);
  });

  // 这些是误伤高发区：一旦匹配上，整行会被变透明，等于丢字
  it.each([
    ["两个星号的加粗", "**加粗**"],
    ["单星号斜体", "*斜体*"],
    ["两条横线", "--"],
    ["带文字的横线", "--- 他说"],
    ["正文", "雨下了一整夜。"],
    ["列表项", "- 一个要点"],
    ["只有空格", "   "],
  ])("不误伤%s", (_name, s) => {
    expect(isSceneBreak(s as string)).toBe(false);
  });
});

describe("linesMatchingTexts", () => {
  it("返回所有匹配行号", () => {
    expect(linesMatchingTexts(lines("# 一\n正文\n# 二\n正文"), /^#\s+\S/)).toEqual([0, 2]);
  });

  it("无匹配返回空数组", () => {
    expect(linesMatchingTexts(lines("正文\n正文"), /^#\s/)).toEqual([]);
  });

  it("单行也能处理", () => {
    expect(linesMatchingTexts(["***"], SCENE_BREAK)).toEqual([0]);
  });

  it("空文档返回空数组", () => {
    expect(linesMatchingTexts([], /^/)).toEqual([]);
  });

  // 带 g 标志的正则有 lastIndex 状态，逐行 test 会漏掉一半匹配。
  // 这是个真实陷阱：SCENE_BREAK 本身没有 g，但复用同一个正则常量时很容易被加上。
  it("正则带 g 标志时不因 lastIndex 漏匹配", () => {
    expect(linesMatchingTexts(lines("***\n正文\n***\n正文\n***"), /\*{3}/g)).toEqual([0, 2, 4]);
  });

  // 调用方的正则不能被我们改坏
  it("不修改传入正则的 lastIndex", () => {
    const re = /\*{3}/g;
    linesMatchingTexts(["***", "***"], re);
    expect(re.lastIndex).toBe(0);
  });
});

describe("paragraphStartsFromTexts", () => {
  it("空行之后的正文行是段首", () => {
    expect(paragraphStartsFromTexts(lines("# 标题\n\n第一段。\n\n第二段。"))).toEqual([2, 4]);
  });

  it("首行即使前面没有空行也算段首", () => {
    expect(paragraphStartsFromTexts(["第一段。"])).toEqual([0]);
  });

  it("软换行的续行不算段首", () => {
    expect(paragraphStartsFromTexts(lines("第一段第一行\n第一段第二行"))).toEqual([0]);
  });

  // 结构性行缩进会破坏对齐或让内容变味，必须排除
  it.each([
    ["标题", "# 一级"],
    ["二级标题", "## 二级"],
    ["引用块", "> 引用"],
    ["无序列表", "- 条目"],
    ["星号列表", "* 条目"],
    ["有序列表", "1. 第一条"],
    ["表格", "| a | b |"],
    ["围栏代码", "```"],
    ["HTML 注释", "<!-- 草稿 -->"],
    ["HTML 标签", "<div>"],
    ["场景分隔", "***"],
  ])("排除%s", (_name, structural) => {
    // 行号：0=正文 1=空 2=结构行 3=空 4=正文 → 段首是 0 和 4
    expect(paragraphStartsFromTexts(lines(`正文\n\n${structural}\n\n正文`))).toEqual([0, 4]);
  });

  it("纯空行文档不炸", () => {
    expect(paragraphStartsFromTexts(lines("\n\n\n"))).toEqual([]);
  });

  it("空文档返回空数组", () => {
    expect(paragraphStartsFromTexts([])).toEqual([]);
  });

  // 真实的章节开头：frontmatter + 标题 + 正文
  it("真实章节结构", () => {
    const doc = ["---", "title: 第一章", "order: 1", "---", "", "# 第一章", "", "第一段。", "", "第二段。"];
    // frontmatter 内部各行为「前一行非空」，不算段首；标题与分隔也排除
    expect(paragraphStartsFromTexts(doc)).toEqual([7, 9]);
  });
});

describe("spansOf", () => {
  it("单行匹配", () => {
    const s = spansOf("你好 [[林晚]] 再见", WIKI_LINK);
    expect(s).toEqual([{ start: 3, end: 9 }]);
  });

  it("多个匹配", () => {
    const s = spansOf("[[甲]] 和 [[乙]]", WIKI_LINK);
    expect(s.length).toBe(2);
    expect(s[0].start).toBe(0);
  });

  // 作者常把整段草稿注掉，<!-- 与 --> 跨行。
  // 逐行扫会漏掉，于是最该变淡的地方反而不变淡。
  it("跨行备注能被完整覆盖", () => {
    const text = "正文。\n<!-- 草稿第一行\n草稿第二行 -->\n正文。";
    const s = spansOf(text, COMMENT);
    expect(s.length).toBe(1);
    expect(text.slice(s[0].start, s[0].end)).toBe("<!-- 草稿第一行\n草稿第二行 -->");
  });

  it("不匹配未闭合的备注", () => {
    expect(spansOf("<!-- 没有结尾", COMMENT)).toEqual([]);
  });

  it("双链不跨行", () => {
    expect(spansOf("[[甲\n乙]]", WIKI_LINK)).toEqual([]);
  });

  it("双链限制长度（防止吃掉半个文档）", () => {
    expect(spansOf(`[[${"很".repeat(120)}]]`, WIKI_LINK)).toEqual([]);
  });

  it("空字符串返回空数组", () => {
    expect(spansOf("", WIKI_LINK)).toEqual([]);
  });

  it("传入非全局正则也能扫描全部匹配", () => {
    expect(spansOf("a [[甲]] b [[乙]]", /\[\[[^\]]+\]\]/).length).toBe(2);
  });
});