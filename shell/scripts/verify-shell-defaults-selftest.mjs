#!/usr/bin/env node
/**
 * `verify-shell-defaults.mjs` 的判据自检。
 *
 *   node shell/scripts/verify-shell-defaults-selftest.mjs
 *
 * ── 为什么不读真实产物 ──
 *
 * 第一版拿「构建产物」当夹具，在 CI 里必然失败：CI 产物是
 * `apply.mjs` 改源码 → gulp 编译出来的，**本身就是打过补丁的**。
 * 于是「未打补丁必须红」这一条前提不成立，脚本红得莫名其妙。
 *
 * 想靠「从产物里把补丁剥掉」来造基线也太脆：补丁内容会变、压缩后
 * 形态会变，剥不干净就变成假的绿或假的红。
 *
 * 改成**自己合成最小夹具**：几个几十行的假文件，分别覆盖
 * 「有/没有」每种特征。判据只看这几处文本，合成样本足够，而且完全
 * 确定——不受构建产物影响，也就不会因为上游改版而莫名其妙飘。
 *
 * ── 自检要证明什么 ──
 *
 *   1. 三项核心缺失都在时，必须红且逐项点名
 *   2. 补上之后必须绿
 *   3. 把任意一项改回坏值，必须重新红（逐项）
 *   4. 语言包模板用绝对路径时，必须红（这条最容易漏——它不报错，
 *      只在用户换盘安装后静默变英文）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "verify-shell-defaults.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-defaults-"));
const log = (s) => console.log(`[selftest] ${s}`);

/* ============================================================
 * 合成一个「最小可判定」的应用根
 *
 * 结构与真实产物一致：
 *   <app>/out/main.js                        ← 检查 locale / bootstrap
 *   <app>/out/vs/workbench/workbench.desktop.main.js   ← 检查信任开关
 *   <app>/novelpad-languagepack.json         ← 检查模板
 *   <app>/extensions/vscode-language-pack-zh-hans/package.json
 *   <app>/extensions/vscode-language-pack-zh-hans/translations/main.i18n.json
 * ============================================================ */

const FILE = {
  /**
   * 未打补丁的 main.js：有 argv 模板、没有 locale、没有 bootstrap。
   *
   * 注意 argv 那一行的转义层级——这是真产物（esbuild 输出）的形态：
   *   `  "\t// Use software..."`   ← 双引号 + **真制表符**
   * 而不是源码里的 `'\t// Use...'`（单引号 + 字面反斜杠 t）。
   * 第一版夹具写成单引号形态，导致「打上补丁」的替换没命中，
   * 自检反而报了个假红。夹具必须与真产物一致才有判定力。
   */
  mainClean: [
    "var args = parseCLIArgs();",
    "var argvConfig = configureCommandlineSwitchesSync(args);",
    "function createDefaultArgvConfigSync(p) {",
    "  const defaultArgvConfigContent = [",
    '    "// comment",',
    '    "{",',
    '    "\t// Use software rendering instead of hardware accelerated rendering.",',
    '    "}"',
    "  ];",
    "}",
    "function getUserDefinedLocale(c) { return c.locale; }",
    "var locale = getUserDefinedLocale(argvConfig);",
  ].join("\n"),

  /** 未打补丁的 workbench：信任默认 true + 默认主题是蓝色 */
  wbClean: [
    "exports.$9kb = 'security.workspace.trust.enabled';",
    "platform_1.$tn.as(configurationRegistry_1.$yn.Configuration).registerConfiguration({",
    "  properties: {",
    "    [workspaceTrust_2.$9kb]: {",
    "      type: 'boolean',",
    "      default: true,",
    "      description: 'x',",
    "    },",
    "    [workspaceTrust_2.$alb]: {",
    "      type: 'boolean',",
    "      default: true,",
    "    },",
    "  }",
    "});",
    "var ThemeSettingDefaults;",
    '(function (ThemeSettingDefaults) {',
    '    ThemeSettingDefaults["COLOR_THEME_DARK"] = "Default Dark Modern";',
    '    ThemeSettingDefaults["COLOR_THEME_LIGHT"] = "Default Light Modern";',
    '    ThemeSettingDefaults["COLOR_THEME_HC_DARK"] = "Default High Contrast";',
    '    ThemeSettingDefaults["COLOR_THEME_HC_LIGHT"] = "Default High Contrast Light";',
    "})(ThemeSettingDefaults || (exports.ThemeSettingDefaults = ThemeSettingDefaults = {}));",
  ].join("\n"),
};

/** 造模板：relative=true 用相对路径，false 用绝对路径（应当被判红） */
function template(opts = {}) {
  const { relative = true, count = 88 } = opts;
  const translations = {};
  for (let i = 0; i < count; i++) {
    const key = i === 0 ? "vscode" : `vscode.k${i}`;
    translations[key] = relative
      ? `extensions/vscode-language-pack-zh-hans/translations/${i === 0 ? "main" : `k${i}`}.i18n.json`
      : `/opt/app/extensions/vscode-language-pack-zh-hans/translations/${i === 0 ? "main" : `k${i}`}.i18n.json`;
  }
  return JSON.stringify(
    {
      "zh-cn": {
        hash: "a".repeat(32),
        extensions: [{ extensionIdentifier: { id: "ms-ceintl.vscode-language-pack-zh-hans" }, version: "1.85.0" }],
        translations,
        label: "中文(简体)",
      },
    },
    null,
    2,
  );
}

/** 建一个应用根；overrides 里可替换任意文件内容 */
function makeApp(opts = {}) {
  const root = fs.mkdtempSync(path.join(tmp, "app-"));
  const dirs = [
    "out/vs/workbench",
    "extensions/vscode-language-pack-zh-hans/translations",
  ];
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });

  fs.writeFileSync(path.join(root, "out/main.js"), opts.main ?? FILE.mainClean, "utf8");
  fs.writeFileSync(path.join(root, "out/vs/workbench/workbench.desktop.main.js"), opts.wb ?? FILE.wbClean, "utf8");

  const tpl = opts.template ?? template();
  fs.writeFileSync(path.join(root, "novelpad-languagepack.json"), tpl, "utf8");

  // 模板里每条路径都要真实存在，否则「模板完整」那项会红
  let parsed;
  try {
    parsed = JSON.parse(tpl);
  } catch {
    parsed = null;
  }
  if (opts.createFiles !== false && parsed) {
    for (const p of Object.values(parsed["zh-cn"]?.translations ?? {})) {
      if (String(p).startsWith("/")) continue; // 绝对路径故意不建，验证「换盘失效」能被抓到
      const full = path.join(root, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, "{}", "utf8");
    }
  }

  // 语言包扩展：目录名必须等于 manifest.name
  const extName = opts.extDirName ?? "vscode-language-pack-zh-hans";
  const extDir = path.join(root, "extensions", extName);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, "package.json"),
    JSON.stringify(
      {
        name: opts.extManifestName ?? "vscode-language-pack-zh-hans",
        publisher: "MS-CEINTL",
        version: "1.85.0",
        contributes: { localizations: [{ languageId: "zh-cn", languageName: "Chinese" }] },
      },
      null,
      2,
    ),
    "utf8",
  );

  return root;
}

function run(appDir) {
  try {
    const out = execFileSync(process.execPath, [script, appDir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const fails = (out) => (out.match(/^FAIL/gm) ?? []).length;
const hasFail = (out, key) => new RegExp(`FAIL\\s+${key}`).test(out);

/* ============================================================
 * 夹具：一个「全部打对」的应用根
 * ============================================================ */

/* ============================================================
 * 夹具：「全部打对」的应用根
 *
 * 直接构造正确形态，不做「先插再重排」那种绕的变换——变换本身也容易写错，
 * 而这里要验的恰恰是判据，不是变换技巧。
 * ============================================================ */

/** 打过补丁的 main.js：locale 进模板 + bootstrap 早于 argvConfig */
const patchedMainCorrect = [
  "var args = parseCLIArgs();",
  // 正确时序：bootstrap 先跑
  "ensureNovelPadBootstrapSync();",
  "var argvConfig = configureCommandlineSwitchesSync(args);",
  "function ensureNovelPadBootstrapSync() {",
  "  var argvFile = getArgvConfigPath();",
  "  var udp = getUserDataPath(args, product.nameShort);",
  "  var tpl = path.join(__dirname, '..', 'novelpad-languagepack.json');",
  "}",
  "function createDefaultArgvConfigSync(p) {",
  "  const defaultArgvConfigContent = [",
  '    "// comment",',
  '    "{",',
  // 编译产物形态：内层引号被转义
  '    "\\t\\"locale\\": \\"zh-cn\\",",',
  '    "",',
  '    "\t// Use software rendering instead of hardware accelerated rendering.",',
  '    "}"',
  "  ];",
  "}",
  "function getUserDefinedLocale(c) { return c.locale; }",
  "var locale = getUserDefinedLocale(argvConfig);",
].join("\n");

const patchedWb = FILE.wbClean
  .replace(
    "      type: 'boolean',\n      default: true,\n      description: 'x',",
    "      type: 'boolean',\n      default: false,\n      description: 'x',",
  )
  .replace('ThemeSettingDefaults["COLOR_THEME_DARK"] = "Default Dark Modern";', 'ThemeSettingDefaults["COLOR_THEME_DARK"] = "夜墨 · NovelPad Ink";')
  .replace('ThemeSettingDefaults["COLOR_THEME_LIGHT"] = "Default Light Modern";', 'ThemeSettingDefaults["COLOR_THEME_LIGHT"] = "宣纸 · NovelPad Paper";');

const cases = [];

/* ---------- 1. 干净基线：必须红，且逐项点名 ---------- */
{
  const app = makeApp({ main: FILE.mainClean, wb: FILE.wbClean });
  const r = run(app);
  const caughtAll =
    hasFail(r.out, "工作区信任默认关闭") && hasFail(r.out, "argv.json 默认 locale") && hasFail(r.out, "bootstrap");
  cases.push({
    name: "干净基线（三项都缺）→ 红且逐项点名",
    ok: r.code !== 0 && fails(r.out) >= 3 && caughtAll,
    out: r.out,
  });
}

/* ---------- 2. 全部打对：必须绿 ---------- */
{
  const app = makeApp({ main: patchedMainCorrect, wb: patchedWb });
  const r = run(app);
  cases.push({ name: "三项都打对 → 绿", ok: r.code === 0, out: r.out });
}

/* ---------- 3. 逐项改回坏值，必须重新红 ---------- */
{
  const app = makeApp({ main: FILE.mainClean, wb: patchedWb });
  const r = run(app);
  cases.push({ name: "只缺 locale + bootstrap → 红", ok: r.code !== 0 && hasFail(r.out, "argv.json 默认 locale"), out: r.out });
}
{
  const app = makeApp({ main: patchedMainCorrect, wb: FILE.wbClean });
  const r = run(app);
  cases.push({ name: "只把信任改回 true → 红", ok: r.code !== 0 && hasFail(r.out, "工作区信任默认关闭"), out: r.out });
}

/* ---------- 4. bootstrap 时序错（晚于 argvConfig）：必须红 ---------- */
{
  // 把调用挪到 argvConfig 之后
  const wrongOrder = patchedMainCorrect.replace(
    "ensureNovelPadBootstrapSync();\nvar argvConfig = configureCommandlineSwitchesSync(args);",
    "var argvConfig = configureCommandlineSwitchesSync(args);\nensureNovelPadBootstrapSync();",
  );
  const app = makeApp({ main: wrongOrder, wb: patchedWb });
  const r = run(app);
  cases.push({ name: "bootstrap 晚于 argvConfig → 红", ok: r.code !== 0 && hasFail(r.out, "bootstrap 早于"), out: r.out });
}

/* ---------- 5. 模板用绝对路径：必须红（换盘失效，且不报错） ---------- */
{
  const app = makeApp({ main: patchedMainCorrect, wb: patchedWb, template: template({ relative: false }) });
  const r = run(app);
  cases.push({ name: "模板用绝对路径 → 红（换盘静默失效）", ok: r.code !== 0, out: r.out });
}

/* ---------- 6. 语言包目录名与 manifest.name 不一致：必须红 ---------- */
{
  const app = makeApp({
    main: patchedMainCorrect,
    wb: patchedWb,
    extDirName: "ms-ceintl.vscode-language-pack-zh-hans",
    extManifestName: "vscode-language-pack-zh-hans",
  });
  const r = run(app);
  cases.push({ name: "语言包目录名错 → 红（会被静默跳过）", ok: r.code !== 0, out: r.out });
}

/* ---------- 7. 模板翻译条数不足：必须红 ---------- */
{
  const app = makeApp({ main: patchedMainCorrect, wb: patchedWb, template: template({ count: 10 }) });
  const r = run(app);
  cases.push({ name: "模板翻译条数不足 → 红", ok: r.code !== 0, out: r.out });
}

/* ---------- 8. 默认主题改回蓝色：必须红 ---------- */
{
  const blueWb = patchedWb
    .replace('ThemeSettingDefaults["COLOR_THEME_DARK"] = "夜墨 · NovelPad Ink";', 'ThemeSettingDefaults["COLOR_THEME_DARK"] = "Default Dark Modern";')
    .replace('ThemeSettingDefaults["COLOR_THEME_LIGHT"] = "宣纸 · NovelPad Paper";', 'ThemeSettingDefaults["COLOR_THEME_LIGHT"] = "Default Light Modern";');
  const app = makeApp({ main: patchedMainCorrect, wb: blueWb });
  const r = run(app);
  cases.push({ name: "默认主题改回蓝色 → 红", ok: r.code !== 0 && hasFail(r.out, "平台默认主题"), out: r.out });
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log("");
let bad = 0;
for (const c of cases) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.ok) {
    bad++;
    console.log(
      "  ---- 实际输出 ----\n" +
        c.out
          .split("\n")
          .filter(Boolean)
          .map((l) => "  " + l)
          .join("\n"),
    );
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("");
if (bad) {
  console.error(`判据自检失败 ${bad} 项`);
  process.exit(1);
}
log(`壳默认值判据自检 ${cases.length}/${cases.length} 通过（合成夹具，不依赖构建产物）`);