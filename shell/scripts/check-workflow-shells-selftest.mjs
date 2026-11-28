#!/usr/bin/env node
/**
 * `check-workflow-shells.mjs` 的判据自检。
 *
 * 用真实的「修好前 / 修好后」两种写法当夹具，证明守卫能分辨对错。
 * 也顺带钉住 `release.yml` 那种「只在 ubuntu 上跑」的场景**不能**误报——
 * 误报多了守卫会被无视，比没有守卫更糟。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "check-workflow-shells.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-wfshell-"));

/** 写一个最小 workflow，jobs 内容由参数决定 */
function wf(name, body) {
  const f = path.join(tmp, name);
  fs.writeFileSync(
    f,
    [
      "name: Test",
      "on: push",
      "jobs:",
      "  a:",
      "    runs-on: windows-latest",
      "    steps:",
      body,
      "",
    ].join("\n"),
    "utf8",
  );
  return f;
}

function wfLinux(name, body) {
  const f = path.join(tmp, name);
  fs.writeFileSync(
    f,
    ["name: Test", "on: push", "jobs:", "  a:", "    runs-on: ubuntu-latest", "    steps:", body, ""].join("\n"),
    "utf8",
  );
  return f;
}

function run(file) {
  try {
    const out = execFileSync(process.execPath, [script, file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const cases = [];

/* ---------- 反例：正是因为这种写法，CI 红过一次 ---------- */
const bad = wf(
  "bad.yml",
  [
    "      - name: 内置中文语言包",
    "        run: |",
    "          node shell/scripts/embed-language-pack.mjs \\",
    '            "VSCode-win32-x64/resources/app" \\',
    "            .langpack/x.vsix \\",
    "            --locale zh-cn",
  ].join("\n"),
);
const r1 = run(bad);
cases.push({
  name: "windows job + bash 续行 + 未声明 shell → 必须报错",
  ok: r1.code !== 0 && /ParserError|续行/.test(r1.out),
  out: r1.out,
});

/* ---------- 正例 1：显式 shell: bash ---------- */
const good1 = wf(
  "good1.yml",
  [
    "      - name: 内置中文语言包",
    "        shell: bash",
    "        run: |",
    "          node shell/scripts/embed-language-pack.mjs \\",
    '            "VSCode-win32-x64/resources/app" \\',
    "            .langpack/x.vsix \\",
    "            --locale zh-cn",
  ].join("\n"),
);
const r2 = run(good1);
cases.push({ name: "显式 shell: bash → 通过", ok: r2.code === 0, out: r2.out });

/* ---------- 正例 2：单行命令（实际采用的改法） ---------- */
const good2 = wf(
  "good2.yml",
  ['      - name: 内置中文语言包', '        run: node shell/scripts/embed-language-pack.mjs "${{ matrix.out }}/resources/app" x.vsix --locale zh-cn'].join("\n"),
);
const r3 = run(good2);
cases.push({ name: "单行命令 → 通过", ok: r3.code === 0, out: r3.out });

/* ---------- 正例 3：只在 ubuntu 上跑的 job 用续行，不该误报 ---------- */
const good3 = wfLinux(
  "good3.yml",
  [
    "      - name: 等待壳构建完成",
    "        run: |",
    "          gh run list \\",
    "            --limit 10 \\",
    "            --json databaseId",
  ].join("\n"),
);
const r4 = run(good3);
cases.push({ name: "ubuntu-only job 用续行 → 不误报", ok: r4.code === 0, out: r4.out });

/* ---------- 反例 2：windows job 里 bash 专有语法 ---------- */
const bad2 = wf(
  "bad2.yml",
  ["      - name: 打包", "        run: |", "          rm -rf NovelPad", '          if [ "$x" = "zip" ]; then echo zip; fi'].join("\n"),
);
const r5 = run(bad2);
cases.push({ name: "windows job + bash 语法 + 未声明 shell → 必须报错", ok: r5.code !== 0, out: r5.out });

/* ---------- 汇总 ---------- */
console.log("");
let badCount = 0;
for (const c of cases) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.ok) {
    badCount++;
    console.log("  ---- 实际输出 ----");
    console.log(
      c.out
        .split("\n")
        .map((l) => "  " + l)
        .join("\n"),
    );
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("");
if (badCount) {
  console.error(`判据自检失败 ${badCount} 项`);
  process.exit(1);
}
console.log(`workflow shell 判据自检 ${cases.length}/${cases.length} 通过`);