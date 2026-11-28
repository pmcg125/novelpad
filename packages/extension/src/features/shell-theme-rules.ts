/**
 * 壳外观的纯逻辑（不 import vscode，可单测）。
 *
 * 业务代码在 ./shell-theme.ts。
 *
 * 这里单独拆出来的原因：`isNovelPadShell` 的判据「读 workbench.html 看
 * 有没有挂载点」正是整个方案里最容易写错的一处——写宽了会在标准 VS Code
 * 里误判（把用户的主题改掉），写窄了在壳里不生效（皮肤看起来没作用）。
 * 两种错都只能靠跑出来，所以判据必须能脱离 vscode 单测。
 */
import fs from "node:fs";
import path from "node:path";

export const PAPER_THEME = "宣纸 · NovelPad Paper";
export const INK_THEME = "夜墨 · NovelPad Ink";

/** 壳的 workbench.html 相对 app 根的位置 */
export const SHELL_HTML_REL = [
  "out",
  "vs",
  "code",
  "electron-sandbox",
  "workbench",
  "workbench.html",
];

/**
 * 从扩展目录反推 app 根。
 *
 * 布局固定：<app>/extensions/novelpad → <app>
 * （打包时 embed-extension.mjs 就塞在这个位置）
 */
export function appRootOf(extensionPath: string): string {
  return path.resolve(extensionPath, "..", "..");
}

/**
 * 判断一份 workbench.html 是不是我们的壳。
 *
 * 两个独立特征，命中任一即算：
 *   1. `<body ... class="...novelpad..."`（L2 挂载点）
 *   2. 对我们的皮肤 css 的引用
 *
 * 不靠 product.json 的 nameShort：名字谁都能改，挂载点才是壳独有的补丁。
 *
 * 注意 class 的「整词」边界不能写 `\bnovelpad\b`：`-` 是单词边界，
 * `novelpad-other` 会被误判成命中。这里要求前后是引号/空白/结尾。
 * 单双引号都要认——上游模板用的是双引号，但补丁被改成单引号时不该失效。
 */
export function htmlIsNovelPadShell(html: string): boolean {
  const body = /<body\b[^>]*>/i.exec(html)?.[0] ?? "";
  const cls = /class\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(body);
  const names = (cls?.[1] ?? cls?.[2] ?? "").split(/\s+/);
  if (names.includes("novelpad")) return true;
  return html.includes("extensions/novelpad/media/workbench.css");
}

/** 读磁盘上的 workbench.html 并判断；读不到一律当作不是壳 */
export function htmlFileIsNovelPadShell(htmlPath: string): boolean {
  let text;
  try {
    text = fs.readFileSync(htmlPath, "utf8");
  } catch {
    // 标准 VS Code 里这个路径**是存在的**（上游自己的 workbench.html），
    // 所以「读不到」只可能是非标准布局或权限异常。两种都按「不是壳」处理：
    // 误判成壳会去改用户主题，代价远大于漏判（漏判只是皮肤不生效）。
    return false;
  }
  return htmlIsNovelPadShell(text);
}

export function isNovelPadShell(extensionPath: string): boolean {
  return htmlFileIsNovelPadShell(path.join(appRootOf(extensionPath), ...SHELL_HTML_REL));
}

/**
 * 需要写哪几个设置才能「跟随系统深浅色」。
 *
 * 用 VS Code 原生的 autoDetect 机制，而不是启动时读一次
 * `window.activeColorTheme.kind` 就定死：
 *
 *   - autoDetect 是**持续跟随**：用户在 Windows 里切深浅色，界面当场变。
 *   - 启动时读一次只能跟随「开机的那个状态」，之后切系统要重启才生效，
 *     而且启动那一刻 activeColorTheme 还是默认主题的值，读到的根本
 *     不是系统偏好。
 *
 * `window.autoDetectColorScheme` 打开后，`workbench.colorTheme` 就不再
 * 生效（上游按系统深浅去取 preferred* 两键），所以三个必须一起写。
 */
export const SHELL_THEME_KEYS = {
  /** 打开「跟随系统」总开关 */
  autoDetect: "window.autoDetectColorScheme",
  /** 系统浅色时用它 */
  light: "workbench.preferredLightColorTheme",
  /** 系统深色时用它 */
  dark: "workbench.preferredDarkColorTheme",
} as const;

/** 三个键对应的目标值 */
export function shellThemeValues(): Record<string, string | boolean> {
  return {
    [SHELL_THEME_KEYS.autoDetect]: true,
    [SHELL_THEME_KEYS.light]: PAPER_THEME,
    [SHELL_THEME_KEYS.dark]: INK_THEME,
  };
}

/**
 * 判断「是否该由我们写主题」。
 *
 * @param alreadyApplied 之前是否已经处理过（globalState）
 * @param userValues    这三个键里用户**显式**写过的那些（键 → 值）
 *
 * 只要用户碰过其中任何一个，就整套不动。
 *
 * 为什么这么保守：`workbench.colorTheme` 是用户对"我的编辑器长什么样"
 * 最直接的表达。我们已经要打开 autoDetect（那会让 colorTheme 失效），
 * 在这种情况下再覆盖用户设过的 colorTheme 等于把他的选择彻底抹掉。
 * 首次启动没设过 = 白纸，才可以写。
 */
export function shouldApplyTheme(
  alreadyApplied: boolean,
  userValues: Record<string, string | boolean | undefined>,
): boolean {
  if (alreadyApplied) return false;
  return Object.values(userValues).every((v) => v === undefined);
}