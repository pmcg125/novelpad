/**
 * 字体资产自检：CSS 引用与磁盘文件必须双向一致。
 * 用法：node check-fonts.mjs <media/fonts 目录> [--min-shards 90]
 */
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const minIdx = process.argv.indexOf("--min-shards");
const minShards = minIdx > 0 ? Number(process.argv[minIdx + 1]) : 90;

const cssFile = path.join(dir, "lxgw-wenkai-screen-gb.css");
if (!fs.existsSync(cssFile)) {
  console.error(`✗ 缺少字体 CSS：${cssFile}`);
  process.exit(1);
}

const css = fs.readFileSync(cssFile, "utf8");
const urls = [...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]);
const filesDir = path.join(dir, "files");
const onDisk = new Set(fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : []);

const missing = urls.filter((u) => !fs.existsSync(path.join(dir, u)));
const referenced = new Set(urls.map((u) => path.basename(u)));
const orphans = [...onDisk].filter((f) => !referenced.has(f));
const faces = (css.match(/@font-face/g) ?? []).length;

const total = [...onDisk].reduce((s, f) => s + fs.statSync(path.join(filesDir, f)).size, 0);

let bad = false;
if (faces === 0) {
  console.error("✗ CSS 里没有 @font-face");
  bad = true;
}
if (urls.length < minShards) {
  console.error(`✗ CSS 只引用 ${urls.length} 个分片，少于下限 ${minShards}`);
  bad = true;
}
if (missing.length) {
  console.error(`✗ CSS 引用了不存在的文件：${missing.slice(0, 5).join(", ")}`);
  bad = true;
}
if (orphans.length) {
  // 有文件没被引用只是浪费体积，不阻断构建，但要报出来
  console.warn(`! 有 ${orphans.length} 个分片未被引用：${orphans.slice(0, 5).join(", ")}`);
}
if (!css.includes("font-display: swap")) {
  console.warn("! 没有 font-display: swap，首屏可能被字体阻塞");
}

if (bad) process.exit(1);
console.log(`字体自检通过：${faces} 个 @font-face，${urls.length} 个分片，合计 ${(total / 1024 / 1024).toFixed(2)} MB`);