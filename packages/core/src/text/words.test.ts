import { describe, expect, it } from "vitest";
import { countMarkdownWords, countWords, stripMarkdown } from "./words.js";

describe("stripMarkdown", () => {
  it("去除标题井号与强调标记", () => {
    expect(stripMarkdown("# 标题\n**粗体** *斜体* ~~删除~~")).toBe("标题\n粗体 斜体 删除");
  });

  it("去除 HTML 注释（作者备注）", () => {
    expect(stripMarkdown("正文<!-- 备注：待改 -->结束")).toBe("正文结束");
  });

  it("链接保留文字，图片丢弃", () => {
    expect(stripMarkdown("看[这里](http://x)和![图](a.png)")).toBe("看这里和");
  });

  it("双链 [[名|别名]] 取别名，[[名]] 取名", () => {
    expect(stripMarkdown("[[林晚]]和[[林晚|阿晚]]")).toBe("林晚和阿晚");
  });

  it("去除列表、引用、水平线标记", () => {
    expect(stripMarkdown("- a\n* b\n> 引用\n---")).toBe("a\nb\n引用");
  });
});

describe("countWords", () => {
  it("每个汉字计 1，标点不计", () => {
    expect(countWords("雨是从傍晚开始下的。")).toBe(9);
  });

  it("连续拉丁字母串计 1", () => {
    expect(countWords("他说 OK 然后 go home")).toBe(7); // 他说(2) OK(1) 然后(2) go(1) home(1)
  });

  it("混合中英文", () => {
    expect(countWords("我有 3 个 apple")).toBe(5); // 我有(2) 3(1) 个(1) apple(1)
  });

  it("空字符串为 0", () => {
    expect(countWords("")).toBe(0);
  });
});

describe("countMarkdownWords", () => {
  it("不计 Markdown 标记与备注", () => {
    const md = "# 标题\n\n正文**加粗**内容\n<!-- 备注不算 -->\n[[林晚]]来了";
    // 标题(2) 正文加粗内容(6) 林晚来了(4) = 12
    expect(countMarkdownWords(md)).toBe(12);
  });
});
