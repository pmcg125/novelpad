#!/usr/bin/env node
/**
 * 下载中文语言包 vsix 并校验 sha256。
 *
 *   node shell/scripts/fetch-language-pack.mjs <输出目录>
 *
 * ── 为什么必须校验哈希 ──
 *
 * 语言包是第三方产物（MS-CEINTL 发布，但落在地三方市场 Open VSX 上）。
 * 不校验就等于每次构建都把「上次下载到的东西」塞进安装包——中间任何一个
 * 环节被换掉，用户拿到的壳里就会有一份我们没审过的翻译文件，而界面
 * 看起来完全正常。哈希写死在脚本里，改版本必须同时改这两处。
 *
 * ── 为什么不用 `code --install-extension` ──
 *
 * 那是装到用户目录，不是打进安装包。这里要的是「随包发布的扩展目录」，
 * 由 build/lib/extensions.js 的 packageLocalExtensionsStream 处理
 * extensions/* 下的内容 —— 但语言包不在上游源码里，所以走
 * embed-language-pack.mjs 直接塞进 resources/app/extensions。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 必须与 shell/UPSTREAM 的版本一致：语言包的翻译键是按版本生成的 */
const VERSION = "1.85.0";
const PUBLISHER = "MS-CEINTL";
const NAME = "vscode-language-pack-zh-hans";

/**
 * sha256 从 Open VSX 的 .sha256 端点取，写死在这里。
 * 换版本时必须重取——不要「暂时留空让它过」。
 */
const SHA256 = "88b840f2d0d482329bafaf1bc4fbb9f61a65eb68d942efd58ef9f66928b06c2d";

const URL_ = `https://open-vsx.org/api/${PUBLISHER}/${NAME}/${VERSION}/file/${PUBLISHER}.${NAME}-${VERSION}.vsix`;
const outDir = process.argv[2];
if (!outDir) {
  console.error("用法：fetch-language-pack.mjs <输出目录>");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, `${NAME}-${VERSION}.vsix`);

const log = (s) => console.log(`[langpack] ${s}`);

async function download(url) {
  // 带重试：Open VSX 偶发 5xx，构建不该因此失败一次
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error("空响应");
      return buf;
    } catch (e) {
      lastError = e;
      log(`第 ${attempt} 次下载失败：${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  throw lastError;
}

if (fs.existsSync(dest)) {
  const have = crypto.createHash("sha256").update(fs.readFileSync(dest)).digest("hex");
  if (have === SHA256) {
    log(`已存在且哈希匹配，跳过下载：${dest}`);
    process.exit(0);
  }
  log(`已存在的文件哈希不匹配，重新下载`);
  fs.rmSync(dest, { force: true });
}

log(`下载 ${URL_}`);
const buf = await download(URL_);
const actual = crypto.createHash("sha256").update(buf).digest("hex");
if (actual !== SHA256) {
  console.error(`\n哈希不匹配！\n  期望 ${SHA256}\n  实际 ${actual}\n`);
  console.error("语言包内容变了。如果是上游重新发布，确认无误后更新脚本里的 SHA256；");
  console.error("否则不要继续构建——用户会拿到一份没审过的翻译。");
  process.exit(3);
}

fs.writeFileSync(dest, buf);
log(`OK  ${dest}（${(buf.length / 1024).toFixed(0)} KB，sha256 匹配）`);