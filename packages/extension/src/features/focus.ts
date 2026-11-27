/**
 * 专注模式 —— 写作时把工具全部退到视线之外。
 *
 * 复用上游 Zen Mode，不自己写一套「改工作区设置」的平行实现：
 *
 *   · 上游 `workbench.action.toggleZenMode` 已经做了隐藏活动栏 / 状态栏 /
 *     标签页 —— 而且用 UI State，不往 `.vscode/settings.json` 写东西。
 *   · 早先的实现往 `.vscode/settings.json` 写 `workbench.activityBar.visible`，
 *     两个问题：这个键在 1.85.0 已 deprecated（迁移到
 *     `workbench.activityBar.location`）；而且会把 IDE 布局偏好写进
 *     作者的稿件仓库——稿子里不该出现 IDE 配置。
 *   · Zen Mode 自带 `zenMode.hideActivityBar / hideStatusBar / showTabs /
 *     centerLayout / fullScreen / restore / silentNotifications`，
 *     正是我们要的七个开关，且全部可用 `configurationDefaults` 预设。
 *
 * 于是这里**不存任何状态、不改任何用户设置**：
 * 专注模式 = 预设好七个 zenMode 默认值 + 一个 toggle 命令。
 * Zen 是开是关由上游自己管，用户用 Esc / 菜单 / 命令面板退出都不会留下脏状态。
 *
 * 打字机滚动（`editor.cursorSurroundingLines`）不进这里——它是全员默认值，
 * 写在 package.json 的 configurationDefaults 里，见 PLAN-UI §5.1。
 */
import * as vscode from "vscode";

/** Zen 已开启时 setContext 会置为 true，但扩展侧读不到；这里只做展示用 */
const ZEN_ON_HINT = "NovelPad：专注模式（Esc 或再按一次退出）";

/**
 * 进入 / 退出专注模式。
 * 上游只有 toggleZenMode 与 exitZenMode 两个命令（layoutActions.ts），
 * 没有 enterZenMode —— 所以「进入」也必须走 toggle。
 * Zen 的开 / 关状态由上游自己管，扩展侧无需记账，用户
 * 用 Esc（连按两次）/ 菜单 / 命令面板退出都不会留下脏状态。
 */
export async function toggleFocusMode(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.toggleZenMode");
  vscode.window.setStatusBarMessage(ZEN_ON_HINT, 3000);
}

/** exitZenMode 自带 `when: InEditorZenModeContext`，不在 Zen 里时是 no-op，可安全直接调 */
export async function exitFocusMode(): Promise<void> {
  await vscode.commands.executeCommand("workbench.action.exitZenMode");
}

export function registerFocusMode(): vscode.Disposable[] {
  return [vscode.commands.registerCommand("novelpad.focusMode", () => toggleFocusMode())];
}