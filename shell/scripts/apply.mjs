#!/usr/bin/env node
/**
 * 壳构建第一步：把 overlay/ 覆盖到上游源码，再按序应用 patches/*.patch。
 *
 *   node shell/scripts/apply.mjs <upstream-dir>
 *
 * 任何补丁冲突 → 非零退出，CI 立即红。
 * 补丁原则：能 overlay 整文件覆盖就不写 diff；每个 .patch 必须 < 100 行。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shellRoot = path.resolve(here, "..");
const upstream = path.resolve(process.argv[2] ?? path.join(shellRoot, "upstream"));
if (!fs.existsSync(path.join(upstream, "package.json"))) {
  console.error(`upstream 目录不是 VS Code 源码：${upstream}`);
  process.exit(2);
}

const log = (s) => console.log(`[apply] ${s}`);

/* ---------- 0. 图标：每次构建都重新生成，保证品牌图形可复现 ----------
   生成的 PNG 是逐像素算出来的，不含时间戳，所以同一版本源码产出同一份字节。 */
execFileSync(process.execPath, [path.join(here, "gen-icons.mjs")], { stdio: "pipe" });
log("品牌图标已生成（win32 / linux / darwin）");

/* 深度合并：对象递归合并，数组/标量由 overlay 直接替换 */
const merge = (base, over) => {
  if (Array.isArray(over) || over === null || typeof over !== "object") return over;
  const out = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
  return out;
};

/* ---------- 1. overlay：product.json 合并，其余整文件覆盖 ---------- */
const overlay = path.join(shellRoot, "overlay");
let overlaid = 0;
if (fs.existsSync(overlay)) {
  const walk = (dir, rel = "") => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else {
        const to = path.join(upstream, r);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (r === "product.json" && fs.existsSync(to)) {
          // 上游 product.json 有 win32*/server* 等构建必需字段，不能整体覆盖
          const from = path.join(dir, e.name);
          const merged = merge(JSON.parse(fs.readFileSync(to, "utf8")), JSON.parse(fs.readFileSync(from, "utf8")));
          fs.writeFileSync(to, JSON.stringify(merged, null, 2) + "\n");
          log(`overlay ${r}（与上游深度合并）`);
        } else {
          fs.copyFileSync(path.join(dir, e.name), to);
          log(`overlay ${r}`);
        }
        overlaid++;
      }
    }
  };
  walk(overlay);
}

/* ---------- 2. product.json 补字段（避免覆盖上游新增字段） ---------- */
// 上游 product.json 里有 version/commit 等构建期字段，overlay 已覆盖；这里确保 commit 占位存在
const productPath = path.join(upstream, "product.json");
const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
if (!product.version) product.version = JSON.parse(fs.readFileSync(path.join(upstream, "package.json"), "utf8")).version ?? "0.0.0";
if (!product.commit) product.commit = "novelpad";
if (!product.date) product.date = new Date().toISOString();
if (!product.quality) product.quality = "stable";
fs.writeFileSync(productPath, JSON.stringify(product, null, 2) + "\n");
log("product.json 补充构建期字段");

/* ---------- 3. patches：按文件名顺序重放 ---------- */
const patchesDir = path.join(shellRoot, "patches");
const patches = fs.existsSync(patchesDir) ? fs.readdirSync(patchesDir).filter((f) => f.endsWith(".patch")).sort() : [];
let applied = 0;
for (const p of patches) {
  const file = path.join(patchesDir, p);
  try {
    execFileSync("git", ["apply", "--3way", "--whitespace=fix", file], { cwd: upstream, stdio: "pipe" });
    applied++;
    log(`patch  ${p} ✓`);
  } catch (e) {
    console.error(`\n✗ 补丁冲突：${p}\n上游 ${path.basename(upstream)} 的这段代码变了，需要重新生成补丁。\n`);
    console.error((e.stderr ?? "").toString().slice(0, 2000));
    process.exit(1);
  }
}
if (!patches.length) log("patches/ 为空（当前只靠 overlay）");

log(`完成：overlay ${overlaid} 文件，patches ${applied}/${patches.length}`);
