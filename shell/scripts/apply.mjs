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

/* ---------- 1. overlay：整文件覆盖 ---------- */
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
        fs.copyFileSync(path.join(dir, e.name), to);
        overlaid++;
        log(`overlay ${r}`);
      }
    }
  };
  walk(overlay);
}

/* ---------- 2. product.json 补字段（避免覆盖上游新增字段） ---------- */
// 上游 product.json 里有 version/commit 等构建期字段，overlay 已覆盖；这里确保 commit 占位存在
const productPath = path.join(upstream, "product.json");
const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
if (!product.version) product.version = "0.0.0";
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
