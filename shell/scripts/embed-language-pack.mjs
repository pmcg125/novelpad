#!/usr/bin/env node
/**
 * 把中文语言包做成壳的内置扩展，并预置 languagepacks.json。
 *
 *   node shell/scripts/embed-language-pack.mjs <built-app-dir> [--locale zh-cn]
 *
 * ── 为什么必须预置 languagepacks.json ──
 *
 * 语言包随包发布只是第一步。实测（真机跑 NovelPad.exe）：
 *
 *   第 1 次启动 --locale=zh-cn → 界面全英文
 *   第 2 次启动 --locale=zh-cn → 界面全中文
 *
 * 因为 `src/main.js` 在 app ready 之前就调用 getNLSConfiguration()，
 * 它读的是 `<userData>/languagepacks.json`；而那个文件由工作台启动后的
 * `LanguagePacksCache` 扫描扩展目录才写出来。也就是说首启动时文件不存在
 * → 读不到语言包 → 英文；第二次启动才读到上一轮写下的内容。
 *
 * 「装完打开是英文，关掉再开才中文」对成品软件不可接受，所以这里在
 * 安装包里就把语言包目录写进 extensions/，并预置一份 languagepacks.json。
 * 但那文件在 userData 下（首启动才被创建），我们没法预置用户目录，
 * 于是改为在**壳源码**里补一个 bootstrap：见 003 补丁与 build 时的
 * generated/localization.contribution.ts。这里只负责：
 *
 *   1. 解压 vsix → extensions/vscode-language-pack-zh-hans
 *   2. 生成 languagepacks.json 的**内容模板**（路径占位替换在运行时做）
 *      放进 resources/app/novelpad-languagepack.json，供壳首启动时读取
 *   3. 校验产物清单
 *
 * ── 为什么不直接拷贝我们手工造的那份 ──
 *
 * 那份里的 translations 全是**绝对路径**。用户把 NovelPad 装到别的盘
 * 就全失效（而且不报错，只是变英文）。所以模板里必须用相对 app 根的
 * 路径，运行时再拼绝对路径。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { extractZip } from "./lib/zip.mjs";
import { validateExtensionManifest } from "./lib/manifest.mjs";

const args = process.argv.slice(2);
const appDir = args[0];
const localeArg = args.indexOf("--locale");
const locale = localeArg >= 0 ? args[localeArg + 1] : "zh-cn";
const vsix = args.find((a) => a.endsWith(".vsix")) ?? path.join(path.dirname(path.dirname(appDir)), "language-pack.vsix");

if (!appDir) {
  console.error("用法：embed-language-pack.mjs <resources/app 目录> <language-pack.vsix> [--locale zh-cn]");
  process.exit(2);
}

const log = (s) => console.log(`[langpack] ${s}`);
if (!fs.existsSync(vsix)) {
  console.error(`找不到语言包 vsix：${vsix}`);
  process.exit(2);
}

/* ---------- 1. 解压到 extensions/ ---------- */
const tmp = path.join(path.dirname(path.resolve(vsix)), ".langpack-extract");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const { files } = extractZip(path.resolve(vsix), tmp);
const inner = path.join(tmp, "extension");
if (!fs.existsSync(inner)) {
  console.error(`语言包 vsix 里没有 extension/：${tmp}`);
  process.exit(3);
}

const manifestPath = path.join(inner, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
// 语言包是纯声明式扩展（没有 main），validateExtensionManifest 对此已放行
const problems = validateExtensionManifest(inner);
if (problems.length) {
  console.error(`语言包 package.json 有问题：\n  ${problems.join("\n  ")}`);
  process.exit(4);
}
const localizations = manifest.contributes?.localizations ?? [];
const pack = localizations.find((l) => l.languageId === locale);
if (!pack) {
  console.error(`语言包里没有 ${locale}（有：${localizations.map((l) => l.languageId).join(", ")}）`);
  process.exit(5);
}

// 目录名必须是 manifest.name，不是 `<publisher>.<name>`。
// 内置扩展（extensions/ 下）靠目录名与 manifest.name 对应，写成带 publisher
// 的形式会让扫描器把它当成另一个扩展，语言包静默不生效——界面仍是英文。
const dirName = manifest.name;
const dest = path.join(appDir, "extensions", dirName);
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
fs.cpSync(inner, dest, { recursive: true });
fs.rmSync(tmp, { recursive: true, force: true });
log(`扩展已放入 extensions/${dirName}`);

/* ---------- 2. 生成 languagepacks 模板（路径相对 app 根） ---------- */
const translations = {};
for (const t of pack.translations) {
  // pack.translations[].path 形如 "./translations/main.i18n.json"
  const rel = t.path.replace(/^\.\//, "");
  const abs = path.join(dest, rel);
  if (!fs.existsSync(abs)) {
    console.error(`翻译文件缺失：${rel}`);
    process.exit(6);
  }
  // 存「相对 app 根」的路径，运行时再补前缀。写绝对路径的话，
  // 用户把软件装到别的盘就全失效（而且只是静默变英文）。
  translations[t.id] = `extensions/${dirName}/${rel.replace(/\\/g, "/")}`;
}

// hash 必须与上游 LanguagePacksCache.updateHash 一致：
//   md5( extensionIdentifier.uuid || id  +  version )
// 不一致会导致主进程认为语言包变了，重新走一遍缓存目录（多一次磁盘写，
// 而且缓存键变化会让已解压的 clp 目录失效）。
const md5 = crypto.createHash("md5");
md5.update(`${manifest.publisher}.${manifest.name}`.toLowerCase());
md5.update(manifest.version);
const hash = md5.digest("hex");

const template = {
  [locale]: {
    hash,
    extensions: [
      {
        extensionIdentifier: { id: `${manifest.publisher}.${manifest.name}`.toLowerCase() },
        version: manifest.version,
      },
    ],
    translations,
    label: pack.localizedLanguageName ?? pack.languageName,
  },
};

const templatePath = path.join(appDir, "novelpad-languagepack.json");
fs.writeFileSync(templatePath, JSON.stringify(template, null, 2) + "\n", "utf8");
log(`模板写入 ${path.relative(appDir, templatePath)}（${Object.keys(translations).length} 个翻译文件）`);

/* ---------- 3. 自检：每个路径都要真能取到 ---------- */
let missing = 0;
for (const [id, rel] of Object.entries(translations)) {
  if (!fs.existsSync(path.join(appDir, rel))) {
    console.error(`  ✗ ${id}: ${rel}`);
    missing++;
  }
}
if (missing) {
  console.error(`模板里有 ${missing} 个路径取不到`);
  process.exit(7);
}
log(`全部 ${Object.keys(translations).length} 个路径在 app 根下可解析`);
log(`完成：${locale} → ${dirName} ${manifest.version}`);