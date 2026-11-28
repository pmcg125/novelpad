/**
 * 正文栏宽：只有跑在 NovelPad 壳里时，把编辑器切成「居中版式」。
 *
 * ── 为什么需要这一步 ──
 *
 * 真机跑起来才发现的排版缺陷：正文从 x=64 一直铺到右边缘，1900px 宽、
 * 19px 字号，一行约 98 个汉字。中文书的正文一行 30~40 字，视线不需要
 * 来回扫。98 字意味着读到行尾再回到下一行开头时眼睛要找位置，长时间
 * 写作非常累——这跟「护眼优先」是直接冲突的。
 *
 * 而 `editor.wordWrap: "on"` 只保证「不出现横向滚动条」，它按**窗口宽度**
 * 换行，所以屏幕越宽，一行越长。恰恰是把「宽屏 = 更难读」这个反向关系
 * 顶到了极致。
 *
 * ── 为什么用上游的居中版式，而不是自己算宽度 ──
 *
 * 上游有现成的 `workbench.action.toggleCenteredLayout`（视图 > 外观 >
 * 居中版式）：编辑器被两条可拖动的分隔线夹在中间，两侧留白，拖动即时
 * 生效。它是布局层的正规实现，光标定位、选区、滚动全部按真实宽度计算。
 *
 * 自己用 CSS 给编辑器加 `max-width` 是错的：Monaco 用容器的实测尺寸
 * 做排版（`getBoundingClientRect`），而分组容器是 grid 用内联样式绝对
 * 定位的，CSS 盖内部宽度会和每次 layout 打架，光标点选错位正是这么来的。
 * 底线是「不拿编辑手感换视觉」，所以这条路直接排除。
 *
 * 固定 900px 而不是按比例：上游默认按 61.8% 分（左右各 19.09%），1920
 * 的屏上中间还有 1150px 宽，一行 ≈59 字，还是偏宽；4K 上更离谱。
 * `workbench.editor.centeredLayoutFixedWidth` 打开后按 `targetWidth`
 * 取 900px（约 46 字），并且作者拖动分隔线后的宽度会被记住。
 *
 * ── 为什么要「每个工作区只切一次」 ──
 *
 * 居中版式的开关是**工作区级**状态（上游 `LayoutStateKeys.EDITOR_CENTERED`，
 * 存 workspace storage），默认关闭。所以对它只能「翻转」，不能「设为开」。
 * 而扩展读不到这个状态（`inCenteredLayout` 是 context key，只有菜单能用）。
 *
 * 于是按工作区记一次账：第一次进这个工作区时翻一次（默认关 → 开），
 * 之后不再碰。作者自己按「视图 > 外观 > 居中版式」关掉是正当选择，
 * 下次启动不会被我们掰回来。
 *
 * 判断「在壳里」复用 ./shell-theme-rules 的判据：两边必须用同一套，
 * 否则会出现「主题激活了但版式没切」这种半截状态。
 *
 * 纯逻辑在 ./measure-rules.ts（不 import vscode，可单测）。
 */
import * as vscode from "vscode";
import { isNovelPadShell } from "./shell-theme-rules";
import {
  CENTER_COMMAND,
  FIXED_WIDTH_KEY,
  explicitValue,
  shouldCenter,
  shouldSetFixedWidth,
  withCentered,
} from "./measure-rules";

/** 已经切过居中版式的工作区（globalState，字符串数组） */
const STATE_KEY = "novelpad.centeredWorkspaces";

/**
 * 启动后等多久再切。
 *
 * 太早会踩空：`activate` 阶段编辑器分组可能还没建出来，布局服务里的
 * `centeredLayoutWidget` 是 undefined，翻转命令会直接抛。上游自己也是
 * 等 `mainPart.whenRestored` 之后才碰这块（layout.ts:489）。
 *
 * 1.5s 比书房的 700ms 更晚：书房那一步会打开 webview，等它就位再切，
 * 居中一次算准，不会出现「先居中书房、再重排」的闪动。
 */
const DEFER_MS = 1500;

/** 工作区标识：文件夹 / 工作区文件 / 空窗口 三种情况分开记账 */
export function workspaceKey(): string {
  return (
    vscode.workspace.workspaceFile?.toString() ??
    vscode.workspace.workspaceFolders?.[0]?.uri.toString() ??
    "empty"
  );
}

/** 打开「固定宽度」——只在作者没自己设过时写，尊重既有选择 */
async function ensureFixedWidth(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration();
  const userSet = explicitValue(cfg.inspect<boolean>(FIXED_WIDTH_KEY));
  if (!shouldSetFixedWidth(userSet)) return;
  try {
    await cfg.update(FIXED_WIDTH_KEY, true, vscode.ConfigurationTarget.Global);
  } catch {
    // 写不进去就退回上游的比例宽度，版式仍然居中，只是稍宽
  }
}

/**
 * 壳里首次进入某个工作区时打开居中版式。
 *
 * 返回 true 表示这次真的切了。
 */
export async function applyShellMeasure(context: vscode.ExtensionContext): Promise<boolean> {
  if (!isNovelPadShell(context.extensionPath)) return false;

  const key = workspaceKey();
  const done = context.globalState.get<string[]>(STATE_KEY) ?? [];
  if (!shouldCenter(done, key)) return false;

  await ensureFixedWidth();

  try {
    await vscode.commands.executeCommand(CENTER_COMMAND);
    await context.globalState.update(STATE_KEY, withCentered(done, key));
    return true;
  } catch {
    // 布局还没就绪就放弃这次：宁可这一版偏宽，也不要抛错打断启动。
    // 不记账，下次启动还有机会。
    return false;
  }
}

/** 延迟到布局就绪后再切。返回的 setTimeout 句柄交给调用方登记销毁 */
export function scheduleShellMeasure(context: vscode.ExtensionContext): NodeJS.Timeout {
  return setTimeout(() => void applyShellMeasure(context), DEFER_MS);
}