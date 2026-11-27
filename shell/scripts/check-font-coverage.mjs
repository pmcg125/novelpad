/**
 * 字体覆盖自检：确认「中文小说实际会用到的字」没有缺口。
 *
 * 动机：分片字体缺字不会报错，只会静默回退成宋体——一篇文章里冒出几个
 * 字形不同的字，作者会以为是自己打错了。必须机器验。
 *
 * 判定口径很重要：霞鹜文楷 **GB 子集** 不覆盖 U+4E00-9FFF 的全部 20992 字，
 * 只覆盖 GB2312/GBK 常用字。所以不能拿「整个区块」当分母，否则永远红。
 * 这里改用三条可执行的口径：
 *
 *   1. 常用标点必须齐（缺一个标点比缺一个生僻字刺眼得多）
 *   2. CJK 基本区覆盖字数 ≥ 6500（GB2312 一级+二级共 6763 字）
 *   3. 仓库自有的中文语料必须全覆盖（docs + 扩展 UI 字符串，
 *      这是我们真实写下的字，比任何字表都贴近使用）
 *
 * 用法：node check-font-coverage.mjs <media/fonts 目录> [仓库根]
 */
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "packages/extension/media/fonts";
const repoRoot = process.argv[3] ?? process.cwd();
const css = fs.readFileSync(path.join(dir, "lxgw-wenkai-screen-gb.css"), "utf8");

/** 解析所有 unicode-range → 合并后的区间列表 */
function parseRanges(text) {
  const raw = [];
  for (const m of text.matchAll(/unicode-range\s*:\s*([^;}]+)/g)) {
    for (const piece of m[1].split(",")) {
      const mm = piece.trim().match(/^U\+([0-9a-f]+)(?:-([0-9a-f]+))?$/i);
      if (!mm) continue;
      const a = parseInt(mm[1], 16);
      raw.push([a, mm[2] ? parseInt(mm[2], 16) : a]);
    }
  }
  // 合并重叠区间，便于 O(n) 判定
  raw.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of raw) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

const ranges = parseRanges(css);

/** 某个码位是否被覆盖 */
function covered(cp) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

const hex = (cp) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
const ch = (cp) => String.fromCodePoint(cp);
let fatal = false;

/**
 * 已知缺口：上游 webfont 包本身就没有这些码位。
 *
 * 已核对（2026-11）：本地 CSS 与官方
 * `lxgw-wenkai-screen-webfont@1.7.0` 的 `lxgwwenkaigbscreen.css`
 * 逐码位完全一致（14492 个），三个变体（GB / 非 GB / R 版）全部缺。
 * 所以这不是我们切子集切错，无法在字体侧修复。
 *
 * 兜底：字体栈里的 `Kaiti SC` / `STKaiti` / `KaiTi` / `serif` 都带这两个字形，
 * 浏览器逐字回退即可，观感差异仅限这两个标点。
 * 记录在此，是为了让脚本能继续拦截**未来新增**的缺口——
 * 不记录就必须永久允许缺口，那等于放弃这项检查。
 */
const KNOWN_GAPS = new Map([
  [0x2018, "上游 webfont 包缺字形，兜底走 Kaiti / serif"],
  [0x2019, "上游 webfont 包缺字形，兜底走 Kaiti / serif"],
]);

/* ---------- 1. 常用标点 ---------- */

// 中文小说里真正会出现的标点。省略号与破折号常连用，必须都在。
const PUNCT = [
  0x3001, 0x3002, // 、 。
  0xff0c, 0xff1b, 0xff1a, 0xff1f, 0xff01, // ， ； ： ？ ！
  0x201c, 0x201d, 0x2018, 0x2019, // “ ” ‘ ’
  0x300a, 0x300b, 0x3008, 0x3009, // 《 》 〈 〉
  0x3010, 0x3011, 0x3014, 0x3015, // 【 】 〔 〕
  0x2014, 0x2013, 0x2026, 0x00b7, // — – … ·
  0xff08, 0xff09, 0x300c, 0x300d, 0x300e, 0x300f, // （） 「」 『』
  0xff5e, 0x301c, // ～ 〜
  0x3000, // 全角空格（段首缩进的写法之一）
  0xff0e, 0x2022, // ． •
];

const missPunct = PUNCT.filter((cp) => !covered(cp));
const knownPunct = missPunct.filter((cp) => KNOWN_GAPS.has(cp));
const newPunct = missPunct.filter((cp) => !KNOWN_GAPS.has(cp));
if (newPunct.length) {
  fatal = true;
  console.log(`✗ 常用标点新增缺口 ${newPunct.length} 个：${newPunct.map((c) => `${ch(c)}(${hex(c)})`).join(" ")}`);
} else if (knownPunct.length) {
  console.log(
    `✓ 常用标点 ${PUNCT.length} 个：${PUNCT.length - knownPunct.length} 个有字形，` +
      `${knownPunct.map((c) => `${ch(c)}(${hex(c)})`).join(" ")} 已知缺口（上游缺 → 回退系统楷体）`,
  );
} else {
  console.log(`✓ 常用标点 ${PUNCT.length} 个全齐`);
}

/* ---------- 2. CJK 基本区字数 ---------- */

let cjk = 0;
for (let cp = 0x4e00; cp <= 0x9fff; cp++) if (covered(cp)) cjk++;
const CJK_MIN = 6500; // GB2312 一二级共 6763 字，留一点余量
if (cjk < CJK_MIN) {
  fatal = true;
  console.log(`✗ CJK 基本区只覆盖 ${cjk} 字，低于下限 ${CJK_MIN}（GB2312 需 6763）`);
} else {
  console.log(`✓ CJK 基本区覆盖 ${cjk} / 20992 字（${((cjk / 20992) * 100).toFixed(1)}%）`);
}

/* ---------- 3. 仓库自有中文语料 ---------- */

function walk(d, out = []) {
  if (!fs.existsSync(d)) return out;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "out", "build", "coverage", ".novelpad"].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(md|ts|json|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const corpusFiles = [
  ...walk(path.join(repoRoot, "docs")),
  ...walk(path.join(repoRoot, "packages", "extension", "src")),
  ...walk(path.join(repoRoot, "packages", "core", "src")),
  path.join(repoRoot, "packages", "extension", "package.json"),
].filter((f) => fs.existsSync(f));

const missing = new Map();
const knownHits = new Set();
let corpusChars = 0;
for (const f of corpusFiles) {
  const text = fs.readFileSync(f, "utf8");
  for (const c of text) {
    const cp = c.codePointAt(0);
    // 只关心东亚文字与全角标点；拉丁字母本来就不由这个字体负责
    const isCJK = (cp >= 0x3400 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);
    const isFull = (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef);
    if (!isCJK && !isFull) continue;
    corpusChars++;
    if (!covered(cp) && !KNOWN_GAPS.has(cp)) {
      const e = missing.get(cp) ?? { c, count: 0, where: f.replace(repoRoot, "") };
      e.count++;
      missing.set(cp, e);
    } else if (!covered(cp)) {
      knownHits.add(cp);
    }
  }
}

// 语料里出现但我们没收录的字，逐个报出来——这些是真实会打出来的字
if (missing.size) {
  fatal = true;
  const list = [...missing.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`✗ 自有语料 ${corpusChars} 字，有 ${list.length} 个不同汉字 / 标点缺字形：`);
  for (const [cp, e] of list.slice(0, 20)) {
    console.log(`    ${e.c}  ${hex(cp)}  出现 ${e.count} 次  ${e.where}`);
  }
  if (list.length > 20) console.log(`    …… 另 ${list.length - 20} 个`);
} else {
  const extra = knownHits.size ? `；${[...knownHits].map((c) => ch(c)).join(" ")} 属已知缺口，已回退` : "";
  console.log(`✓ 自有语料 ${corpusChars} 字全覆盖（${corpusFiles.length} 个文件）${extra}`);
}

console.log(fatal ? "\n存在缺口" : "\n覆盖检查通过");
process.exit(fatal ? 1 : 0);