/**
 * 壳外观判据的单测。
 *
 * 为什么这些判据值得单独测：两个方向的错误都只能靠跑出来。
 *   - 判宽了：在标准 VS Code 里也认为「我是壳」，于是把用户的主题改掉。
 *   - 判窄了：在壳里不生效，皮肤继续用默认深色的变量，看起来像「没做」。
 * 两者都不会报错。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INK_THEME,
  PAPER_THEME,
  SHELL_HTML_REL,
  SHELL_THEME_KEYS,
  appRootOf,
  htmlFileIsNovelPadShell,
  htmlIsNovelPadShell,
  isNovelPadShell,
  shellThemeValues,
  shouldApplyTheme,
} from "./shell-theme-rules.js";

describe("识别壳的 workbench.html", () => {
  it("有 body class=novelpad 就是壳（我们补丁的样子）", () => {
    const html = `<html><head><link rel="stylesheet" href="../../../../../extensions/novelpad/media/workbench.css" /></head><body class="novelpad" aria-label=""></body></html>`;
    expect(htmlIsNovelPadShell(html)).toBe(true);
  });

  it("只有 css 引用也算（补丁被改窄但 link 还在）", () => {
    expect(htmlIsNovelPadShell(`<html><body><link href="extensions/novelpad/media/workbench.css"></body></html>`)).toBe(true);
  });

  it("上游原版 html 不是壳", () => {
    // 取自 upstream 1.85.0 的真身：body 上没有 class
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8" /></head><body aria-label=""></body><script src="workbench.js"></script></html>`;
    expect(htmlIsNovelPadShell(html)).toBe(false);
  });

  it("class 里含 novelpad 但作为别的词的一部分不算", () => {
    expect(htmlIsNovelPadShell(`<body class="notnovelpad">`)).toBe(false);
    expect(htmlIsNovelPadShell(`<body class="novelpad-other">`)).toBe(false);
  });

  it("class 属性顺序无关、单引号也算", () => {
    expect(htmlIsNovelPadShell(`<body id="x" class='a novelpad b'>`)).toBe(true);
    expect(htmlIsNovelPadShell(`<body data-x="1" class="windows novelpad">`)).toBe(true);
  });
});

describe("从扩展目录反推 app 根", () => {
  // 不要写 path.join("C:", ...)：Windows 上 "C:" 是盘符，Linux 上只是普通
  // 目录名，path.join 会把它当相对路径拼成 "<cwd>/C:/fake/..."，
  // 于是同一个测试在两个平台得到不同结果（CI 就是这样红的）。
  // 用 os.tmpdir() 造平台无关的绝对路径。
  it("extensions/novelpad 的上一级上一级就是 app", () => {
    const app = path.join(os.tmpdir(), "np-fake", "resources", "app");
    const ext = path.join(app, "extensions", "novelpad");
    expect(appRootOf(ext)).toBe(app);
  });

  it("反推结果与路径分隔符无关（只用 .. 上跳两级）", () => {
    // 用正斜杠写一遍：Linux/macOS 原生，Windows 也接受
    const ext = "/opt/novelpad/resources/app/extensions/novelpad";
    expect(appRootOf(ext)).toBe(path.resolve("/opt/novelpad/resources/app"));
  });
});

describe("磁盘上判断（含读不到的情况）", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-shell-"));

  const makeTree = (html: string | null) => {
    const app = path.join(tmp, `app-${Math.random().toString(36).slice(2)}`);
    const ext = path.join(app, "extensions", "novelpad");
    fs.mkdirSync(ext, { recursive: true });
    const file = path.join(app, ...SHELL_HTML_REL);
    if (html !== null) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, html, "utf8");
    }
    return { app, ext, file };
  };

  it("壳布局 → true", () => {
    const { ext } = makeTree(`<body class="novelpad">`);
    expect(isNovelPadShell(ext)).toBe(true);
  });

  it("标准 VS Code 布局（上游 html 在场）→ false", () => {
    const { ext } = makeTree(`<body aria-label="">`);
    expect(isNovelPadShell(ext)).toBe(false);
  });

  // 关键：读不到时绝不能猜成壳。误判成壳会去改用户的主题。
  it("html 不存在 → false（不是壳）", () => {
    const { ext } = makeTree(null);
    expect(isNovelPadShell(ext)).toBe(false);
    expect(htmlFileIsNovelPadShell(path.join(tmp, "no-such-file.html"))).toBe(false);
  });
});

describe("跟随系统深浅色的三个设置", () => {
  it("打开 autoDetect，并给两套主题各自的槽位", () => {
    expect(shellThemeValues()).toEqual({
      "window.autoDetectColorScheme": true,
      "workbench.preferredLightColorTheme": PAPER_THEME,
      "workbench.preferredDarkColorTheme": INK_THEME,
    });
  });

  // 三个键必须成套：只开 autoDetect 不给 preferred*，系统切深色时会
  // 掉回 VS Code 自带主题，皮肤变量当场全变（比不设更难看）。
  it("三个键成套出现", () => {
    const v = shellThemeValues();
    expect(Object.keys(v).sort()).toEqual(Object.values(SHELL_THEME_KEYS).sort());
    expect(Object.keys(v)).toHaveLength(3);
  });
});

describe("什么时候该写主题", () => {
  const none = { [SHELL_THEME_KEYS.autoDetect]: undefined, [SHELL_THEME_KEYS.light]: undefined, [SHELL_THEME_KEYS.dark]: undefined };

  it("首次 + 用户什么都没设 → 写", () => {
    expect(shouldApplyTheme(false, none)).toBe(true);
  });

  it("已经处理过 → 不写（尊重用户后来换的主题）", () => {
    expect(shouldApplyTheme(true, none)).toBe(false);
    expect(shouldApplyTheme(true, { ...none, [SHELL_THEME_KEYS.autoDetect]: false })).toBe(false);
  });

  // 打开 autoDetect 会令 colorTheme 失效，此时覆盖用户设过的主题
  // 等于把「编辑器长什么样」的选择彻底抹掉。碰过任何一个就整套不动。
  it("用户碰过其中任何一个 → 不写", () => {
    expect(shouldApplyTheme(false, { ...none, [SHELL_THEME_KEYS.light]: "Default Light Modern" })).toBe(false);
    expect(shouldApplyTheme(false, { ...none, [SHELL_THEME_KEYS.dark]: "Default Dark Modern" })).toBe(false);
    expect(shouldApplyTheme(false, { ...none, [SHELL_THEME_KEYS.autoDetect]: false })).toBe(false);
    expect(shouldApplyTheme(false, { ...none, [SHELL_THEME_KEYS.autoDetect]: true })).toBe(false);
  });
});