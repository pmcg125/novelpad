/**
 * 正文栏宽的纯逻辑（不 import vscode，可单测）。
 *
 * 业务代码在 ./measure.ts。
 *
 * ── 为什么要限制栏宽 ──
 *
 * 真机跑起来才看到的缺陷：正文从 x=64 铺到右边缘，1900px、19px 字号，
 * 一行约 98 个汉字。中文书正文一行 30~40 字，视线不用来回扫；98 字意味着
 * 读到行尾再回到下一行开头时眼睛要找位置，长时间写作非常累——和
 * 「护眼优先」直接冲突。
 *
 * `editor.wordWrap: "on"` 只保证「没有横向滚动条」，它按**窗口宽度**换行，
 * 屏幕越宽一行越长，恰好把「宽屏 = 更难读」顶到极致。
 *
 * 解法用上游的居中版式（`workbench.action.toggleCenteredLayout`），不自己
 * 用 CSS 限宽：Monaco 用容器实测尺寸排版，而分组容器是 grid 内联定位的，
 * CSS 盖内部宽度会和每次 layout 打架，光标点选错位就是这么来的。
 * 底线是「不拿编辑手感换视觉」。
 */

/** 居中版式的开关是工作区级运行时状态，只能翻转、不能直接置开 */
export const CENTER_COMMAND = "workbench.action.toggleCenteredLayout";

/** 固定宽度（而不是按窗口比例）。上限 900px ≈ 46 字一行 */
export const FIXED_WIDTH_KEY = "workbench.editor.centeredLayoutFixedWidth";

/**
 * 这一版还需要为某个工作区切一次居中版式吗？
 *
 * 居中版式的开关存在上游 workspace storage 里，默认关闭，而且扩展读不到
 * 它的当前值（`inCenteredLayout` 是 context key，只有菜单能用来做 when）。
 * 所以只能按工作区记一次账：第一次进这个工作区翻一次（默认关 → 开），
 * 之后不再碰。
 *
 * 不碰的原因：作者自己按「视图 > 外观 > 居中版式」关掉是正当选择
 * （比如双栏对照两章），下次启动被我们掰回来等于剥夺选择权。
 */
export function shouldCenter(done: readonly string[], key: string): boolean {
  return !done.includes(key);
}

/** 记完账的新数组（不原地改，避免共享引用被外部改动） */
export function withCentered(done: readonly string[], key: string): string[] {
  return done.includes(key) ? [...done] : [...done, key];
}

/**
 * 「固定宽度」该不该由我们写。
 *
 * 只在作者没自己设过时写一次。写成 `true` 之后作者仍然可以自己改回
 * `false`（那就回到按比例 61.8% 分栏），我们不会去覆盖。
 */
export function shouldSetFixedWidth(userValue: boolean | undefined): boolean {
  return userValue === undefined;
}

/**
 * 从 `inspect()` 结果里取「作者显式写过的值」。
 *
 * 注意 `defaultValue` 不是作者的选择：上游默认 `false`，把它当作用户意图
 * 会导致我们永远不写这个键。
 */
export function explicitValue<T>(inspected: {
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
} | undefined): T | undefined {
  return inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
}