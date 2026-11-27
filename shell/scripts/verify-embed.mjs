#!/usr/bin/env node
/**
 * 内置扩展链路自检（秒级，不需要 gulp 构建）。
 *
 *   node shell/scripts/verify-embed.mjs
 *
 * 覆盖两个曾经真实出过问题的地方：
 *
 * 1. vsix 解压用系统 `tar`。
 *    Windows 的 `tar` 是 bsdtar，能读 zip；Linux 的 GNU tar 不能，
 *    一律报 "This does not look like a tar archive"。CI 的 linux job 就是这么挂的。
 *    现在用 lib/zip.mjs（纯 JS），这里就地造一个 zip 验证读写往返，
 *    不依赖任何外部命令，也不依赖是否有构建产物。
 *
 * 2. 扩展 manifest 有问题时不报错。
 *    VS Code 只是静默不激活——命令全部「未找到」、日志里什么都没有。
 *    这类故障只能靠打包时机器校验拦住，所以这里把规则本身测一遍。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { extractZip, listEntries, readEntry } from "./lib/zip.mjs";
import { validateExtensionManifest } from "./lib/manifest.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "np-verify-embed-"));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name}${extra ? `：${extra}` : ""}`);
  }
};

/* ============================================================
 * 最小 zip 写入器（只为测试解压器，不追求通用）
 * ============================================================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** @param {{name: string, data: Buffer, deflate?: boolean}[]} files */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const f of files) {
    const raw = f.data;
    const body = f.deflate ? zlib.deflateRawSync(raw) : raw;
    const method = f.deflate ? 8 : 0;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(f.name, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date（1980-01-01，固定值）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal
    central.writeUInt32LE(0, 38); // external
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

/* ============================================================
 * 1. zip 读写往返
 * ============================================================ */

{
  const payloads = [
    { name: "extension/package.json", data: Buffer.from('{"name":"novelpad","main":"./dist/extension.js"}'), deflate: true },
    { name: "extension/dist/extension.js", data: Buffer.from("console.log('中文内容，含多字节字符')"), deflate: true },
    // 存储（不压缩）分支也要覆盖：小型/已压缩文件 vsce 会用 store
    { name: "extension/media/logo.bin", data: Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f]), deflate: false },
    { name: "[Content_Types].xml", data: Buffer.from("<Types/>"), deflate: true },
  ];

  const zipPath = path.join(tmpRoot, "test.vsix");
  fs.writeFileSync(zipPath, buildZip(payloads));

  const buf = fs.readFileSync(zipPath);
  const entries = listEntries(buf);
  check("中央目录条目数正确", entries.length === payloads.length, `得到 ${entries.length}`);

  // 按需读取
  const pkgEntry = entries.find((e) => e.name === "extension/package.json");
  const pkgText = pkgEntry ? readEntry(buf, pkgEntry).toString("utf8") : "";
  check("deflate 条目内容正确", pkgText.includes('"novelpad"'), pkgText.slice(0, 60));

  const binEntry = entries.find((e) => e.name.endsWith("logo.bin"));
  const bin = binEntry ? readEntry(buf, binEntry) : Buffer.alloc(0);
  check("store 条目内容正确", Buffer.compare(bin, Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x7f])) === 0);

  // 整包解压
  const outDir = path.join(tmpRoot, "extracted");
  const stat = extractZip(zipPath, outDir);
  check("解压文件数正确", stat.files === payloads.length, `得到 ${stat.files}`);

  let allMatch = true;
  for (const p of payloads) {
    const got = fs.readFileSync(path.join(outDir, p.name));
    if (Buffer.compare(got, p.data) !== 0) allMatch = false;
  }
  check("解压后逐字节一致（含中文字节）", allMatch);

  // 坏 zip 要报错而不是静默返回空
  let threw = false;
  try {
    listEntries(Buffer.from("this is definitely not a zip file at all, padded to be long enough"));
  } catch {
    threw = true;
  }
  check("非 zip 输入报错而非静默成功", threw);
}

/* ============================================================
 * 2. manifest 校验规则
 * ============================================================ */

{
  const mk = (name, pkg, withMain = true) => {
    const d = path.join(tmpRoot, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg, null, 2));
    if (pkg && typeof pkg === "object" && pkg.main && withMain) {
      const m = path.join(d, pkg.main);
      fs.mkdirSync(path.dirname(m), { recursive: true });
      fs.writeFileSync(m, "// entry");
    }
    return d;
  };

  const base = {
    name: "novelpad",
    publisher: "pmcg125",
    version: "0.0.1",
    engines: { vscode: "^1.85.0" },
    main: "./dist/extension.js",
    activationEvents: ["onStartupFinished"],
    contributes: { commands: [{ command: "novelpad.x", title: "x" }] },
  };

  check("完整 manifest 通过", validateExtensionManifest(mk("ok", base)).length === 0);

  const { main, ...noMain } = base;
  check("缺 main 但有命令被拦", validateExtensionManifest(mk("nomain", noMain)).some((x) => x.includes("缺 main")));

  check(
    "main 指向不存在的文件被拦",
    validateExtensionManifest(mk("deadmain", base, false)).some((x) => x.includes("不存在的文件")),
  );

  const { engines, ...noEng } = base;
  check("缺 engines.vscode 被拦", validateExtensionManifest(mk("noeng", noEng)).some((x) => x.includes("engines.vscode")));

  const { publisher, ...noPub } = base;
  check("缺 publisher 被拦", validateExtensionManifest(mk("nopub", noPub)).some((x) => x.includes("publisher")));

  check(
    "纯声明式扩展（只有主题）不需要 main",
    validateExtensionManifest(
      mk("theme", { name: "np-theme", publisher: "p", version: "1.0.0", engines: { vscode: "^1.85.0" }, contributes: { themes: [] } }),
    ).length === 0,
  );

  check("坏 JSON 被拦且不崩", validateExtensionManifest(mk("badjson", "{ not json")).some((x) => x.includes("不是合法 JSON")));

  const empty = path.join(tmpRoot, "empty");
  fs.mkdirSync(empty, { recursive: true });
  check("缺 package.json 被拦", validateExtensionManifest(empty).some((x) => x.includes("缺 package.json")));
}

/* ============================================================
 * 3. 仓库里真实的扩展 manifest 必须能过
 * ============================================================ */

{
  const extPkg = path.join(here, "../../packages/extension/package.json");
  const extDir = path.dirname(extPkg);
  if (fs.existsSync(extPkg)) {
    const problems = validateExtensionManifest(extDir);
    check("packages/extension 的 manifest 合法", problems.length === 0, problems.join("；"));
    const pkg = JSON.parse(fs.readFileSync(extPkg, "utf8"));
    check("扩展带 publisher（不装也能算出正确扩展 ID）", Boolean(pkg.publisher), String(pkg.publisher));
  } else {
    check("找到 packages/extension/package.json", false, extPkg);
  }
}

fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "内置扩展链路自检通过" : "内置扩展链路自检失败"}：${pass} 通过，${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;