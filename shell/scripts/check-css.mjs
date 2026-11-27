#!/usr/bin/env node
/**
 * 校验皮肤 CSS 引用的类名是否在上游 1.85.0 里真实存在。
 *
 *   node shell/scripts/check-css.mjs <upstream 源码根> <css 文件...> [--warn-only]
 *
 * 为什么需要它：L3 皮肤靠选择器命中，类名写错不会报错，
 * 只会静默失效。上游改版时，这个脚本是第一道报警。
 *
 * 判定方式：
 *   1. 从上游所有 CSS 里收集类名。
 *   2. 加上「DOM 挂载点」——有些类名不写在 CSS 里，而是由 TS 拼进 DOM
 *      （`class="markdown-body"`、webview 的 `vscode-high-contrast`）。
 *      这类必须显式登记，并且脚本会去上游源码里核实登记是否还有效，
 *      所以上游改名时这里会立刻报错，不会悄悄放行。
 *   3. 我们的选择器剥掉命名空间后，里面的每个类名都必须在集合里。
 *
 * 纯元素选择器（`p` / `td p` / `blockquote p`）不参与比对：
 * 它们是自有排版规则（段首缩进、图注、表格内不缩进），
 * 上游没有对应规则才是正常的。
 */
import fs from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const warnOnly = rawArgs.includes("--warn-only");
const [root, ...cssFiles] = rawArgs.filter((a) => a !== "--warn-only");
if (!root || !cssFiles.length) {
  console.error("用法：node check-css.mjs <upstream 源码根> <css 文件...> [--warn-only]");
  process.exit(2);
}

function walk(d, ext, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (["test", "tests", "fixtures", "node_modules", ".git", "out", "dist"].includes(e.name)) continue;
      walk(p, ext, out);
    } else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

const srcRoot = fs.existsSync(path.join(root, "src", "vs")) ? path.join(root, "src", "vs") : root;
const scanRoots = [srcRoot];

// Markdown 预览的样式在 extensions/markdown-language-features，不在 src/vs
const mdExt = path.join(root, "extensions", "markdown-language-features");
if (fs.existsSync(mdExt)) scanRoots.push(mdExt);
// webview 主题类名定义在 webview contrib 里
const webviewRoot = path.join(srcRoot, "vs", "workbench", "contrib", "webview");
if (fs.existsSync(webviewRoot)) scanRoots.push(webviewRoot);

/* ============================================================
 * 1. 上游 CSS 里的类名
 * ============================================================ */

const cssFilesUpstream = scanRoots.flatMap((d) => walk(d, /\.css$/));
const upstreamCss = cssFilesUpstream.map((f) => fs.readFileSync(f, "utf8")).join("\n");

const classSet = new Set();
for (const m of upstreamCss.matchAll(/\.([a-zA-Z_][\w-]*)/g)) classSet.add(m[1]);

/* ============================================================
 * 2. DOM 挂载点：由 TS 拼进 DOM 的类名，CSS 里查不到
 *
 * 每一条都必须在源码里核实到，否则报「挂载点失效」。
 * 这是有意为之：上游一旦改名，这里比运行时先出声。
 * ============================================================ */

const MOUNT_POINTS = [
  {
    cls: "markdown-body",
    file: "extensions/markdown-language-features/src/preview/documentRenderer.ts",
    needle: 'class="markdown-body"',
  },
  {
    cls: "vscode-high-contrast",
    file: "src/vs/workbench/contrib/webview/browser/themeing.ts",
    needle: "vscode-high-contrast",
  },
  {
    cls: "vscode-high-contrast-light",
    file: "src/vs/workbench/contrib/webview/browser/themeing.ts",
    needle: "vscode-high-contrast-light",
  },
  {
    // 我们自己在 workbench.html 上挂的品牌类（shell/overlay），不属于上游，
    // 但要过选择器检查，所以登记为「本仓库提供的挂载点」
    cls: "novelpad",
    file: null,
    needle: null,
  },
];

const deadMounts = [];
for (const mp of MOUNT_POINTS) {
  if (!mp.file) {
    classSet.add(mp.cls);
    continue;
  }
  const f = path.join(root, mp.file);
  if (!fs.existsSync(f)) {
    deadMounts.push(`${mp.cls}（文件不在：${mp.file}）`);
    continue;
  }
  if (!fs.readFileSync(f, "utf8").includes(mp.needle)) {
    deadMounts.push(`${mp.cls}（${mp.file} 里找不到 ${mp.needle}）`);
    continue;
  }
  classSet.add(mp.cls);
}

/* ============================================================
 * 3. 逐条检查我们的选择器
 * ============================================================ */

/** 取出选择器里引用的类名（先剥命名空间与伪类参数） */
function classesOf(sel) {
  const s = sel
    .replace(/:is\([^)]*\)/g, "")
    .replace(/:not\([^)]*\)/g, "")
    .replace(/:has\([^)]*\)/g, "")
    .replace(/\.[a-zA-Z_][\w-]*/g, (m) => m); // 占位，保留类名
  return [...s.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]);
}

let total = 0;
let misses = 0;
let skipped = 0;

for (const file of cssFiles) {
  const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = new Set();
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith("@") || sel.startsWith(":root") || /^\d/.test(sel)) continue;
    for (const s of sel.split(",")) if (s.trim()) selectors.add(s.trim());
  }

  const missed = [];
  let fileSkipped = 0;
  for (const sel of selectors) {
    const cls = classesOf(sel);
    // 纯元素选择器：自有排版规则，上游没有对应规则是正常的
    if (!cls.length) {
      fileSkipped++;
      continue;
    }
    total++;
    const unknown = cls.filter((c) => !classSet.has(c));
    if (unknown.length) missed.push(`${sel}   ← 未定义：${unknown.map((c) => "." + c).join(" ")}`);
  }

  skipped += fileSkipped;
  console.log(`\n${path.basename(file)}：${selectors.size} 条规则，未命中 ${missed.length} 条`);
  for (const m of missed) console.log("  ✗ " + m);
  if (fileSkipped) console.log(`  （${fileSkipped} 条纯元素选择器，属自有排版规则，不做上游比对）`);
  misses += missed.length;
}

if (deadMounts.length) {
  console.log(`\n✗ DOM 挂载点失效 ${deadMounts.length} 个（上游可能已改名）：`);
  for (const d of deadMounts) console.log("  ✗ " + d);
}

console.log(
  `\n合计检查 ${total} 条带类名的选择器（跳过 ${skipped} 条纯元素），` +
    `未命中 ${misses} 条，挂载点失效 ${deadMounts.length} 个`,
);
console.log(`上游共收集 ${classSet.size} 个类名（${cssFilesUpstream.length} 个 CSS 文件）`);

const bad = misses + deadMounts.length;
if (!bad) {
  console.log("皮肤选择器全部可核实");
  process.exit(0);
}
if (warnOnly) {
  console.log("（--warn-only：仅告警，不影响退出码）");
  process.exit(0);
}
console.log("失败：引用未定义的类名 = 该规则在运行时静默失效");
process.exit(1);