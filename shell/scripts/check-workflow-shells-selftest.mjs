/**
 * `check-workflow-shells.mjs` 的判据自检。
 *
 * 覆盖三类：
 *   1. 真问题必须抓到（续行 / bash 语法）
 *   2. 正确写法不能误报（显式 shell、单行、ubuntu-only 续行）
 *   3. 扫描器自身：多 job、多 step、run 多行正文都要能正确切分
 *
 * 第 3 类特别重要——手写解析器最大的风险是「静默漏掉某个 job」，那样
 * 守卫会显示全绿但实际没检查。所以要断言它确实看到了预期的 job 数量。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "check-workflow-shells.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "np-wfshell-"));

function writeWf(name, lines) {
  const f = path.join(tmp, name);
  fs.writeFileSync(f, lines.join("\n") + "\n", "utf8");
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

/* ============ 1. 反例：bash 续行 + windows + 未声明 ============ */
const bad1 = writeWf("bad1.yml", [
  "name: T",
  "on: push",
  "jobs:",
  "  shell:",
  "    runs-on: windows-latest",
  "    steps:",
  "      - name: 内置中文语言包",
  "        run: |",
  "          node shell/scripts/embed.mjs \\",
  '            "VSCode-win32-x64/resources/app" \\',
  "            .langpack/x.vsix \\",
  "            --locale zh-cn",
]);
const r1 = run(bad1);
cases.push({ name: "windows + 续行 + 未声明 → 必错", ok: r1.code !== 0 && /ParserError|续行/.test(r1.out), out: r1.out });

/* ============ 2. 正例：显式 shell: bash ============ */
const good1 = writeWf("good1.yml", [
  "name: T",
  "on: push",
  "jobs:",
  "  shell:",
  "    runs-on: windows-latest",
  "    steps:",
  "      - name: 打包",
  "        shell: bash",
  "        run: |",
  "          node a.mjs \\",
  "            --x",
]);
const r2 = run(good1);
cases.push({ name: "显式 shell: bash → 通过", ok: r2.code === 0, out: r2.out });

/* ============ 3. 正例：单行 ============ */
const good2 = writeWf("good2.yml", [
  "name: T",
  "on: push",
  "jobs:",
  "  shell:",
  "    runs-on: windows-latest",
  "    steps:",
  "      - name: 语言包",
  "        run: node embed.mjs a b c",
]);
const r3 = run(good2);
cases.push({ name: "单行命令 → 通过", ok: r3.code === 0, out: r3.out });

/* ============ 4. 正例：ubuntu-only 用续行，不误报 ============ */
const good3 = writeWf("good3.yml", [
  "name: T",
  "on: push",
  "jobs:",
  "  release:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: 等待",
  "        run: |",
  "          gh run list \\",
  "            --limit 10 \\",
  "            --json databaseId",
]);
const r4 = run(good3);
cases.push({ name: "ubuntu-only 续行 → 不误报", ok: r4.code === 0, out: r4.out });

/* ============ 5. 反例：bash 语法 + windows + 未声明 ============ */
const bad2 = writeWf("bad2.yml", [
  "name: T",
  "on: push",
  "jobs:",
  "  shell:",
  "    runs-on: windows-latest",
  "    steps:",
  "      - name: 打包",
  "        run: |",
  "          rm -rf NovelPad",
  '          if [ "$x" = "zip" ]; then echo zip; fi',
]);
const r5 = run(bad2);
cases.push({ name: "windows + bash 语法 + 未声明 → 必错", ok: r5.code !== 0, out: r5.out });

/* ============ 6. 扫描器：多 job 都要被看到 ============ */
// 第一个 job 干净，第二个 job（windows）有问题。
// 如果扫描器切分错误、只看了第一个 job，就会误报「全部安全」。
const multi = writeWf("multi.yml", [
  "name: T",
  "on: push",
  "jobs:",
  "  clean:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - name: a",
  "        run: echo hi",
  "  dirty:",
  "    runs-on: windows-latest",
  "    steps:",
  "      - name: b",
  "        run: |",
  "          node x.mjs \\",
  "            --y",
]);
const r6 = run(multi);
cases.push({ name: "多 job：第二个 job 的问题也要抓到", ok: r6.code !== 0 && /dirty/.test(r6.out), out: r6.out });

/* ============ 7. 扫描器：job 内多 step，问题在最后一个 ============ */
const manySteps = writeWf("manysteps.yml", [
  "name: T",
  "on: push",
  "jobs:",
  "  shell:",
  "    runs-on: windows-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  '      - name: 第一步',
  "        run: node a.mjs",
  "      - name: 第二步",
  "        run: node b.mjs",
  "      - name: 最后一步有问题",
  "        run: |",
  "          node c.mjs \\",
  "            --z",
]);
const r7 = run(manySteps);
cases.push({ name: "多 step：最后一个 step 的问题也要抓到", ok: r7.code !== 0 && /最后一步/.test(r7.out), out: r7.out });

/* ============ 8. 扫描器：run 多行正文里的 bash 语法要能看到 ============ */
const multiline = writeWf("multiline.yml", [
  "name: T",
  "on: push",
  "jobs:",
  "  shell:",
  "    runs-on: windows-latest",
  "    steps:",
  "      - name: 打包",
  "        run: |",
  "          set -e",
  "          mv output NovelPad",
  "          rm -rf temp",
]);
const r8 = run(multiline);
cases.push({ name: "多行正文里的 bash 语法要能看到", ok: r8.code !== 0, out: r8.out });

/* ============ 汇总 ============ */
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
        .filter(Boolean)
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