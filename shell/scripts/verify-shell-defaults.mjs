#!/usr/bin/env node
/**
 * 校验壳的「首启动默认值」三件事是否都落到了产物里。
 *
 *   node shell/scripts/verify-shell-defaults.mjs <解压后的应用根目录>
 *
 * 三件都只能靠「真跑一次」发现，静态看文件都正常：
 *
 *   1. 信任机制默认关闭
 *      静态：product.json/settings 里看不出默认值来自源码。
 *      症状：新用户打开作品先看到一个安全警告；不点「信任」扩展完全不激活
 *            ——主题、书房、侧栏都没有，git 也被禁用。
 *      判据：out/main.js 里 `getWorkspaceTrustEnabled` 的配置默认值是
 *            false（构建产物里是 `default:!1` 的压缩形式，改按语义探针）。
 *
 *   2. argv.json 默认 locale = zh-cn
 *      静态：只有真的生成过一次 argv.json 才看得到。
 *      判据：out/main.js 的默认模板数组里含 `"locale": "zh-cn"`。
 *
 *   3. 首启动补齐 languagepacks.json
 *      静态：文件由工作台写，首启动时还不存在。
 *      判据：out/main.js 含 bootstrap 函数；模板文件
 *            resources/app/novelpad-languagepack.json 存在且路径可解析；
 *            语言包扩展目录在 extensions/ 下。
 *
 * 为什么不在这脚本里真启动窗口：CI 里没有桌面会话（Windows runner 有，
 * 但要等窗口就绪、抓 CDP，脆且慢）。启动验证在本地做过（见 commit 说明），
 * CI 守住「构建产物里包含这些默认值」这一层。
 */
import fs from "node:fs";
import path from "node:path";

const appDir = process.argv[2];
if (!appDir) {
  console.error("用法：verify-shell-defaults.mjs <应用根目录>");
  process.exit(2);
}

const log = (s) => console.log(`[defaults] ${s}`);
let bad = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "OK  " : "FAIL"}  ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) bad++;
};

/* ---------- 读产物 ---------- */
const outMain = path.join(appDir, "out", "main.js");
if (!fs.existsSync(outMain)) {
  console.error(`找不到 ${outMain}`);
  process.exit(2);
}
const main = fs.readFileSync(outMain, "utf8");
// 工作台那半在 out/vs/workbench/workbench.desktop.main.js
const wb = path.join(appDir, "out", "vs", "workbench", "workbench.desktop.main.js");
const wbSrc = fs.existsSync(wb) ? fs.readFileSync(wb, "utf8") : "";

/* ---------- 1. 信任机制默认关闭 ---------- */
// 产物里这个配置键是以常量形式引用的：
//   [workspaceTrust_2.$9kb]: { type: 'boolean', default: true, ... }
// 而 $9kb = 'security.workspace.trust.enabled'。所以要先找到常量名，
// 再用「[模块.常量]: { ... default: X ... }」这种结构定位。
// 直接搜键名字符串是错的：它只出现在常量定义处，离 default 有 1000 多公里。
const trustConst = /exports\.\$(\w+)\s*=\s*'security\.workspace\.trust\.enabled'/.exec(wbSrc);
let trustOff = false;
let trustDetail = "找不到 security.workspace.trust.enabled 的常量定义";
if (trustConst) {
  const name = `$${trustConst[1]}`;
  // 用法形如 [workspaceTrust_2.$9kb]: {
  const useRe = new RegExp(`\\[\\w+\\.\\${name.replace("$", "$")}\\]\\s*:\\s*\\{`, "g");
  const use = useRe.exec(wbSrc);
  if (use) {
    const block = wbSrc.slice(use.index, use.index + 600);
    const m = /default\s*:\s*(!0|!1|true|false)/.exec(block);
    if (m) {
      const raw = m[1];
      trustOff = raw === "false" || raw === "!1";
      trustDetail = `default 解析为 ${raw}（${trustOff ? "关闭" : "开启"}）`;
    } else {
      trustDetail = "配置块里找不到 default";
    }
  } else {
    trustDetail = `找不到 ${name} 的配置用法`;
  }
}
check("工作区信任默认关闭", trustOff, trustDetail);

/* ---------- 2. argv.json 默认 locale ---------- */
const hasLocale = main.includes('"locale": "zh-cn"') || main.includes("'locale': 'zh-cn'") || /locale["']?\s*:\s*["']zh-cn["']/.test(main);
check("argv.json 默认 locale = zh-cn", hasLocale, "out/main.js 的默认模板里没有 locale");

/* ---------- 3. 首启动补齐 argv.json 与 languagepacks.json ---------- */
// 函数名可能随重构变化，所以判据看「行为」而不是具体名字：
//   既要补 argv.json（getArgvConfigPath），也要补 languagepacks.json（模板引用）。
const hasBootstrap =
  (main.includes("ensureNovelPadBootstrapSync") || main.includes("ensureNovelPadLanguagePacksSync")) &&
  main.includes("getArgvConfigPath") &&
  main.includes("novelpad-languagepack.json");
check(
  "bootstrap 已编入 out/main.js（argv.json + languagepacks.json）",
  hasBootstrap,
  "找不到 bootstrap 函数或模板引用",
);

// 时序同样要守：必须早于 argv.json 的第一次读取（configureCommandlineSwitchesSync）
const bootAt = Math.max(main.indexOf("ensureNovelPadBootstrapSync();"), main.indexOf("ensureNovelPadLanguagePacksSync();"));
const argvAt = main.indexOf("configureCommandlineSwitchesSync(args)");
check(
  "bootstrap 早于 argv.json 读取",
  bootAt > 0 && argvAt > 0 && bootAt < argvAt,
  bootAt < 0 ? "找不到 bootstrap 调用" : argvAt < 0 ? "找不到 argvConfig 求值" : `bootstrap@${bootAt} argvConfig@${argvAt}`,
);

const tpl = path.join(appDir, "novelpad-languagepack.json");
let tplOk = false;
let tplDetail = "模板文件不存在";
if (fs.existsSync(tpl)) {
  try {
    const j = JSON.parse(fs.readFileSync(tpl, "utf8"));
    const locales = Object.keys(j);
    const first = j[locales[0]];
    const paths = Object.values(first?.translations ?? {});
    const missing = paths.filter((p) => !fs.existsSync(path.join(appDir, p)));
    tplOk = locales.length > 0 && paths.length > 0 && missing.length === 0;
    tplDetail = `${locales.join(",")} / ${paths.length} 个翻译，缺 ${missing.length} 个`;
  } catch (e) {
    tplDetail = `模板不是合法 JSON：${e.message}`;
  }
}
check("languagepack 模板完整", tplOk, tplDetail);

// 扩展目录：目录名必须是 manifest.name（写成 <publisher>.<name> 会静默失效）
const extBase = path.join(appDir, "extensions");
let extOk = false;
let extDetail = "extensions/ 下没有语言包目录";
if (fs.existsSync(extBase)) {
  const cands = fs.readdirSync(extBase).filter((d) => /language-pack/.test(d));
  for (const d of cands) {
    const pkg = path.join(extBase, d, "package.json");
    if (!fs.existsSync(pkg)) continue;
    try {
      const p = JSON.parse(fs.readFileSync(pkg, "utf8"));
      const hasZh = (p.contributes?.localizations ?? []).some((l) => l.languageId === "zh-cn");
      // 目录名必须等于 manifest.name
      if (hasZh && p.name === d) {
        extOk = true;
        extDetail = `${d} ${p.version}`;
      } else if (hasZh) {
        extDetail = `目录名 ${d} 与 manifest.name ${p.name} 不一致（会静默不生效）`;
      }
    } catch (e) {
      extDetail = `${d}: package.json 解析失败 ${e.message}`;
    }
  }
}
check("语言包扩展已内置", extOk, extDetail);

/* ---------- 汇总 ---------- */
console.log("");
if (bad) {
  console.error(`壳默认值检查失败 ${bad} 项。`);
  console.error("这些问题在界面上都只表现为「好像没做」，没有任何报错。");
  process.exit(1);
}
log("全部通过（信任关闭 / 默认中文 / 语言包内置）");