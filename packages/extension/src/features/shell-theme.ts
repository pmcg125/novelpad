/**
 * 壳外观：只有跑在 NovelPad 壳里时才激活自带主题。
 *
 * ── 为什么需要这一步 ──
 *
 * 皮肤文件 `media/workbench.css` 全部用 `var(--vscode-*)` 取色（这是
 * 刻意设计：色值只有一个来源，改色不碰皮肤）。上线实测发现壳里界面
 * 仍是 VS Code 默认深色，CDP 探针给出根因：
 *
 *   body class="novelpad"       ✅ L2 挂载成功
 *   workbench.css               ✅ 已加载，33 条规则
 *   --vscode-editor-background  ❌ #1f1f1f（默认深色）
 *
 * 也就是 L3 一切正常，缺的是**主题从来没被激活过**：
 * `contributes.themes` 只是把主题「登记」进列表，不会设成默认值。
 * 没有 NovelPad 主题，那些 `--vscode-*` 变量就全是默认深色值，
 * 皮肤自然「看起来没生效」。
 *
 * ── 为什么不用 configurationDefaults ──
 *
 * 那是扩展级的默认值，会连标准 VS Code 里的用户一起改主题。
 * 「同一份扩展、两种外观」是硬要求（扩展要能单独装进标准 VS Code），
 * 所以只能在壳里、由扩展主动设一次。
 *
 * ── 为什么用 autoDetect 而不是启动时读一次 ──
 *
 * 产品要求「跟随系统深浅色」。VS Code 原生就有这个机制
 * （`window.autoDetectColorScheme` + 两个 preferred 主题），它是持续
 * 跟随的：用户在 Windows 里切深色，界面当场变。
 *
 * 启动时读 `window.activeColorTheme.kind` 做不到这一点：那一刻它还是
 * 默认主题的值（不是系统偏好），而且只反映开机时的状态。
 *
 * ── 为什么只设一次 ──
 *
 * 打开 autoDetect 会让 `workbench.colorTheme` 失效，而那是用户对
 * 「编辑器长什么样」最直接的表达。所以只要用户自己碰过这几个键中的
 * 任何一个，就整套不动。
 *
 * 判据与取值逻辑在 ./shell-theme-rules.ts（纯函数，可单测）。
 */
import * as vscode from "vscode";
import {
  SHELL_THEME_KEYS,
  isNovelPadShell,
  shellThemeValues,
  shouldApplyTheme,
} from "./shell-theme-rules";

const STATE_KEY = "novelpad.shellThemeApplied";

/**
 * 壳里首次启动时把主题设成「跟随系统 + 两套自带主题」。
 *
 * 返回 true 表示这次真的写了设置（首次），false 表示跳过。
 */
export async function applyShellTheme(context: vscode.ExtensionContext): Promise<boolean> {
  if (!isNovelPadShell(context.extensionPath)) return false;

  const cfg = vscode.workspace.getConfiguration();
  const applied = context.globalState.get<boolean>(STATE_KEY) ?? false;

  // 只看用户**显式**写过的值（globalValue / workspaceValue）。
  // defaultValue 是上游默认值，不能当用户选择。
  const userValues: Record<string, string | boolean | undefined> = {};
  for (const key of Object.values(SHELL_THEME_KEYS)) {
    const i = cfg.inspect(key);
    userValues[key] = (i?.globalValue as string | boolean | undefined) ?? (i?.workspaceValue as string | boolean | undefined);
  }

  if (!shouldApplyTheme(applied, userValues)) {
    if (!applied) await context.globalState.update(STATE_KEY, true);
    return false;
  }

  try {
    for (const [key, value] of Object.entries(shellThemeValues())) {
      await cfg.update(key, value, vscode.ConfigurationTarget.Global);
    }
    await context.globalState.update(STATE_KEY, true);
    return true;
  } catch {
    // 写设置失败不该阻断启动：界面会退回默认深色，但功能都还在
    return false;
  }
}