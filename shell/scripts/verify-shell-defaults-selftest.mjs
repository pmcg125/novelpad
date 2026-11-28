#!/usr/bin/env node
/**
 * `verify-shell-defaults.mjs` 的判据自检。
 *
 *   node shell/scripts/verify-shell-defaults-selftest.mjs <应用根目录>
 *
 * ── 为什么守卫脚本自己也需要自检 ──
 *
 * 初版的判据是「在 security.workspace.trust.enabled 附近找 default」。
 * 实际产物里那个键名只出现在常量定义处（`exports.$9kb = '...'`），
 * 真正的配置块在 110 万字符之外。于是脚本永远输出「unknown」——
 * 看起来在检查，其实既不会过也不会对。
 *
 * 这种「只会报错的守卫」比没有守卫更糟：真问题会被淹在常红的噪声里。
 * 所以用它自己的正反例证明它能分辨对错：未打补丁必须红，打上必须绿，
 * 改回去必须重新红。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "verify-shell-defaults.mjs");

const SRC = process.argv[2];
if (!SRC) {
  console.error("用法：verify-shell-defaults-selftest.mjs <已构建的应用根目录（resources/app）>");
  console.error("需要真实产物：out/main.js、workbench.desktop.main.js、languagepack 模板与扩展");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-selftest-"));
const log = (s) => console.log(`[selftest] ${s}`);

fs.mkdirSync(path.join(tmp, "out", "vs", "workbench"), { recursive: true });
fs.mkdirSync(path.join(tmp, "extensions"), { recursive: true });

/* ---------- 复制必需文件 ---------- */
const need = ["out/main.js", path.join("out", "vs", "workbench", "workbench.desktop.main.js"), "novelpad-languagepack.json"];
for (const rel of need) {
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) {
    console.error(`缺少 ${rel}（先跑 embed-language-pack.mjs / 构建产物）`);
    process.exit(2);
  }
  const to = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
const lpSrc = path.join(SRC, "extensions", "vscode-language-pack-zh-hans");
if (fs.existsSync(lpSrc)) {
  fs.cpSync(lpSrc, path.join(tmp, "extensions", "vscode-language-pack-zh-hans"), { recursive: true });
}

const run = () => {
  try {
    const out = execFileSync(process.execPath, [script, tmp], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
};

/* ---------- 1. 未打补丁：必须红 ---------- */
const before = run();
const beforeFails = (before.out.match(/^FAIL/gm) ?? []).length;
console.log(`\n未打补丁：exit=${before.code} FAIL=${beforeFails} 项`);
// 不写死项数：判据会随需求增加（这次就从 3 项变 4 项）。
// 要守的是「至少三项核心缺失都被抓到」且 exit 非零。
const mustCatch = ["工作区信任默认关闭", "argv.json 默认 locale", "bootstrap"];
const caught = mustCatch.filter((k) => new RegExp(`FAIL\\s+${k}`).test(before.out));
const redOk = before.code !== 0 && beforeFails >= 3 && caught.length === mustCatch.length;
if (!redOk) {
  console.log("  未抓到的核心项：", mustCatch.filter((k) => !caught.includes(k)).join(", ") || "(无，但 exit/项数不对)");
}

/* ---------- 2. 打上补丁 ---------- */
const outMain = path.join(tmp, "out", "main.js");
let main = fs.readFileSync(outMain, "utf8");

// argv 模板：加一行 locale（产物里是字符串数组元素，含真制表符）
// 用 indexOf 定位真实行，避免转义层级写错（踩过一次：写成裸对象属性，
// 主进程 SyntaxError 直接崩）。
const argvLineStart = main.indexOf('"\t// Use software rendering instead of hardware accelerated rendering."');
if (argvLineStart < 0) {
  console.error("找不到 argv 模板锚点");
  process.exit(3);
}
const lineBegin = main.lastIndexOf("\n", argvLineStart) + 1;
const indent = main.slice(lineBegin, argvLineStart);
main = main.slice(0, lineBegin) + `${indent}"\\t\\"locale\\": \\"zh-cn\\",",\n${indent}"",\n` + main.slice(lineBegin);

// bootstrap：必须在 argvConfig 求值**之前**调用（那一行内部就读 argv.json）
const argvCall = "var argvConfig = configureCommandlineSwitchesSync(args);";
if (main.split(argvCall).length - 1 !== 1) {
  console.error("argvConfig 锚点不唯一");
  process.exit(3);
}
main = main.replace(
  argvCall,
  [
    "function ensureNovelPadBootstrapSync() {",
    "  var argvFile = getArgvConfigPath();",
    "  if (!fs.existsSync(argvFile)) { fs.writeFileSync(argvFile, '{\"locale\": \"zh-cn\"}'); }",
    "  var udp = getUserDataPath(args, product.nameShort || 'code-oss-dev');",
    "  var tpl = path.join(__dirname, '..', 'novelpad-languagepack.json');",
    "}",
    "ensureNovelPadBootstrapSync();",
    argvCall,
  ].join("\n"),
);
fs.writeFileSync(outMain, main, "utf8");

const wbPath = path.join(tmp, "out", "vs", "workbench", "workbench.desktop.main.js");
let wb = fs.readFileSync(wbPath, "utf8");
const trustUse = /(\[workspaceTrust_2\.\$9kb\]:\s*\{\s*type:\s*'boolean',\s*\n\s*)default:\s*true,/;
if (!trustUse.test(wb)) {
  console.error("找不到信任配置块（上游产物结构变了，自检需要更新）");
  process.exit(3);
}
wb = wb.replace(trustUse, "$1default: false,");
fs.writeFileSync(wbPath, wb, "utf8");
log("已模拟打上 3 处补丁");

/* ---------- 3. 打完：必须绿 ---------- */
const after = run();
console.log(`\n打完补丁：exit=${after.code}`);
console.log(after.out);
const greenOk = after.code === 0;

/* ---------- 4. 反向：信任改回 true，必须重新红 ---------- */
wb = wb.replace(/(\[workspaceTrust_2\.\$9kb\][\s\S]{0,400}?default:\s*)false,/, "$1true,");
fs.writeFileSync(wbPath, wb, "utf8");
const again = run();
const trustBackRed = /FAIL\s+工作区信任默认关闭/.test(again.out);

/* ---------- 汇总 ---------- */
console.log("=== 自检结果 ===");
const checks = [
  ["未打补丁时正确报红（3 项）", redOk],
  ["打上补丁后全绿", greenOk],
  ["信任改回 true 后立刻报红", trustBackRed],
];
let bad = 0;
for (const [n, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`);
  if (!ok) bad++;
}

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(bad ? 1 : 0);