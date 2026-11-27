/**
 * 批注展示层的纯函数单测。
 *
 * escapeMd 是**安全边界**：批注正文来自 .novelpad/annotations.jsonl，
 * 可能是协作者写的、也可能被手改过。直接拼进 MarkdownString 会让
 * 里面的 markdown 语法生效（图片、链接、命令链接）。这里逐条钉住。
 */
import { describe, expect, it } from "vitest";
import { escapeMd, truncate } from "./annotations-rules.js";

describe("escapeMd", () => {
  it("转义 Markdown 强调符", () => {
    expect(escapeMd("*斜体*")).toBe("\\*斜体\\*");
    expect(escapeMd("_下划线_")).toBe("\\_下划线\\_");
    expect(escapeMd("`代码`")).toBe("\\`代码\\`");
  });

  it("转义标题与引用标记", () => {
    expect(escapeMd("# 标题")).toBe("\\# 标题");
  });

  // 句号、连字符、逗号在中文正文里到处都是，转了会毁掉可读性。
  // 它们单独出现构不成 Markdown 结构（列表要有行首 + 空格）。
  it("不转义正文里常见的标点", () => {
    expect(escapeMd("这里可以再压一句。")).toBe("这里可以再压一句。");
    expect(escapeMd("他说——然后走了")).toBe("他说——然后走了");
    expect(escapeMd("3.5 秒之后")).toBe("3.5 秒之后");
  });

  it("转义方括号（防止链接与命令链接）", () => {
    expect(escapeMd("[文字](http://evil)")).toBe("\\[文字\\]\\(http://evil\\)");
  });

  it("转义感叹号（防止图片语法）", () => {
    expect(escapeMd("![图](x)")).toBe("\\!\\[图\\]\\(x\\)");
  });

  // 命令链接是 VS Code 特有的：正文里塞进去点一下就会执行命令
  it("转义后无法构成命令链接", () => {
    const attack = "[点我](command:workbench.action.terminal.new)";
    const safe = escapeMd(attack);
    expect(safe).not.toMatch(/(?<!\\)\[.*\]\(command:/);
  });

  it("反斜杠本身被转义，不会被当成转义符吃掉", () => {
    expect(escapeMd("a\\b")).toBe("a\\\\b");
  });

  it("普通中文不受影响", () => {
    expect(escapeMd("这里可以再压一句，节奏会更好")).toBe("这里可以再压一句，节奏会更好");
  });

  it("管道符被转义（防止破坏表格）", () => {
    expect(escapeMd("a|b")).toBe("a\\|b");
  });

  it("空字符串原样返回", () => {
    expect(escapeMd("")).toBe("");
  });
});

describe("truncate", () => {
  it("短文本原样返回", () => {
    expect(truncate("短", 10)).toBe("短");
  });

  it("超长加省略号", () => {
    expect(truncate("一二三四五", 3)).toBe("一二三…");
  });

  it("折行被压成空格（侧栏单行显示）", () => {
    expect(truncate("第一行\n第二行", 20)).toBe("第一行 第二行");
  });

  it("多个空白压成一个", () => {
    expect(truncate("a   b\t\tc", 20)).toBe("a b c");
  });

  it("首尾空白被去掉", () => {
    expect(truncate("  a  ", 10)).toBe("a");
  });

  it("长度按压紧后的文本算", () => {
    // "a b" 压紧后 3 字，n=3 不该截断
    expect(truncate("a    b", 3)).toBe("a b");
  });

  it("空字符串不炸", () => {
    expect(truncate("", 5)).toBe("");
  });
});