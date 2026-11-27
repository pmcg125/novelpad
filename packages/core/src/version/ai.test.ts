/**
 * AI 分账单测。
 *
 * 这一层的代价是**数据丢失级**的：多删一段就是删掉作者写的字。
 * 所以每条用例都在守一个具体的误删场景。
 */
import { describe, expect, it } from "vitest";
import { describeUndo, planAIUndo, splitFrontmatter } from "./ai.js";

const FM = "---\ntitle: 第一章\nwordCount: 100\n---\n";

describe("splitFrontmatter", () => {
  it("拆出 frontmatter 与正文", () => {
    const r = splitFrontmatter(`${FM}\n正文一。\n`);
    expect(r.head).toBe(FM);
    expect(r.body).toBe("\n正文一。\n");
  });

  it("没有 frontmatter 时 head 为空", () => {
    const r = splitFrontmatter("正文一。\n");
    expect(r.head).toBe("");
    expect(r.body).toBe("正文一。\n");
  });

  it("正文里出现的 --- 不会被误判为 frontmatter（只认文件开头）", () => {
    const r = splitFrontmatter("正文。\n\n---\n\n后面。\n");
    expect(r.head).toBe("");
  });
});

describe("planAIUndo", () => {
  it("删掉 AI 新增的段落，保留作者原有段落", () => {
    const prevText = "作者写的第一段。\n\n作者写的第二段。\n";
    const aiText = "作者写的第一段。\n\n作者写的第二段。\n\nAI 写的新段落。\n";
    const curText = aiText;

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.removed).toBe(1);
    expect(plan.noop).toBe(false);
    expect(plan.text).toBe("作者写的第一段。\n\n作者写的第二段。\n");
    expect(plan.removedParagraphs[0]).toContain("AI 写的新段落");
  });

  it("作者在 AI 段落之后又写了内容：只删 AI 段，作者新写的留着", () => {
    const prevText = "开头。\n";
    const aiText = "开头。\n\nAI 的段落。\n";
    const curText = "开头。\n\nAI 的段落。\n\n作者后加的一段。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.removed).toBe(1);
    expect(plan.text).toBe("开头。\n\n作者后加的一段。\n");
  });

  it("作者在 AI 段落之前插了一段：AI 段照样删掉，插的那段不动", () => {
    const prevText = "开头。\n";
    const aiText = "开头。\n\nAI 的段落。\n";
    const curText = "开头。\n\n作者插在中间的。\n\nAI 的段落。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.removed).toBe(1);
    expect(plan.text).toBe("开头。\n\n作者插在中间的。\n");
  });

  it("作者把 AI 段落改得面目全非：保留，不删（宁可不撤销也不能删错）", () => {
    const prevText = "开头。\n";
    const aiText = "开头。\n\nAI 原句，雨落在瓦上。\n";
    const curText = "开头。\n\n作者重写过的完全不同的句子，跟原文没有关系。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.removed).toBe(0);
    expect(plan.kept).toBe(1);
    expect(plan.noop).toBe(true);
    expect(plan.text).toBe(curText);
    expect(plan.reason).toContain("对不上");
  });

  it("同一段 AI 文字在正文里出现了两次：只删一次（另一处可能是作者自己写的）", () => {
    const prevText = "她笑了。\n";
    const aiText = "她笑了。\n\n此间无言。\n";
    // 作者后来又自己写了一遍同样的句子
    const curText = "她笑了。\n\n此间无言。\n\n此间无言。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.removed).toBe(1);
    expect(plan.text).toBe("她笑了。\n\n此间无言。\n");
  });

  it("CRLF 文件照样能删（Windows 上必现的坑）", () => {
    const prevText = "开头。\r\n";
    const aiText = "开头。\r\n\r\nAI 的段落。\r\n";
    const curText = aiText;

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.removed).toBe(1);
    expect(plan.text).toBe("开头。\r\n");
  });

  it("AI 段落内部含空行时按「一段」整体删掉，不留半截", () => {
    const prevText = "开头。\n";
    const aiText = "开头。\n\n第一段 AI。\n\n第二段 AI。\n";
    const curText = aiText;

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    // AI 的两个段落都在 diff 的 added 里，各删一次
    expect(plan.removed).toBe(2);
    expect(plan.text).toBe("开头。\n");
  });

  it("删掉中间段落后，上下两段之间只剩一个空行（不留双空行）", () => {
    const prevText = "一。\n\n二。\n";
    const aiText = "一。\n\n二。\n\nAI 段。\n";
    const curText = "一。\n\n二。\n\nAI 段。\n\n作者后加的。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.text).toBe("一。\n\n二。\n\n作者后加的。\n");
    expect(plan.text).not.toContain("\n\n\n");
  });

  it("AI 段落位于文件末尾：删掉后不留尾部空行", () => {
    const prevText = "开头。\n";
    const aiText = "开头。\n\nAI 段。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: aiText });
    expect(plan.text).toBe("开头。\n");
  });

  it("没有上一版时拒绝动手（宁可不动，不能整章删掉）", () => {
    const plan = planAIUndo({ prevText: undefined, aiText: "AI 段。\n", currentText: "AI 段。\n" });
    expect(plan.noop).toBe(true);
    expect(plan.removed).toBe(0);
    expect(plan.text).toBe("AI 段。\n");
    expect(plan.reason).toContain("分不清");
  });

  it("AI 只改不增（在原有段落里改）：报告 mixed，一个字段都不改", () => {
    const prevText = "雨落在瓦上，很轻。\n";
    const aiText = "雨落在瓦上，极轻，像有人在屋顶上走。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: aiText });
    expect(plan.removed).toBe(0);
    expect(plan.mixed).toBe(1);
    expect(plan.text).toBe(aiText);
    expect(plan.reason).toContain("改在原有段落里");
  });

  it("frontmatter 里的字数变化不算 AI 正文（不会被当成要删的段）", () => {
    const prevText = `${FM}\n开头。\n`;
    const aiText = `${FM}\n开头。\n\nAI 段。\n`;
    const curText = aiText.replace("wordCount: 100", "wordCount: 120");

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.removed).toBe(1);
    // frontmatter 原样保留（包括作者/AI 写的新字数）
    expect(plan.text).toContain("wordCount: 120");
    expect(plan.text).not.toContain("AI 段");
  });

  it("段落只差空格时仍然删除（作者可能格式化过）", () => {
    const prevText = "开头。\n";
    const aiText = "开头。\n\nAI 的段落，有逗号。\n";
    const curText = "开头。\n\nAI 的段落，  有逗号。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.removed).toBe(1);
    expect(plan.text).toBe("开头。\n");
  });

  it("什么都不做时 text 与输入完全相同（不偷偷改格式）", () => {
    const prevText = "开头。\n";
    const aiText = "开头。\n\nAI 段。\n";
    const curText = "开头。\n";

    const plan = planAIUndo({ prevText, aiText, currentText: curText });
    expect(plan.noop).toBe(true);
    expect(plan.text).toBe(curText);
  });
});

describe("describeUndo", () => {
  it("说清楚删了几段、保留几段", () => {
    expect(describeUndo({ removed: 3, kept: 1, mixed: 0, noop: false } as never)).toBe(
      "删掉 3 段，保留 1 段（你改过）",
    );
  });

  it("noop 时给出原因", () => {
    expect(describeUndo({ removed: 0, kept: 0, mixed: 0, noop: true, reason: "分不清" } as never)).toBe("分不清");
  });
});