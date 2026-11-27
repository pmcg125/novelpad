/**
 * 批注展示的纯函数，**不依赖 vscode**。
 *
 * 单独成模块的理由和 typeset-rules 一样：可测。
 * 尤其是 escapeMd——它是把「别人写的文本」拼进 MarkdownString 之前的
 * 唯一一道处理，必须能单测。
 */

/**
 * 转义 Markdown 特殊字符。
 *
 * 为什么必须做：批注正文来自 `.novelpad/annotations.jsonl`，那是一个
 * 可以手改、可以被人 clone 后写入的文件。直接拼进 MarkdownString，
 * 里面的 `[](...)`、`![](...)` 就会生效——包括 VS Code 特有的
 * `[点我](command:xxx)` 命令链接。批注不该有执行能力。
 *
 * 只转义**能构造结构**的字符，不转 `.` `-` 这类正文里到处都是的字符：
 * 把「这里可以再压一句。」显示成「这里可以再压一句\。」是不可接受的，
 * 转义要保护安全，不能毁掉可读性。
 *
 * 反斜杠必须一起转，否则原文里的 `\*` 会变成「被转义的反斜杠 +
 * 未转义星号」，反而漏掉一个。
 */
export function escapeMd(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+!|]/g, (c) => `\\${c}`);
}

/** 压成单行并截断，用于树视图与状态栏 */
export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
}

/** 状态的中文标签 */
export function statusLabel(s: string): string {
  switch (s) {
    case "accepted":
      return "已接受";
    case "rejected":
      return "已拒绝";
    case "resolved":
      return "已解决";
    case "orphaned":
      return "已失效";
    case "open":
      return "待处理";
    default:
      return "";
  }
}