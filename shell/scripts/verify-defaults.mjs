/**
 * 核对 extension 的 configurationDefaults 里每个键：
 *   1) 上游是否注册过（拼写错误会被静默忽略）
 *   2) 作用域是否在 configurationDefaults 允许的四类之内
 *
 * 用法：node verify-defaults.mjs <upstream 源码根> <extension 目录>
 *
 * 规则来源：src/vs/workbench/api/common/configurationExtensionPoint.ts
 *   allowedScopes = [MACHINE_OVERRIDABLE, WINDOW, RESOURCE, LANGUAGE_OVERRIDABLE]
 * 未声明 scope 的属性默认 WINDOW（validateAndRegisterProperties），因此合法。
 * 只有显式 APPLICATION / MACHINE 会被 delete overrides[key]。
 */
import fs from "node:fs";
import path from "node:path";

const [upstreamRoot, extDir] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(extDir, "package.json"), "utf8"));
const defaults = pkg.contributes?.configurationDefaults ?? {};

const ALLOWED = new Set(["MACHINE_OVERRIDABLE", "WINDOW", "RESOURCE", "LANGUAGE_OVERRIDABLE"]);

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (["test", "tests", "fixtures", "node_modules", ".git"].includes(e.name)) continue;
      walk(p, out);
    } else if (e.name.endsWith(".ts") || e.name.endsWith(".json")) out.push(p);
  }
  return out;
}

const roots = [];
for (const rel of ["src/vs", "extensions/markdown-language-features"]) {
  const p = path.join(upstreamRoot, rel);
  if (fs.existsSync(p)) roots.push(p);
}
const files = roots.flatMap((r) => walk(r)).map((f) => ({ f, t: fs.readFileSync(f, "utf8") }));

/** 抹掉注释与字符串内容，长度不变，用于安全配对括号 */
function mask(src) {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && n === "*") {
      out[i++] = " ";
      out[i++] = " ";
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) out[i++] = src[i] === "\n" ? "\n" : " ";
      if (i < src.length) {
        out[i++] = " ";
        out[i++] = " ";
      }
    } else if (c === "'" || c === '"' || c === "`") {
      const q = c;
      out[i++] = " ";
      while (i < src.length && src[i] !== q) {
        if (src[i] === "\\") out[i++] = " ";
        if (i < src.length && src[i] !== "\n") out[i++] = " ";
        else if (i < src.length) i++;
      }
      if (i < src.length) out[i++] = " ";
    } else i++;
  }
  return out.join("");
}

function matchBrace(m, open) {
  let depth = 0;
  for (let i = open; i < m.length; i++) {
    if (m[i] === "{") depth++;
    else if (m[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return m.length - 1;
}

/** 在 [from,to) 里找 depth==0 的 scope: ConfigurationScope.X */
function topScope(m, from, to) {
  let depth = 0;
  for (let i = from; i < to; i++) {
    const c = m[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (depth === 0) {
      const hit = m.slice(i, i + 64).match(/^scope\s*:\s*ConfigurationScope\.(\w+)/);
      if (hit) return hit[1];
    }
  }
  return null;
}

/**
 * editor.* 的键是拼出来的（schema 生成器用 `editor.` + 注册表里的 id），
 * 文本里没有字面量。判定方式：从 editorOptions.ts 底部的选项清单里取 id。
 * 整个编辑器配置节点（editorConfigurationBaseNode）的 scope 是
 * LANGUAGE_OVERRIDABLE，属于允许值。
 */
const editorOptionsSrc = files.find((x) => x.f.endsWith(path.join("config", "editorOptions.ts")))?.t ?? "";
const editorIds = new Set();

// 底部清单：`\tautoClosingQuotes,` 这样一行一个（也可能写成 `id: 'xxx'`）
for (const m of editorOptionsSrc.matchAll(/^\t{1,2}([a-zA-Z][A-Za-z0-9_]*),$/gm)) editorIds.add(m[1]);
for (const m of editorOptionsSrc.matchAll(/id:\s*'([A-Za-z.]+)'/g)) editorIds.add(m[1]);

/** editor.foo.bar -> 判断 foo 是否在注册表里（嵌套对象如 scrollbar / minimap） */
function isEditorOption(key) {
  const rest = key.slice("editor.".length);
  const head = rest.split(".")[0];
  return editorIds.has(head) || editorIds.has(rest);
}

/**
 * 用常量拼出来的设置键：源码里只有常量名，没有字面量。
 * 这些常量已逐一核对过（见注释里的出处），且都未声明 scope → 默认 WINDOW，合法。
 */
const CONST_KEYS = new Map([
  // vs/workbench/services/layout/browser/layoutService.ts:28
  ["workbench.editor.showTabs", "LayoutSettings.EDITOR_TABS_MODE"],
  // vs/workbench/services/layout/browser/layoutService.ts:29
  ["window.commandCenter", "LayoutSettings.COMMAND_CENTER"],
  // vs/platform/list/browser/listService.ts:187
  ["workbench.tree.indent", "treeIndentKey"],
  // vs/platform/list/browser/listService.ts:189
  ["workbench.list.smoothScrolling", "listSmoothScrolling"],
]);

const report = [];
for (const key of Object.keys(defaults)) {
  let scope = null;
  let where = "";
  let known = false;

  // 1) 语言级覆盖（"[markdown]": {...}）——键本身不是设置项
  if (/^\[.+\]$/.test(key)) {
    report.push({ key, scope: "LANGUAGE", verdict: "OK", where: "语言级覆盖" });
    continue;
  }

  // 2) 文本里找字面量定义
  for (const { f, t } of files) {
    for (const q of ["'", '"', "`"]) {
      const needle = `${q}${key}${q}`;
      let at = t.indexOf(needle);
      while (at >= 0) {
        const m = mask(t);
        const after = m.slice(at + needle.length, at + needle.length + 12);
        const mm = after.match(/^\s*:\s*\{/);
        if (mm) {
          const open = at + needle.length + mm[0].length - 1;
          const end = matchBrace(m, open);
          scope = topScope(m, open, end);
          if (!scope) {
            const reg = m.lastIndexOf("registerConfiguration", at);
            if (reg >= 0) {
              const nodeOpen = m.indexOf("{", m.indexOf("(", reg));
              const nodeEnd = matchBrace(m, nodeOpen);
              if (nodeOpen >= 0 && nodeOpen < at && at < nodeEnd) scope = topScope(m, nodeOpen, nodeEnd);
            }
          }
          where = f.replace(upstreamRoot, "").replace(/\\/g, "/");
          known = true;
          break;
        }
        at = t.indexOf(needle, at + 1);
      }
      if (known) break;
    }
    if (known) break;
  }

  // 3) editor.* 用拼键，按 editorOptions 注册表判定
  if (!known && /^editor\./.test(key) && isEditorOption(key)) {
    scope = "LANGUAGE_OVERRIDABLE";
    where = "editorConfigurationBaseNode";
    known = true;
  }

  // 4) 常量拼键（已人工核对出处）
  if (!known && CONST_KEYS.has(key)) {
    scope = "WINDOW";
    where = CONST_KEYS.get(key);
    known = true;
  }

  if (!known) {
    report.push({ key, scope: "?", verdict: "NOT-FOUND", where: "上游找不到定义" });
    continue;
  }
  const eff = scope ?? "WINDOW";
  report.push({
    key,
    scope: eff,
    verdict: ALLOWED.has(eff) ? "OK" : "BLOCKED",
    where,
  });
}

const bad = report.filter((r) => r.verdict === "BLOCKED");
const unknown = report.filter((r) => r.verdict === "NOT-FOUND");

/**
 * 顺带校验命令声明：有快捷键 / 有菜单项但没在 contributes.commands 里声明的命令，
 * 快捷键照样能按（registerCommand 成功），但 F1 命令面板里搜不到，
 * 且「键盘快捷方式」界面显示不出可读标题。属于静默半失效，机器拦住。
 */
const declared = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
const referenced = new Set([
  ...(pkg.contributes?.keybindings ?? []).map((k) => k.command),
  ...(pkg.contributes?.menus ? Object.values(pkg.contributes.menus).flat().map((m) => m.command) : []),
]);
const undeclared = [...referenced].filter((c) => c && !declared.has(c));

console.log(`共 ${report.length} 个键`);
console.log(`命令 ${declared.size} 个，被快捷键 / 菜单引用但未声明：${undeclared.length ? undeclared.join(", ") : "无"}`);
if (bad.length) {
  console.log("\n会被静默丢弃（scope 不允许）：");
  for (const r of bad) console.log(`  ✗ ${r.key.padEnd(38)} ${r.scope}  ${r.where}`);
}
if (unknown.length) {
  console.log("\n上游找不到定义（可能拼写错误）：");
  for (const r of unknown) console.log(`  ? ${r.key}`);
}
if (undeclared.length) {
  console.log("\n被快捷键 / 菜单引用但未在 contributes.commands 声明（F1 搜不到）：");
  for (const c of undeclared) console.log(`  ✗ ${c}`);
}
if (!bad.length && !unknown.length) console.log("全部键合法且可在上游找到定义 ✓");

/**
 * 受限模式能力声明。
 *
 * 这条很容易被忽略，但后果很重：package.json 里没有
 * capabilities.untrustedWorkspaces.supported 时，上游默认按
 * supported=false 处理（extensionManifestPropertiesService.ts:185），
 * 于是**未信任的工作区里扩展完全不激活**——主题、书房、侧栏、栏宽
 * 全都不跑，界面看起来像「什么都没做」，日志里也没有任何报错
 * （expthost.log 里连 novelpad 这行都不出现）。
 *
 * 实测：不加这个字段时 exthost.log 里只有 vscode.git-base / vscode.github；
 * 加上后 novelpad.novelpad 正常激活，主题与栏宽立刻生效。
 *
 * 类型也要对：supported 只接受 true / false / "limited"。
 * 写错（比如 "yes"）会被当成不支持。
 */
const untrusted = pkg.capabilities?.untrustedWorkspaces;
const untrustedOk =
  untrusted !== undefined &&
  (untrusted.supported === true || untrusted.supported === "limited") &&
  (untrusted.supported !== "limited" || typeof untrusted.description === "string");
const extra = [];
if (untrusted !== undefined && untrusted.supported === "limited" && !untrusted.description) {
  extra.push("supported 为 limited 时必须给 description（上游会显示给用户）");
}

console.log("");
if (!untrustedOk) {
  console.log("✗ capabilities.untrustedWorkspaces 缺失或类型不对");
  console.log("  没有它 → 解锁前的工作区里扩展完全不激活，界面像「没做皮肤」，无报错");
  console.log(`  当前值：${JSON.stringify(untrusted)}`);
  for (const e of extra) console.log(`  ✗ ${e}`);
} else {
  console.log("受限模式能力声明正确 ✓（未信任工作区里也会激活）");
}

const failed = bad.length > 0 || undeclared.length > 0 || !untrustedOk;
process.exit(failed ? 1 : 0);