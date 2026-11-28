/**
 * 从真实上游源码生成 003 补丁。
 *
 * 三处壳默认值（标准 VS Code 里装的同一份扩展不受影响）：
 *   1. 默认关闭「工作区信任」
 *   2. 新生成的 argv.json 默认 locale = zh-cn
 *   3. 首启动补齐 argv.json 与 languagepacks.json
 *
 * ── 启动顺序（src/main.js 1.85.0，逐行核对过） ──
 *
 *   18: const path = require('path');
 *   19: const fs = require('fs');
 *   20: const os = require('os');
 *   23: const { getUserDataPath } = require('./vs/platform/environment/node/userDataPath');
 *   27: const product = require('../product.json');
 *   36: const args = parseCLIArgs();
 *   38: const argvConfig = configureCommandlineSwitchesSync(args);   ← 内部读 argv.json
 *   57: const userDataPath = getUserDataPath(args, product.nameShort);  ← 更晚
 *   ...
 *   const locale = getUserDefinedLocale(argvConfig);
 *   if (locale) { ... getNLSConfiguration(...) }                    ← 读 languagepacks.json
 *
 * ── 两个「读的时候还没有」 ──
 *
 * 1) argv.json：readArgvConfigSync() 在 ENOENT 时**当场生成**却不回填，
 *    直接返回 {}。所以首次启动那一轮 locale 永远是 undefined。
 *    实测：删掉 argv.json 全新启动 → 界面全英文；预置后 → 8/8 中文菜单。
 *
 * 2) languagepacks.json：由工作台启动后扫描扩展才写，首启动时不存在。
 *    实测：只有 argv.json 时 clp 缓存不生成、界面仍英文。
 *
 * ── 为什么一个函数就能同时补 ──
 *
 * getUserDataPath 在第 23 行就已经 require 进来了。所以在第 38 行之前
 * 用 `getUserDataPath(args, product.nameShort)` 自己算一次，得到的路径
 * 与第 57 行**完全一致**（同函数、同参数），不必等 userDataPath 声明。
 *
 * 于是插入点只有一个：`const argvConfig = configureCommandlineSwitchesSync(args);`
 * 之前。既早于读 argv.json，也早于读 languagepacks.json。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const TAG = "1.85.0";
const RAW = `https://raw.githubusercontent.com/microsoft/vscode/${TAG}`;
const OUT = process.argv[2] ?? "shell/patches/003-shell-defaults.patch";

const BOOTSTRAP_FN = [
  "/**",
  " * NovelPad：首启动补齐 argv.json 的 locale 与 languagepacks.json。",
  " *",
  " * 上游有两处「读的时候文件还不存在」，而且都发生在 app ready 之前：",
  " *",
  " *   argv.json          readArgvConfigSync() 在 ENOENT 时生成却不回填，",
  " *                      返回 {} → locale=undefined → 界面英文",
  " *   languagepacks.json 由工作台启动后扫描扩展才写，首启动时不存在",
  " *                      → 界面英文（第二次启动才读到上一轮写的）",
  " *",
  " * 实测：删掉 argv.json 全新启动 → 全英文；两份都预置 → 8/8 中文菜单。",
  " * 「装完打开是英文，关掉再开才中文」不能当成品发，所以在这里补。",
  " *",
  " * userDataPath 在这一步还没声明（第 57 行），但 getUserDataPath 第 23 行",
  " * 就已经 require 了。这里用同样的函数与参数算一次，结果与第 57 行一致。",
  " *",
  " * 只补缺失，绝不覆盖：argv.json 已存在就一个字都不动（作者可能把 locale",
  " * 改成了 en），languagepacks.json 已存在也不动。",
  " */",
  "function ensureNovelPadBootstrapSync() {",
  "\ttry {",
  "\t\t// ---- 1. argv.json：默认中文界面 ----",
  "\t\tconst argvFile = getArgvConfigPath();",
  "\t\tif (!fs.existsSync(argvFile)) {",
  "\t\t\tconst dir = path.dirname(argvFile);",
  "\t\t\tif (!fs.existsSync(dir)) {",
  "\t\t\t\tfs.mkdirSync(dir, { recursive: true });",
  "\t\t\t}",
  "\t\t\tfs.writeFileSync(argvFile, [",
  "\t\t\t\t'// NovelPad 的启动参数（自动生成，可手工编辑）',",
  "\t\t\t\t'{',",
  "\t\t\t\t'\\t// 界面语言：中文。改成 \"en\" 用英文；整行删掉则跟随系统。',",
  "\t\t\t\t'\\t\"locale\": \"zh-cn\"',",
  "\t\t\t\t'}',",
  "\t\t\t\t''",
  "\t\t\t].join('\\n'));",
  "\t\t}",
  "",
  "\t\t// ---- 2. languagepacks.json：让主进程能解析语言包 ----",
  "\t\tconst userDataPath = getUserDataPath(args, product.nameShort ?? 'code-oss-dev');",
  "\t\tconst targetFile = path.join(userDataPath, 'languagepacks.json');",
  "\t\tif (fs.existsSync(targetFile)) {",
  "\t\t\treturn;",
  "\t\t}",
  "\t\tconst appRoot = path.join(__dirname, '..');",
  "\t\tconst templateFile = path.join(appRoot, 'novelpad-languagepack.json');",
  "\t\tif (!fs.existsSync(templateFile)) {",
  "\t\t\t// 不是 NovelPad 的壳，或构建时没塞语言包。保持英文，不报错。",
  "\t\t\treturn;",
  "\t\t}",
  "\t\tconst template = JSON.parse(fs.readFileSync(templateFile).toString());",
  "\t\tconst resolved = {};",
  "\t\tfor (const localeId of Object.keys(template)) {",
  "\t\t\tconst pack = template[localeId];",
  "\t\t\tconst translations = {};",
  "\t\t\tfor (const id of Object.keys(pack.translations || {})) {",
  "\t\t\t\ttranslations[id] = path.join(appRoot, pack.translations[id]);",
  "\t\t\t}",
  "\t\t\tresolved[localeId] = Object.assign({}, pack, { translations });",
  "\t\t}",
  "\t\tfs.mkdirSync(userDataPath, { recursive: true });",
  "\t\tfs.writeFileSync(targetFile, JSON.stringify(resolved));",
  "\t} catch (error) {",
  "\t\t// 补不上就退回英文界面，不该阻断启动。",
  "\t\tconsole.warn(`[novelpad] bootstrap failed (${error})`);",
  "\t}",
  "}",
  "",
].join("\n");

/** 唯一命中一次，否则直接失败 */
function replaceOnce(text, find, replace, label) {
  const n = text.split(find).length - 1;
  if (n !== 1) throw new Error(`${label}: 锚点命中 ${n} 次，应为 1`);
  const out = text.replace(find, replace);
  if (out === text) throw new Error(`${label}: 内容没变化，锚点写错了`);
  return out;
}

const targets = [
  {
    file: "src/main.js",
    edits: [
      {
        // argv.json 模板：加 locale。
        // 注意这是**字符串数组元素**（源码 '\\t"locale": "zh-cn",'），
        // 写成裸对象属性会让主进程 SyntaxError（实测过，弹窗「A JavaScript
        // error occurred in the main process」，窗口永不出现）。
        find: "\t\t\t'{',\n",
        insert:
          "\t\t\t'{',\n" +
          "\t\t\t'\t// 界面语言：中文。改成 \"en\" 用英文；整行删掉则跟随系统。',\n" +
          "\t\t\t'\t\"locale\": \"zh-cn\",',\n" +
          "\t\t\t'',\n",
        label: "argv 模板加 locale",
      },
      {
        // bootstrap 函数定义：放在 nlsConfigurationPromise 之后，
        // 那时 path/fs/os/product/getUserDataPath/getArgvConfigPath 全都可用
        // （函数声明会提升，但读起来更清楚）。
        find: "let nlsConfigurationPromise = undefined;\n",
        insert: "let nlsConfigurationPromise = undefined;\n\n" + BOOTSTRAP_FN,
        label: "插入 bootstrap 函数",
      },
      {
        // 唯一调用点：早于 configureCommandlineSwitchesSync（读 argv.json），
        // 也早于 getNLSConfiguration（读 languagepacks.json）。
        find: "const argvConfig = configureCommandlineSwitchesSync(args);\n",
        replace:
          "// NovelPad：首启动补齐 argv.json 与 languagepacks.json。\n" +
          "// 必须早于下一行——它内部会读 argv.json；读不到就回退英文。\n" +
          "ensureNovelPadBootstrapSync();\n\n" +
          "const argvConfig = configureCommandlineSwitchesSync(args);\n",
        label: "调用 bootstrap",
      },
    ],
  },
  {
    file: "src/vs/workbench/services/themes/common/workbenchThemeService.ts",
    edits: [
      {
        // NovelPad 的主题名（必须与 themes/*.json 里的 name 逐字一致）。
        //
        // 为什么改这里而不是靠扩展运行时写设置：
        //   `ThemeSettingDefaults` 是**平台级默认值**，三个配置项都引用它：
        //     colorThemeSettingSchema.default          = isWeb ? LIGHT : DARK
        //     preferredDarkThemeSettingSchema.default  = DARK
        //     preferredLightThemeSettingSchema.default = LIGHT
        //   改这两个常量 = 编译期就生效，不依赖扩展激活、不写用户设置、
        //   也不需要 `--disable-workspace-trust` 之类的绕过。
        //
        // 之前靠扩展写 settings 的做法有个固有缺陷：扩展没激活（受限模式、
        // 激活失败）时界面退回蓝色 Default Dark Modern。现在从默认值层面
        // 就是宣纸/夜墨，扩展只负责「跟随系统」这个开关。
        find: "\tCOLOR_THEME_DARK = 'Default Dark Modern',\n\tCOLOR_THEME_LIGHT = 'Default Light Modern',",
        replace: [
          "\t// NovelPad：把平台级默认颜色主题换成自有主题。",
          "\t// 三个配置项（workbench.colorTheme / preferredDarkColorTheme /",
          "\t// preferredLightColorTheme）都引用这两个常量，改这里即可整体生效。",
          "\t// 上游原值：'Default Dark Modern' / 'Default Light Modern'（蓝色主题）。",
          "\tCOLOR_THEME_DARK = '夜墨 · NovelPad Ink',",
          "\tCOLOR_THEME_LIGHT = '宣纸 · NovelPad Paper',",
        ].join("\n"),
        label: "默认颜色主题换成 NovelPad",
      },
    ],
  },
  {
    file: "src/vs/workbench/contrib/workspace/browser/workspace.contribution.ts",
    edits: [
      {
        find: "\t\t\t\tdefault: true,\n\t\t\t\tdescription: localize('workspace.trust.description'",
        replace: [
          "\t\t\t\t// NovelPad：默认关闭「工作区信任」。",
          "\t\t\t\t//",
          "\t\t\t\t// 作者的稿件是 Markdown，不是可执行代码，问「我是否信任这些",
          "\t\t\t\t// 文件的作者」对写作软件没有意义。更糟的是在作者按下「信任」",
          "\t\t\t\t// 之前整个扩展都不激活——主题、书房、侧栏一概没有，内置 git",
          "\t\t\t\t// 扩展也被禁用（版本管理直接失效）。新用户第一眼看到的会是",
          "\t\t\t\t// 一个安全警告，而不是书房。",
          "\t\t\t\t//",
          "\t\t\t\t// 只改壳的默认值：装到标准 VS Code 里的同一份扩展不受影响。",
          "\t\t\t\tdefault: false,",
          "\t\t\t\tdescription: localize('workspace.trust.description'",
        ].join("\n"),
        label: "信任默认关闭",
      },
    ],
  },
];

/* ---------- 逐文件生成 diff ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-patch-"));
const chunks = [];

for (const t of targets) {
  const res = await fetch(`${RAW}/${t.file}`);
  if (!res.ok) throw new Error(`下载失败 ${t.file}: ${res.status}`);
  const original = await res.text();
  let updated = original;
  for (const e of t.edits) {
    updated = replaceOnce(updated, e.find, e.insert ?? e.replace, `${t.file} / ${e.label}`);
  }

  const dir = path.join(tmp, t.file.replace(/\//g, "__"));
  const a = path.join(dir, "a");
  const b = path.join(dir, "b");
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const base = path.basename(t.file);
  fs.writeFileSync(path.join(a, base), original, "utf8");
  fs.writeFileSync(path.join(b, base), updated, "utf8");

  let diff;
  try {
    diff = execFileSync("git", ["diff", "--no-index", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", a, b], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    diff = e.stdout ?? "";
    if (!diff) throw e;
  }

  const rel = diff
    .replace(/^diff --git .*$/m, `diff --git a/${t.file} b/${t.file}`)
    .replace(/^--- .*$/m, `--- a/${t.file}`)
    .replace(/^\+\+\+ .*$/m, `+++ b/${t.file}`);
  if (!rel.includes(`a/${t.file}`)) throw new Error(`${t.file}: 生成的 diff 路径不对`);

  // 只去掉尾部换行，不能用 trimEnd()：
  // git diff 的上下文行以单个空格开头，如果 hunk 最后一行恰好是空行
  // （内容就是 " "），trimEnd 会把它变成空字符串——hunk 声明的行数
  // 与实际内容不符，git apply 报 "corrupt patch"。
  // 这个坑很隐蔽：只有 hunk 尾部正好是空行时才触发。
  chunks.push(rel.replace(/\n+$/, ""));
  const delta = updated.split("\n").length - original.split("\n").length;
  console.log(`OK  ${t.file}  (${delta >= 0 ? "+" : ""}${delta} 行)`);
}

fs.writeFileSync(OUT, chunks.join("\n") + "\n", "utf8");
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n写入 ${OUT}`);