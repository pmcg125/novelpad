#!/usr/bin/env node
/**
 * 壳产物体检：下载回来的 zip 到底是不是能双击启动的真构建。
 *
 * 为什么要这个文件：
 *
 * 1. **壳曾经长期是空壳**。闸门 bug 让 push 触发的构建全部跳过 gulp，
 *    产出几 MB 的占位目录却全绿。体积能骗人，文件清单不能。
 *
 * 2. **checksums 对不上会直接崩**。`product.json` 里声明的是 VS Code
 *    启动时的完整性校验。我们打了 workbench.html / workbench.js 的补丁，
 *    如果打包环节没重算 checksums，用户双击就是「安装损坏」——而这在 CI
 *    面板上依然全绿。这里把每个声明值算一遍，对不上立刻出声。
 *
 * 3. **品牌红线**。产物目录名里带 `VSCode-win32-x64` 就是把 VS Code 的名字
 *    发给用户，解压还多一层无谓的嵌套。`--expect-flat` 要求解压根就是应用根。
 *
 * 用法：
 *   node shell/scripts/verify-artifact.mjs <某.zip> [--expect-flat]
 *
 * 退出码非 0 = 这个包不能发。
 * 判据在 lib/artifact.mjs；自检见 verify-artifact-selftest.mjs。
 */
import fs from "node:fs";
import path from "node:path";
import { listEntries, readEntry } from "./lib/zip.mjs";
import { inspectArtifact } from "./lib/artifact.mjs";

const args = process.argv.slice(2);
const zipPath = args.find((a) => !a.startsWith("--"));
const expectFlat = args.includes("--expect-flat");

if (!zipPath || !fs.existsSync(zipPath)) {
  console.error("用法: node shell/scripts/verify-artifact.mjs <某.zip> [--expect-flat]");
  process.exit(1);
}

const buf = fs.readFileSync(zipPath);
// 从目录内打包（7z / zip 的 `a .`）可能写入 `./` 或 `.\` 前缀，
// 7z 在 Windows 上还可能用反斜杠当分隔符。统一归一再比对。
const norm = (n) => n.replace(/\\/g, "/").replace(/^\.\//, "");
const raw = listEntries(buf);
const entries = raw.map((e) => ({ ...e, name: norm(e.name) }));
const byName = new Map(entries.map((e) => [e.name, e]));

console.log(
  `包：${path.basename(zipPath)}  ${(buf.length / 1048576).toFixed(1)} MB  ${entries.length} 条目`,
);

const appRoot = entries
  .find((e) => /(^|\/)resources\/app\/product\.json$/.test(e.name))
  ?.name.replace(/resources\/app\/product\.json$/, "");
if (appRoot !== undefined) {
  console.log(`应用根：${appRoot === "" ? "（解压根）" : appRoot}`);
}

const results = inspectArtifact({
  entries,
  expectFlat,
  read: (name) => {
    const e = byName.get(name);
    if (!e) throw new Error(`条目不存在：${name}`);
    return readEntry(buf, e);
  },
});

let fail = 0;
for (const r of results) {
  if (r.ok) console.log(`OK   ${r.name}${r.detail ? `  ${r.detail}` : ""}`);
  else {
    fail++;
    console.log(`FAIL ${r.name}${r.detail ? `  ${r.detail}` : ""}`);
  }
}

console.log(`\n${fail === 0 ? "PASS" : `FAIL: ${fail} 项`}  产物体检`);
process.exitCode = fail === 0 ? 0 : 1;