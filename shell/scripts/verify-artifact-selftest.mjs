#!/usr/bin/env node
/**
 * verify-artifact 的自检：用合成 zip 验证判据本身。
 *
 * 为什么守卫脚本也要测：初版就把 checksum 算法写成了 sha1（上游是 md5），
 * 并且把路径基准写成 resources/app/ 而不是 out/。两次都是「看起来对」：
 * 报错信息齐全、退出码非 0，只是理由全错。一个只会 FAIL 的守卫比没有守卫
 * 更糟——它会把真问题淹在噪声里。
 *
 * 这里造两类样本：
 *   - 好包：全部判据应通过（含 --expect-flat）
 *   - 坏包：每条判据各造一个反例，必须被抓住
 *
 *   node shell/scripts/verify-artifact-selftest.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeZip } from "./lib/zipwrite.mjs";
import { listEntries, readEntry } from "./lib/zip.mjs";
import { inspectArtifact, md5b64 } from "./lib/artifact.mjs";

let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) console.log(`OK   ${name}`);
  else {
    fail++;
    console.log(`FAIL ${name}${extra ? `  ${extra}` : ""}`);
  }
};

const MB = 1048576;

/** 造一个「全部合格」的条目集合（体积用 padding 撑到阈值以上） */
function goodFiles({ root = "", brandRoot = false } = {}) {
  const prefix = brandRoot ? "VSCode-win32-x64/" : root;
  const mainJs = Buffer.alloc(11 * MB, 0x2f);
  const mainCss = Buffer.alloc(512 * 1024, 0x2f);
  const preload = Buffer.from("// preload");
  const extHost = Buffer.from("// extension host");
  const workbenchJs = Buffer.from("// workbench bootstrap");
  const html = Buffer.from(
    '<!DOCTYPE html><html><head><link rel="stylesheet" href="../../../../../extensions/novelpad/media/workbench.css" /></head><body class="novelpad"></body></html>',
  );
  const commands = Array.from({ length: 55 }, (_, i) => ({ command: `novelpad.cmd${i}` }));

  // 上游固定校验这 6 个文件，缺一项启动时会去校验不存在的声明
  const sumFiles = {
    "vs/base/parts/sandbox/electron-sandbox/preload.js": preload,
    "vs/workbench/workbench.desktop.main.js": mainJs,
    "vs/workbench/workbench.desktop.main.css": mainCss,
    "vs/workbench/api/node/extensionHostProcess.js": extHost,
    "vs/code/electron-sandbox/workbench/workbench.html": html,
    "vs/code/electron-sandbox/workbench/workbench.js": workbenchJs,
  };

  const files = [
    { name: `${prefix}NovelPad.exe`, data: Buffer.alloc(101 * MB, 0) },
    { name: `${prefix}resources/app/package.json`, data: JSON.stringify({ name: "novelpad", version: "1.85.0" }) },
    { name: `${prefix}resources/app/out/vs/code/node/cli.js`, data: Buffer.alloc(2048, 0x2f) },
    {
      name: `${prefix}resources/app/extensions/novelpad/package.json`,
      data: JSON.stringify({ name: "novelpad", main: "./dist/extension.js", contributes: { commands } }),
    },
    { name: `${prefix}resources/app/extensions/novelpad/dist/extension.js`, data: Buffer.alloc(200 * 1024, 0x2f) },
    { name: `${prefix}resources/app/extensions/novelpad/media/workbench.css`, data: Buffer.alloc(8 * 1024, 0x2f) },
  ];
  // 被 checksums 覆盖的 6 个文件
  for (const [rel, data] of Object.entries(sumFiles)) {
    files.push({ name: `${prefix}resources/app/out/${rel}`, data });
  }
  // 字体分片：90 片，每片小体积即可（判据只看数量）
  for (let i = 0; i < 90; i++) {
    files.push({
      name: `${prefix}resources/app/extensions/novelpad/media/fonts/files/f${String(i).padStart(3, "0")}.woff2`,
      data: Buffer.alloc(64, 0x77),
    });
  }
  // 条目数 > 500：加一批无关但真实存在的文件
  for (let i = 0; i < 400; i++) {
    files.push({ name: `${prefix}resources/app/out/vs/filler/f${i}.js`, data: Buffer.from("x") });
  }

  // product.json 的 checksums 必须与上面真实内容一致
  const sums = Object.fromEntries(Object.entries(sumFiles).map(([rel, data]) => [rel, md5b64(data)]));
  files.push({
    name: `${prefix}resources/app/product.json`,
    data: JSON.stringify({
      nameShort: "NovelPad",
      nameLong: "NovelPad",
      applicationName: "novelpad",
      version: "1.85.0",
      commit: "a".repeat(40),
      builtInExtensions: [],
      extensionsGallery: { serviceUrl: "https://open-vsx.org/vscode/gallery" },
      checksums: sums,
    }),
  });

  return { files, sums, mainJs };
}

/** 把条目写成真 zip，再走「读文件 → 校验」的完整链路 */
function runInspect(files, expectFlat = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "np-art-"));
  const zipPath = path.join(dir, "a.zip");
  fs.writeFileSync(zipPath, makeZip(files));
  const buf = fs.readFileSync(zipPath);
  const entries = listEntries(buf).map((e) => ({ ...e, name: e.name.replace(/^\.\//, "") }));
  const byName = new Map(entries.map((e) => [e.name, e]));
  const results = inspectArtifact({
    entries,
    expectFlat,
    read: (n) => readEntry(buf, byName.get(n)),
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return results;
}

const failedOf = (results) => results.filter((r) => !r.ok).map((r) => r.name);

/* ---------------- 1. 好包必须全过 ---------------- */

{
  const { files } = goodFiles();
  const bad = failedOf(runInspect(files));
  check("好包（打平）全部判据通过", bad.length === 0, JSON.stringify(bad));
}

/* ---------------- 2. 每类坏包都要被抓住 ---------------- */

/** 拿好包，按需篡改，期望特定判据中出现指定关键词 */
function expects(label, mutate, keyword) {
  const { files } = goodFiles();
  mutate(files);
  const bad = failedOf(runInspect(files));
  check(`${label} → 被抓住`, bad.some((n) => n.includes(keyword)), JSON.stringify(bad));
}

expects("空壳（删掉编译产物）", (f) => {
  for (let i = f.length - 1; i >= 0; i--) {
    if (/workbench\/workbench\.desktop\.main\.js$/.test(f[i].name)) f[i].data = Buffer.from("// empty");
  }
}, "真编译");

expects("小 exe（假安装包）", (f) => {
  for (const x of f) if (/NovelPad\.exe$/.test(x.name)) x.data = Buffer.alloc(1024);
}, "不是空壳");

expects("checksums 被改（打包环节没重算）", (f) => {
  for (const x of f) {
    if (/resources\/app\/product\.json$/.test(x.name)) {
      const p = JSON.parse(x.data.toString("utf8"));
      p.checksums["vs/workbench/workbench.desktop.main.js"] = "AAAAAAAAAAAAAAAAAAAAAAAAAAA";
      x.data = Buffer.from(JSON.stringify(p));
    }
  }
}, "checksum vs/workbench/workbench.desktop.main.js");

expects("少声明一项 checksum（上游改清单时漏同步）", (f) => {
  for (const x of f) {
    if (/resources\/app\/product\.json$/.test(x.name)) {
      const p = JSON.parse(x.data.toString("utf8"));
      delete p.checksums["vs/workbench/api/node/extensionHostProcess.js"];
      x.data = Buffer.from(JSON.stringify(p));
    }
  }
}, "声明了 checksum vs/workbench/api/node/extensionHostProcess.js");

expects("内置扩展没塞进去", (f) => {
  for (let i = f.length - 1; i >= 0; i--) {
    if (/extensions\/novelpad\/dist\/extension\.js$/.test(f[i].name)) f.splice(i, 1);
  }
}, "dist/extension.js");

expects("L2 挂载点丢了", (f) => {
  for (const x of f) {
    if (/workbench\.html$/.test(x.name)) x.data = Buffer.from("<html><body></body></html>");
  }
}, 'class="novelpad"');

expects("扩展 manifest 是空壳（没有命令）", (f) => {
  for (const x of f) {
    if (/extensions\/novelpad\/package\.json$/.test(x.name)) {
      x.data = Buffer.from(JSON.stringify({ name: "novelpad", main: "./dist/extension.js", contributes: { commands: [] } }));
    }
  }
}, "空壳 manifest");

expects("字体分片缺失", (f) => {
  for (let i = f.length - 1; i >= 0; i--) {
    if (/\.woff2$/.test(f[i].name)) f.splice(i, 1);
  }
}, "字体分片");

expects("product.json 还是微软品牌", (f) => {
  for (const x of f) {
    if (/resources\/app\/product\.json$/.test(x.name)) {
      const p = JSON.parse(x.data.toString("utf8"));
      p.nameLong = "Microsoft Visual Studio Code";
      x.data = Buffer.from(JSON.stringify(p));
    }
  }
}, "不含 Microsoft");

expects("内置扩展名不是 novelpad", (f) => {
  for (const x of f) {
    if (/extensions\/novelpad\/package\.json$/.test(x.name)) {
      const p = JSON.parse(x.data.toString("utf8"));
      p.name = "something-else";
      x.data = Buffer.from(JSON.stringify(p));
    }
  }
}, "扩展名是 novelpad");

/* ---------------- 3. 品牌 / 目录层级 ---------------- */

{
  // 上游那种直接打 VSCode-win32-x64/ 的包：--expect-flat 必须拒绝
  const { files } = goodFiles({ brandRoot: true });
  const bad = failedOf(runInspect(files, true));
  check("套 VSCode-win32-x64/ 的包被 --expect-flat 拒绝", bad.some((n) => n.includes("解压根")), JSON.stringify(bad));
  check("套 VSCode-win32-x64/ 的包被品牌判据拒绝", bad.some((n) => n.includes("VSCode 品牌")), JSON.stringify(bad));

  // 同样的包，不要求打平时只 WARN（用于核验历史产物）
  const soft = failedOf(runInspect(files, false));
  check("不要求打平时只报品牌（不报层级）", !soft.some((n) => n.includes("解压根")), JSON.stringify(soft));
}

{
  // 换了名字但仍是嵌套目录（如 NovelPad/）：品牌判据放行，层级判据拦住
  const { files } = goodFiles({ root: "NovelPad/" });
  const bad = failedOf(runInspect(files, true));
  check("嵌套目录（非 VSCode 名）仍被层级判据拒绝", bad.some((n) => n.includes("解压根")), JSON.stringify(bad));
  check("嵌套目录（非 VSCode 名）不误报品牌", !bad.some((n) => n.includes("VSCode 品牌")), JSON.stringify(bad));
}

console.log(`\n${fail === 0 ? "PASS" : `FAIL: ${fail} 项`}  产物体检自检`);
process.exitCode = fail === 0 ? 0 : 1;