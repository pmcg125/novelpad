#!/usr/bin/env node
/**
 * 对构建产物做「首启动」验收。
 *
 *   node shell/scripts/verify-first-run.mjs <应用根目录> [--expect zh-cn]
 *
 * `--expect zh-cn`：要求界面必须是中文（壳产物用）
 * 省略：只要求窗口能起来、扩展激活、主题生效（装到标准 VS Code 时用不上）
 *
 * ── 为什么必须真跑一次 ──
 *
 * 前面所有静态检查都只能证明「构建产物里包含这些默认值」。而用户看到的
 * 是运行结果，中间隔着三层容易静默失效的东西：
 *
 *   · bootstrap 执行了，但读的是别的路径（argv.json 不在 userData 下）
 *   · 语言包放进 extensions/ 了，但目录名和 manifest.name 不一致
 *   · 主题设置写了，但扩展压根没激活（受限模式能力没声明）
 *
 * 这三种都不会报错，界面只是「看起来没做」。只有真启动一次、读真实
 * 计算值才能确认。
 *
 * ── 为什么要用 CDP 而不是截图 ──
 *
 * 截屏拿到的是屏幕上最上层的窗口。CI 机器上可能什么都没有，开发机上
 * 终端会盖住应用。`Page.captureScreenshot` 截的是渲染器自己的画面，
 * 而且能顺手读到 `--vscode-*` 的计算值和 DOM 结构（比如居中版式那两个
 * margin），这些比「看起来对不对」可靠得多。
 *
 * ── 为什么用 http.request 而不是 fetch ──
 *
 * Node 的 fetch（undici）在慢启动场景下会假性报 `fetch failed` /
 * `ECONNREFUSED`，而同一端口用 http 请求是通的。踩过两次，都在
 * 「等待窗口起来」这种长时间轮询里。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { execFileSync } from "node:child_process";

/* ============================================================
 * 参数
 * ============================================================ */
const argv = process.argv.slice(2);
const appDir = argv.find((a) => !a.startsWith("--"));
const expectIdx = argv.indexOf("--expect");
const expectLocale = expectIdx >= 0 ? argv[expectIdx + 1] : null;
const portIdx = argv.indexOf("--port");
const PORT = portIdx >= 0 ? Number(argv[portIdx + 1]) : 9310;

if (!appDir) {
  console.error("用法：verify-first-run.mjs <应用根目录> [--expect zh-cn] [--port 9310]");
  process.exit(2);
}

const exe = path.join(path.dirname(path.dirname(appDir)), "NovelPad.exe");
const log = (s) => console.log(`[first-run] ${s}`);
const sleep = (ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* 同步等待：这个脚本不用 setTimeout，避免与轮询逻辑交错 */
  }
};

/* ============================================================
 * 前置：产物必须真的含补丁
 *
 * 这一步不能省。如果产物没打补丁，后面「界面不是中文」会被误判成
 * bootstrap 有问题，而实际问题在构建阶段。
 * ============================================================ */
const outMain = path.join(appDir, "out", "main.js");
const wbPath = path.join(appDir, "out", "vs", "workbench", "workbench.desktop.main.js");
if (!fs.existsSync(outMain)) {
  console.error(`找不到 ${outMain}`);
  process.exit(3);
}
if (!fs.existsSync(exe)) {
  console.error(`找不到 ${exe}`);
  process.exit(3);
}

const mainSrc = fs.readFileSync(outMain, "utf8");
// locale 在编译产物里是内层转义形态（"\\t\\"locale\\": \\"zh-cn\\","）
// 有的构建可能保留单引号形态，两种都认
const hasBootstrap = mainSrc.includes("ensureNovelPadBootstrapSync") || mainSrc.includes("ensureNovelPadLanguagePacksSync");
const hasLocaleTpl = /\\\\"locale\\\\":\s*\\\\"zh-cn\\\\"/.test(mainSrc) || mainSrc.includes('"locale": "zh-cn"');
let trustOff = true;
if (fs.existsSync(wbPath)) {
  const wbSrc = fs.readFileSync(wbPath, "utf8");
  // 找到配置块再看 default，不能只搜字符串（键名和 default 可能隔很远）
  const trustUse = /\[workspaceTrust_2\.\$9kb\]:\s*\{\s*type:\s*'boolean',\s*\n\s*default:\s*(false|true|!0|!1),/.exec(wbSrc);
  if (trustUse) trustOff = trustUse[1] === "false" || trustUse[1] === "!1";
}

log(`产物静态检查：bootstrap=${hasBootstrap} locale模板=${hasLocaleTpl} 信任关闭=${trustOff}`);
if (expectLocale && (!hasBootstrap || !hasLocaleTpl)) {
  console.error("产物里没有首启动补丁，运行验证没有意义（问题在构建阶段）");
  process.exit(4);
}

/* ============================================================
 * 模拟全新安装：删掉 argv.json + 全新 userData
 *
 * argv.json 在 homedir 下（不是 userData 里），补丁要能在它不存在时
 * 自己造出来。所以这里必须先删掉——不删等于跳过了最关键的一段。
 * ============================================================ */
const argvFile = path.join(os.homedir(), ".novelpad-ide", "argv.json");
const argvBackup = fs.existsSync(argvFile) ? fs.readFileSync(argvFile, "utf8") : null;
if (fs.existsSync(argvFile)) fs.rmSync(argvFile, { force: true });
log(`已删除 argv.json（${argvBackup === null ? "原本不存在" : "已备份"}）→ 模拟首次安装`);

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "np-firstrun-"));

/* 清场：Electron 单实例锁未释放时新进程会直接退出，
   表现为端口永远不开（看着像端口问题，实际是进程没起来） */
try {
  execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process -Name NovelPad -ErrorAction SilentlyContinue | Stop-Process -Force"], { stdio: "pipe" });
} catch {
  /* 没有进程 */
}
sleep(3000);

/* ============================================================
 * 启动
 *
 * ── 为什么用环境变量传参，而不是拼引号 ──
 *
 * 踩过两次，都是引号层级：
 *
 *   1. 单引号包参数：`-ArgumentList '--user-data-dir="C:\x"'`
 *      PowerShell 单引号内不解析，但引号会被算进值里，exe 拿到
 *      `"C:\x"`（带引号）→ userData 建到别处 → 后面查文件全找不到，
 *      看起来像「bootstrap 没跑」。
 *
 *   2. 双引号 + 反斜杠转义 `\"`：PowerShell 的转义符是**反引号**不是
 *      反斜杠，`\"` 会被解析成「反斜杠 + 字符串结束」，直接语法错。
 *
 * 两轮都栽在这上面，说明「在 JS 字符串里拼 PowerShell 引号」这条路本身
 * 不可靠。改成：把路径放进环境变量，PowerShell 里用 `$env:NP_UD` 引用。
 * 环境变量不经过 shell 解析，路径里有空格、引号、中文都不会坏。
 *
 * 另外 `-ArgumentList @(...)` 在这个上下文里也踩过（Start-Process 报
 * 「找不到位置参数」），所以改成先把参数拼成一个字符串再传。
 * ============================================================ */
const workDir = process.env.NP_WORKSPACE || "";
const startedAt = Date.now();

const env = {
  ...process.env,
  NP_EXE: exe,
  NP_UD: userData,
  NP_PORT: String(PORT),
  NP_WORKDIR: workDir,
};

// 拼成单个字符串给 -ArgumentList。PowerShell 里用单引号包住每个片段，
// 变量在字符串拼接处展开——这样路径里的空格不会被当成参数分隔符。
const psScript = [
  "$parts = @()",
  workDir ? '  $parts += \'"\' + $env:NP_WORKDIR + \'"\'' : "",
  '  $parts += \'"--user-data-dir=\' + $env:NP_UD + \'"\'',
  '  $parts += \'"--remote-debugging-port=\' + $env:NP_PORT + \'"\'',
  '  $parts += \'"--skip-welcome"\'',
  '  $parts += \'"--skip-release-notes"\'',
  "Start-Process -FilePath $env:NP_EXE -ArgumentList ($parts -join ' ')",
]
  .filter(Boolean)
  .join("\n");

execFileSync("powershell", ["-NoProfile", "-Command", psScript], { env });

/* ============================================================
 * 等窗口：轮询到真能连上，而不是睡固定秒数
 * ============================================================ */
const httpJson = (p) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "GET", timeout: 3000 }, (res) => {
      let b = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (b += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(b));
        } catch {
          reject(new Error("非 JSON 响应"));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });

let page = null;
while (Date.now() - startedAt < 90000) {
  try {
    const list = await httpJson("/json/list");
    page = list.find((t) => t.type === "page" && /workbench/i.test(t.url)) ?? null;
    if (page) break;
  } catch {
    /* 端口还没开 */
  }
  sleep(2000);
}
log(`窗口就绪=${!!page}  耗时 ${Math.round((Date.now() - startedAt) / 1000)}s`);
if (page) {
  // 端口开时界面往往还在挂载（扩展激活 + 居中版式重排），再等一会
  sleep(14000);
}

/* ============================================================
 * 文件层证据
 * ============================================================ */
const argvOk = fs.existsSync(argvFile) && /"locale"\s*:\s*"zh-cn"/.test(fs.readFileSync(argvFile, "utf8"));
const lpExists = fs.existsSync(path.join(userData, "languagepacks.json"));
const clpExists = fs.existsSync(path.join(userData, "clp"));

let activated = false;
const logsDir = path.join(userData, "logs");
if (fs.existsSync(logsDir)) {
  for (const f of fs.readdirSync(logsDir, { recursive: true })) {
    if (!String(f).endsWith("exthost.log")) continue;
    if (/_doActivateExtension\s+novelpad\.novelpad/.test(fs.readFileSync(path.join(logsDir, String(f)), "utf8"))) {
      activated = true;
    }
  }
}

/* ============================================================
 * 界面层证据
 * ============================================================ */
let info = null;
let shot = null;
if (page) {
  try {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((res) => {
        const i = ++id;
        pending.set(i, res);
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    await new Promise((r) => ws.addEventListener("open", r));
    await send("Runtime.enable");
    await send("Page.enable");

    // 注意：主题变量挂在 .monaco-workbench 上，不是 documentElement。
    // 读 :root 会拿到空字符串，看起来像「主题没生效」。
    const probe = [
      "(() => {",
      "  const wb = document.querySelector('.monaco-workbench');",
      "  const cs = wb ? getComputedStyle(wb) : null;",
      "  const text = document.body.innerText || '';",
      "  return {",
      "    lang: document.documentElement.lang,",
      "    menus: [...document.querySelectorAll('.menubar-menu-button')].map(e => e.textContent.trim()).filter(Boolean),",
      "    workbenchClass: wb ? wb.className : null,",
      "    editorBg: cs ? cs.getPropertyValue('--vscode-editor-background').trim() : null,",
      "    margins: document.querySelectorAll('.centered-layout-margin').length,",
      "    hasTrustText: /trust the authors|信任这些文件的作者/i.test(text),",
      "    hasRestricted: /Restricted Mode|受限模式/i.test(text),",
      "    title: document.title,",
      "  };",
      "})()",
    ].join("\n");
    const r = await send("Runtime.evaluate", { expression: probe, returnByValue: true });
    info = r.result?.result?.value ?? null;

    const s = await send("Page.captureScreenshot", { format: "png" });
    if (s.result?.data) shot = Buffer.from(s.result.data, "base64");
    ws.close();
  } catch (e) {
    log(`CDP 读取失败：${e.message}`);
  }
}

console.log("\n=== 运行时证据 ===");
console.log(JSON.stringify({ argvOk, lpExists, clpExists, activated, ...info }, null, 2));

if (shot) {
  const shotPath = path.join(os.tmpdir(), "novelpad-first-run.png");
  fs.writeFileSync(shotPath, shot);
  log(`截图 ${shotPath}`);
}

/* ============================================================
 * 判定
 * ============================================================ */
const zh = (info?.menus ?? []).filter((m) => /[\u4e00-\u9fa5]/.test(m));
const checks = [["窗口启动（主进程没崩）", !!page], ["扩展已激活", activated]];

if (expectLocale) {
  checks.push(
    ["argv.json 生成且 locale=zh-cn", argvOk],
    ["languagepacks.json 生成", lpExists],
    ["clp 缓存生成（真读了翻译）", clpExists],
    [
      `界面语言 = ${expectLocale}`,
      (info?.lang ?? "en") !== "en" && zh.length >= 5,
      `lang=${info?.lang}  中文菜单 ${zh.length}/${(info?.menus ?? []).length}`,
    ],
  );
}

checks.push(
  ["无信任对话框", info?.hasTrustText === false],
  ["无受限模式横幅", info?.hasRestricted === false],
  ["主题生效（非默认深色）", /novelpad-novelpad-themes/i.test(info?.workbenchClass ?? ""), info?.editorBg ?? ""],
  ["正文栏宽生效（2 个 margin）", (info?.margins ?? 0) === 2, `${info?.margins ?? 0} 个`],
);

console.log("\n=== 判定 ===");
let bad = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) bad++;
}

/* ============================================================
 * 收尾：还原 argv.json，杀掉进程
 * ============================================================ */
try {
  execFileSync("powershell", ["-NoProfile", "-Command", "Get-Process -Name NovelPad -ErrorAction SilentlyContinue | Stop-Process -Force"], { stdio: "pipe" });
} catch {
  /* 已退出 */
}
if (argvBackup === null) fs.rmSync(argvFile, { force: true });
else fs.writeFileSync(argvFile, argvBackup, "utf8");
log(`已还原 argv.json；用户目录保留 ${userData}（排查用）`);

process.exit(bad ? 1 : 0);