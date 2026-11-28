#!/usr/bin/env node
/**
 * 校验「平台默认主题名」与「扩展主题名」逐字一致。
 *
 *   node shell/scripts/check-theme-defaults-match.mjs
 *
 * ── 为什么需要它 ──
 *
 * 003 补丁把 `ThemeSettingDefaults` 改成：
 *
 *     COLOR_THEME_DARK  = '夜墨 · NovelPad Ink'
 *     COLOR_THEME_LIGHT = '宣纸 · NovelPad Paper'
 *
 * 这两个字符串必须与 `packages/extension/themes/*.json` 里的 `name`
 * **逐字相同**。差一个空格、全角/半角标点不同、或者多了个「·」，
 * 上游就会认为「主题不存在」，**静默回退到内置主题**：
 *
 *   · 界面还是蓝色
 *   · 不报任何错
 *   · 扩展列表里两个主题看起来都正常
 *
 * 上游其实准备了错误信息（`errorMessage: "Theme is unknown or not installed."`），
 * 但那条只在用户**手动改设置**时弹；作为默认值失效时是完全静默的。
 *
 * 这个坑在开发机上永远不会暴露（主题名是你自己写的），只有用户装完
 * 看到蓝色时才发现——那时已经很难联想到是「名字对不上」。
 *
 * ── 判据 ──
 *
 *   1. 补丁的**新增行**里有 COLOR_THEME_DARK / LIGHT（看删除行会得出
 *      相反结论——补丁同时含新旧值）
 *   2. 这两个名字能在 themes/*.json 的 `name` 里找到（逐字）
 *   3. 补丁确实删掉了旧的 'Default Dark Modern' / 'Default Light Modern'
 *   4. uiTheme 方向对：深色主题 type=dark、浅色 type=light
 *      （写反了会得到「深色模式配浅色主题」的诡异组合）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const patchFile = path.join(repoRoot, "shell", "patches", "003-shell-defaults.patch");
const themesDir = path.join(repoRoot, "packages", "extension", "themes");

let bad = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) bad++;
};

if (!fs.existsSync(patchFile)) {
  console.error(`找不到 ${patchFile}`);
  process.exit(2);
}

/* ---------- 只看新增行 ---------- */
//
// 补丁里同时有：
//   -COLOR_THEME_DARK = 'Default Dark Modern',
//   +COLOR_THEME_DARK = '夜墨 · NovelPad Ink',
// 不加行首约束的正则会先匹配到**删除行**，得出「默认值还是蓝色」的
// 错误结论。这是写判据时最容易犯的错。
const patch = fs.readFileSync(patchFile, "utf8");
const lines = patch.split("\n");
const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n");
const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).join("\n");

const darkM = /COLOR_THEME_DARK = '([^']+)'/.exec(added);
const lightM = /COLOR_THEME_LIGHT = '([^']+)'/.exec(added);

if (!darkM || !lightM) {
  console.error("补丁的新增行里找不到 COLOR_THEME_DARK / COLOR_THEME_LIGHT");
  console.error("新增行片段：\n" + added.slice(0, 800));
  process.exit(1);
}

const wantDark = darkM[1];
const wantLight = lightM[1];

check("补丁新增了深色默认主题", true, wantDark);
check("补丁新增了浅色默认主题", true, wantLight);
check("旧值 Default Dark Modern 已删除", /COLOR_THEME_DARK = 'Default Dark Modern'/.test(removed));
check("旧值 Default Light Modern 已删除", /COLOR_THEME_LIGHT = 'Default Light Modern'/.test(removed));

/* ---------- 读扩展里声明的主题 ---------- */
const themes = [];
for (const f of fs.readdirSync(themesDir)) {
  if (!f.endsWith(".json")) continue;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(themesDir, f), "utf8"));
  } catch (e) {
    check(`主题文件可解析 ${f}`, false, e.message);
    continue;
  }
  if (j.name) themes.push({ file: f, name: j.name, type: j.type });
}

check("theme 目录里有主题", themes.length > 0, `${themes.length} 个`);

/* ---------- 逐字比对 ---------- */
const darkTheme = themes.find((t) => t.name === wantDark);
const lightTheme = themes.find((t) => t.name === wantLight);

check("深色默认主题名逐字匹配", !!darkTheme, darkTheme ? darkTheme.file : `没有 name === ${JSON.stringify(wantDark)} 的主题`);
check("浅色默认主题名逐字匹配", !!lightTheme, lightTheme ? lightTheme.file : `没有 name === ${JSON.stringify(wantLight)} 的主题`);

/* ---------- uiTheme 方向 ---------- */
//
// 写反了会得到「系统深色时切到浅色主题」的诡异组合。上游按
// `uiTheme` 决定用哪套基础色（弹窗、滚动条等），type 不对会让
// 这些组件的对比度失衡。
if (darkTheme) check("深色主题 type=dark", darkTheme.type === "dark", String(darkTheme.type));
if (lightTheme) check("浅色主题 type=light", lightTheme.type === "light", String(lightTheme.type));

/* ---------- 不匹配时打印首个差异字符 ---------- */
if (!darkTheme || !lightTheme) {
  console.log("\n=== 逐字符对比（定位差异）===");
  for (const [label, want] of [
    ["DARK", wantDark],
    ["LIGHT", wantLight],
  ]) {
    const cand = themes.find((t) => t.name.slice(0, 2) === want.slice(0, 2)) ?? themes[0];
    if (!cand) continue;
    console.log(`${label}: 补丁=${JSON.stringify(want)}`);
    console.log(`      主题=${JSON.stringify(cand.name)}`);
    for (let i = 0; i < Math.max(want.length, cand.name.length); i++) {
      if (want[i] !== cand.name[i]) {
        const a = want[i];
        const b = cand.name[i];
        console.log(
          `      首个差异 @${i}: 补丁=${JSON.stringify(a)}(U+${(a?.codePointAt(0) ?? 0).toString(16)}) ` +
            `主题=${JSON.stringify(b)}(U+${(b?.codePointAt(0) ?? 0).toString(16)})`,
        );
        break;
      }
    }
  }
}

console.log("");
if (bad) {
  console.error(`默认主题名校验失败 ${bad} 项。`);
  console.error("名字对不上时上游会静默回退到内置主题——界面是蓝色，不报错。");
  process.exit(1);
}
console.log("默认主题名与扩展主题名一致（深色/浅色方向也对）");