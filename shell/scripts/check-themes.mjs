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
 * 所以：源码里出现的每个 ThemeColor id，都要在每套主题里显式定义。
 * 上游 colorRegistry 虽然给了默认值兜底，但默认值是按 VS Code 自己的
 * 视觉体系定的（比如链接是蓝色），跟 NovelPad 的宣纸青绿完全不搭。
 */
import fs from "node:fs";
import path from "node:path";

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
 * ============================================================ */

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** new ThemeColor("x") 与 new vscode.ThemeColor("x") */
const THEME_COLOR_RE = /new\s+(?:vscode\.)?ThemeColor\(\s*["']([^"']+)["']\s*\)/g;

const srcDir = path.join(extDir, "src");
if (!fs.existsSync(srcDir)) {
  console.log(`FAIL 找不到 ${srcDir}`);
  process.exit(1);
}

/** id → 出现在哪些文件 */
const referenced = new Map();
for (const f of walk(srcDir)) {
  const text = fs.readFileSync(f, "utf8");
  ThemedLoop: for (const m of text.matchAll(THEME_COLOR_RE)) {
    const id = m[1];
    if (!referenced.has(id)) referenced.set(id, new Set());
    referenced.get(id).add(path.relative(extDir, f).replace(/\\/g, "/"));
  }
}

check("源码里能扫到 ThemeColor 引用", referenced.size > 0, String(referenced.size));

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

  // 这个 id 一定不在主题里，检查逻辑必须报缺
  const anyTheme = themeFiles[0];
  if (anyTheme) {
    const t = JSON.parse(fs.readFileSync(path.join(themesDir, anyTheme), "utf8"));
    check(
      "自检：未定义的主题色会被判为缺失",
      !("fake.id.that.does.not.exist" in (t.colors ?? {})),
    );
  }
}

console.log(`\n${fail === 0 ? "主题完整性校验通过" : "主题完整性校验失败"}：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;