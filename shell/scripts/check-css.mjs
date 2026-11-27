#!/usr/bin/env node
/**
 * 校验皮肤 CSS 里的选择器是否在上游 1.85.0 里真实存在。
 *
 *   node shell/scripts/check-css.mjs <upstream 源码根> <css 文件...>
 *
 * 判定方式：把我们每条选择器剥成「上游可能出现的片段链」，
 * 取末尾两段去上游 CSS 全文里找。找不到就报出来，人工确认是否是新规则。
 *
 * 为什么需要它：L3 皮肤靠选择器命中，写错一个类名不会报错，
 * 只会静默失效。上游改版时，这个脚本就是第一道报警。
 */
import fs from "node:fs";
import path from "node:path";

const [root, ...cssFiles] = process.argv.slice(2);
if (!root || !cssFiles.length) {
  console.error("用法：node check-css.mjs <upstream 源码根> <css 文件...>");
  process.exit(2);
}

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (["test", "tests", "fixtures", "node_modules", ".git"].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith(".css")) out.push(p);
  }
  return out;
}

const srcRoot = fs.existsSync(path.join(root, "src", "vs")) ? path.join(root, "src", "vs") : root;
// Markdown 预览的渲染与样式在 extensions/markdown-language-features 里，不在 src/vs
const extraRoots = [];
const mdExt = path.join(root, "extensions", "markdown-language-features");
if (fs.existsSync(mdExt)) extraRoots.push(mdExt);

const cssDirs = [srcRoot, ...extraRoots];
const upstream = cssDirs
  .flatMap((d) => walk(d))
  .map((f) => fs.readFileSync(f, "utf8"))
  .join("\n")
  .replace(/\s+/g, " ");

/** 剥掉我们的命名空间与伪类，生成后缀链候选 */
function candidates(sel) {
  let s = sel
    .replace(/:is\(\.novelpad[^)]*\)\s*/g, "")
    .replace(/:not\([^)]*\)/g, "")
    .replace(/::?[a-z-]+(\([^)]*\))?/g, "")
    .replace(/\s*>\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return [];
  const parts = s.split(" ");
  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join(" "));
  return out.filter((x) => x.length > 3);
}

let total = 0;
let misses = 0;

for (const file of cssFiles) {
  const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = new Set();
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    const sel = m[1].trim();
    if (!sel || sel.startsWith("@") || sel.startsWith(":root") || /^\d/.test(sel)) continue;
    for (const s of sel.split(",")) if (s.trim()) selectors.add(s.trim());
  }

  const missed = [];
  for (const sel of selectors) {
    const cands = candidates(sel);
    if (!cands.length) continue; // 纯伪类/变量声明，跳过
    total++;
    const ok = cands.some((c) => {
      const pieces = c.split(" ");
      const tail = pieces.slice(-2).join(" ");
      return tail.length > 3 && upstream.includes(tail);
    });
    if (!ok) missed.push(sel);
  }

  console.log(`\n${path.basename(file)}：${selectors.size} 条规则，未命中 ${missed.length} 条`);
  for (const m of missed) console.log("  ✗ " + m);
  misses += missed.length;
}

console.log(`\n合计 ${total} 条选择器，未命中 ${misses} 条`);
// 未命中不一定是错（可能是新写的类名），所以不返回非零
process.exit(0);