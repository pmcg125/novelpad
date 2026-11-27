#!/usr/bin/env node
/**
 * 主题完整性校验：扩展代码里引用的主题色，必须在两套主题里都有定义。
 *
 *   node shell/scripts/check-themes.mjs [extension 目录]
 *
 * 为什么需要它：
 *
 * `ThemeColor` 取不到颜色时，上游 resolveValue 返回字面量 'transparent'
 * （abstractCodeEditorService.ts:836）。也就是：
 *
 *   color: new ThemeColor('disabledForeground')
 *   → 主题里没这个键 → color: transparent → **那段文字直接消失**
 *
 * 对「备注变淡」「双链着色」这类装饰，后果是作者以为自己写的字丢了。
 * 而且它不报错、不警告，只在界面上静静消失。
 *
 * CSS 里的 `var(--vscode-textLink-foreground)` 同样静默，只是失效方式
 * 不同：拿不到定义值时回落到上游 registry 的默认色，而那是按 VS Code
 * 自己的视觉体系定的（light 主题链接是 #0066BF）。结果就是宣纸页面上
 * 出现微软蓝的链接和焦点框。
 *
 * 所以两条都要查：`new ThemeColor("x")` 与 `var(--vscode-x-y)`。
 * 早先只查前者，于是 disabledForeground / textLink.foreground 缺色
 * 一路绿灯进了打包（webview 全是 CSS 引用）。
 *
 * 还有一条：主题 JSON 是**生成产物**（packages/theme/scripts/build.mjs）。
 * 手改 JSON 会在下一次构建被静默覆盖，且如果只校验产物、不比对源，
 * 校验照样通过。所以这里额外核对「产物 == 源」。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const repoRoot = path.resolve(here, "../..");
const extDir = process.argv[2] ?? path.join(repoRoot, "packages/extension");

let fail = 0;
let pass = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`OK   ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name} ${extra}`);
  }
};

/* ============================================================
 * 1. 收集源码里引用的主题色
 * ============================================================

 * 两种引用方式都必须扫，缺色时的失效不一样但都静默：
 *   - `new ThemeColor("x")`  → 上游 resolveValue 返回 'transparent'，
 *     那段文字直接消失
 *   - `var(--vscode-x-y)`    → webview / CSS 拿不到主题时回落到
 *     VS Code 默认值，宣纸页面上出现微软蓝链接
 *
 * CSS 变量名与色 id 的映射规则：id 的 `.` 换成 `-`。
 * VS Code 的 color id 从不含连字符，所以反向替换是确定的。
 * （对照上游：textLink.foreground → --vscode-textLink-foreground）
 */

function walk(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** new ThemeColor("x") 与 new vscode.ThemeColor("x") */
const THEME_COLOR_RE = /new\s+(?:vscode\.)?ThemeColor\(\s*["']([^"']+)["']\s*\)/g;
/** var(--vscode-x-y)。排除 font-family / font-size 这类由 configuration 派生的键 */
const CSS_VAR_RE = /var\(\s*--vscode-([A-Za-z][A-Za-z0-9-]*)/g;
const NOT_A_COLOR = new Set([
  "font-family",
  "font-weight",
  "font-size",
  "editor-font-family",
  "editor-font-weight",
  "editor-font-size",
  "terminal-integrated-font-family",
]);

const srcDir = path.join(extDir, "src");
const mediaDir = path.join(extDir, "media");
if (!fs.existsSync(srcDir)) {
  console.log(`FAIL 找不到 ${srcDir}`);
  process.exit(1);
}

/** id → 出现在哪些文件的哪种引用 */
const referenced = new Map();
const addRef = (id, where) => {
  if (!referenced.has(id)) referenced.set(id, new Set());
  referenced.get(id).add(where);
};

// (a) TS 里的 new ThemeColor
for (const f of walk(srcDir, [".ts"]).filter((f) => !f.endsWith(".test.ts"))) {
  const rel = path.relative(extDir, f).replace(/\\/g, "/");
  for (const m of fs.readFileSync(f, "utf8").matchAll(THEME_COLOR_RE)) addRef(m[1], rel + " [ThemeColor]");
}

// (b) TS 与 CSS 里的 var(--vscode-…)
const cssSources = [
  ...walk(srcDir, [".ts"]).filter((f) => !f.endsWith(".test.ts")),
  ...(fs.existsSync(mediaDir) ? walk(mediaDir, [".css"]) : []),
];
for (const f of cssSources) {
  const rel = path.relative(extDir, f).replace(/\\/g, "/");
  for (const m of fs.readFileSync(f, "utf8").matchAll(CSS_VAR_RE)) {
    if (NOT_A_COLOR.has(m[1])) continue;
    addRef(m[1].replace(/-/g, "."), rel + " [css-var]");
  }
}

check(`源码里能扫到主题色引用（${referenced.size} 个）`, referenced.size > 0, "");

/* ============================================================
 * 2. 每套主题都要定义这些 id
 * ============================================================ */

const themesDir = path.join(extDir, "themes");
const themeFiles = fs.existsSync(themesDir)
  ? fs.readdirSync(themesDir).filter((f) => f.endsWith(".json"))
  : [];

check("找到主题文件", themeFiles.length >= 2, JSON.stringify(themeFiles));

for (const tf of themeFiles) {
  const p = path.join(themesDir, tf);
  let theme;
  try {
    theme = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    check(`${tf} 是合法 JSON`, false, String(e));
    continue;
  }
  const colors = theme.colors ?? {};
  const missing = [...referenced.keys()].filter((id) => !(id in colors));

  check(
    `${tf} 定义了全部引用的主题色（${referenced.size} 个）`,
    missing.length === 0,
    missing.length
      ? `缺：${missing.map((id) => `${id}（${[...referenced.get(id)].join(", ")}）`).join("；")}`
      : "",
  );
}

/* ============================================================
 * 3. 自检：这条规则真的会拦住东西
 *
 * 拿一个必然存在的键验证，防止正则写错导致 referenced 为空、
 * 于是所有检查都「通过」——那种假绿灯比没有检查更危险。
 * ============================================================ */

{
  const fake = 'const x = new vscode.ThemeColor("fake.id.that.does.not.exist");';
  const ids = [...fake.matchAll(THEME_COLOR_RE)].map((m) => m[1]);
  check("自检：正则能抓出 ThemeColor id", ids[0] === "fake.id.that.does.not.exist", JSON.stringify(ids));

  const noPrefix = 'new ThemeColor("a.b")';
  check("自检：不带 vscode. 前缀也能抓", [...noPrefix.matchAll(THEME_COLOR_RE)][0]?.[1] === "a.b");

  // CSS 变量这一路以前完全没扫，正是 disabledForeground 缺色却绿灯的原因。
  const css = "color: var(--vscode-fake-var-that-does-not-exist);";
  const cssId = [...css.matchAll(CSS_VAR_RE)][0]?.[1]?.replace(/-/g, ".");
  check("自检：var(--vscode-…) 能抓并还原成色 id", cssId === "fake.var.that.does.not.exist", String(cssId));

  // 连字符映射必须单向可靠：id 里不会同时出现 . 和 -
  const map = "textLink-foreground";
  check("自检：textLink-foreground → textLink.foreground", map.replace(/-/g, ".") === "textLink.foreground");

  // 这个 id 一定不在主题里，检查逻辑必须报缺
  const anyTheme = themeFiles[0];
  if (anyTheme) {
    const t = JSON.parse(fs.readFileSync(path.join(themesDir, anyTheme), "utf8"));
    check(
      "自检：未定义的主题色会被判为缺失",
      !("fake.id.that.does.not.exist" in (t.colors ?? {})),
    );
  }

  // 主题源与随包产物必须一致：改 build.mjs 不重新构建，校验的是旧产物，
  // 绿灯会一路带到发版（这次就是这个坑）。
  const themeSrc = path.join(repoRoot, "packages/theme/themes");
  if (fs.existsSync(themeSrc)) {
    for (const tf of themeFiles) {
      const a = path.join(themesDir, tf);
      const b = path.join(themeSrc, tf);
      if (!fs.existsSync(b)) continue;
      check(
        `${tf} 与主题源一致（构建产物未过期）`,
        fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8"),
      );
    }
  }

  /*
   * 最后一道，也是真正对应这次事故的一道：**主题 JSON 本身是生成产物**
   * （packages/theme/scripts/build.mjs 由设计令牌生成）。手改它，下一次
   * 构建会静默覆盖——上面那条「产物 vs 源」的比对挡不住，因为被改的正是源。
   *
   * 唯一的可靠办法是重新生成到临时目录再逐字节比对。谁改了 JSON 没改生成器，
   * 这里立刻报出来。
   */
  const genScript = path.join(repoRoot, "packages/theme/scripts/build.mjs");
  if (fs.existsSync(genScript)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "novelpad-theme-"));
    try {
      execFileSync(process.execPath, [genScript, tmp], { stdio: "pipe" });
      for (const tf of themeFiles) {
        const a = path.join(themeSrc, tf);
        const b = path.join(tmp, tf);
        if (!fs.existsSync(a) || !fs.existsSync(b)) continue;
        check(
          `${tf} 与生成器输出一致（没有手改主题 JSON）`,
          fs.readFileSync(a, "utf8") === fs.readFileSync(b, "utf8"),
          "主题 JSON 是 build.mjs 生成的，手改会被覆盖——请改 packages/theme/scripts/build.mjs 的令牌",
        );
      }
    } catch (e) {
      check("生成器可运行", false, String(e?.message ?? e));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

console.log(`\n${fail === 0 ? "主题完整性校验通过" : "主题完整性校验失败"}：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;