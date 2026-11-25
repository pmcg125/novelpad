/**
 * NovelPad CLI —— 零依赖、手写参数解析。
 *
 *   novelpad export [--format txt|docx|all] [--profile name] [--out dir] [--status draft,final] [root]
 *   novelpad check  [root]
 *   novelpad stats  [root]
 *   novelpad init   [dir]
 */
import fs from "node:fs";
import path from "node:path";
import {
  BUILTIN_PROFILES,
  exportDocx,
  exportTxt,
  lintProject,
  loadConfig,
  loadProject,
  resolveProfile,
  type ChapterStatus,
  type Diagnostic,
} from "@novelpad/core";

interface Args {
  _: string[];
  format: string;
  profile: string | undefined;
  out: string | undefined;
  status: string | undefined;
  help: boolean;
}

const HELP = `NovelPad —— 作家的 VS Code

用法：
  novelpad export [root]  导出作品
      --format txt|docx|all   (默认 all)
      --profile <name>        default | submission | print，或 .novelpad/profiles/<name>.json
      --out <dir>             输出目录（默认 <root>/dist）
      --status draft,final    只导出指定状态的章节
  novelpad check  [root]  运行 lint 规则，有问题时退出码 1
  novelpad stats  [root]  字数与章节统计
  novelpad init   [dir]   初始化新作品目录
  novelpad --help
`;

function parse(argv: string[]): Args {
  const a: Args = { _: [], format: "all", profile: undefined, out: undefined, status: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === "--help" || t === "-h") a.help = true;
    else if (t === "--format") a.format = argv[++i] ?? a.format;
    else if (t === "--profile") a.profile = argv[++i];
    else if (t === "--out") a.out = argv[++i];
    else if (t === "--status") a.status = argv[++i];
    else if (t.startsWith("--format=")) a.format = t.slice(9);
    else if (t.startsWith("--profile=")) a.profile = t.slice(10);
    else if (t.startsWith("--out=")) a.out = t.slice(6);
    else if (t.startsWith("--status=")) a.status = t.slice(9);
    else a._.push(t);
  }
  return a;
}

function fail(msg: string): never {
  console.error(`错误：${msg}`);
  process.exit(2);
}

/** 解析 root：参数 > 向上查找 .novelpad / chapters（当前目录优先） */
function resolveRoot(arg: string | undefined): string {
  if (arg) {
    const abs = path.resolve(arg);
    if (!fs.existsSync(abs)) fail(`目录不存在：${abs}`);
    return abs;
  }
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, ".novelpad"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  fail("当前目录不是 NovelPad 作品（未找到 .novelpad/）");
}

/** 加载 profile：内置 > 项目自定义 */
function loadProfile(root: string, name?: string) {
  const cfg = loadConfig(root);
  const finalName = name ?? cfg.exportProfile ?? "default";
  const custom = path.join(root, ".novelpad", "profiles", `${finalName}.json`);
  if (BUILTIN_PROFILES[finalName]) return resolveProfile(finalName);
  if (fs.existsSync(custom)) {
    try {
      const override = JSON.parse(fs.readFileSync(custom, "utf8"));
      const base = typeof override.extends === "string" ? override.extends : "default";
      return resolveProfile(base, override);
    } catch (e) {
      fail(`profile 文件解析失败 ${custom}：${(e as Error).message}`);
    }
  }
  fail(`未知的 profile「${finalName}」，内置：${Object.keys(BUILTIN_PROFILES).join(", ")}，自定义请放在 .novelpad/profiles/`);
}

const SEVERITY_ICON: Record<Diagnostic["severity"], string> = { error: "✖", warning: "⚠", info: "ℹ" };

function printDiagnostics(diags: Diagnostic[]): void {
  for (const d of diags) {
    const loc = d.column ? `${d.file}:${d.line}:${d.column}` : `${d.file}:${d.line}`;
    console.log(`${SEVERITY_ICON[d.severity]} ${loc}  ${d.message}  (${d.rule})`);
  }
  const c = { error: 0, warning: 0, info: 0 };
  for (const d of diags) c[d.severity]++;
  console.log(`\n${diags.length} 个问题（${c.error} 错误，${c.warning} 警告，${c.info} 提示）`);
}

/* ---------------- 子命令 ---------------- */

function cmdExport(a: Args): void {
  const root = resolveRoot(a._[0]);
  const project = loadProject({ root });
  if (!project.chapters.length) fail("没有找到章节文件");

  const profile = loadProfile(root, a.profile);
  const statuses = a.status?.split(",").map((s) => s.trim()).filter(Boolean) as ChapterStatus[] | undefined;
  const opts = statuses ? { includeStatuses: statuses } : {};
  const outDir = path.resolve(a.out ?? path.join(root, "dist"));
  fs.mkdirSync(outDir, { recursive: true });

  const base = project.config.title.replace(/[\\/:*?"<>|]/g, "_");
  const written: string[] = [];
  const pending: Promise<void>[] = [];

  if (a.format === "txt" || a.format === "all") {
    const file = path.join(outDir, `${base}.txt`);
    fs.writeFileSync(file, "\uFEFF" + exportTxt(project, profile, opts), "utf8");
    written.push(file);
  }
  if (a.format === "docx" || a.format === "all") {
    const file = path.join(outDir, `${base}.docx`);
    pending.push(
      exportDocx(project, profile, opts).then((buf) => {
        fs.writeFileSync(file, buf);
        written.push(file);
      }),
    );
  }
  Promise.all(pending)
    .then(() => report(written, project.chapters.length))
    .catch((e: Error) => fail(`DOCX 生成失败：${e.message}`));
}

function report(written: string[], n: number): void {
  for (const f of written) console.log(`已导出 ${path.relative(process.cwd(), f)}`);
  console.log(`（${n} 章）`);
}

function cmdCheck(a: Args): void {
  const root = resolveRoot(a._[0]);
  const project = loadProject({ root });
  const diags = lintProject(project, { rules: project.config.rules });
  printDiagnostics(diags);
  if (diags.some((d) => d.severity === "error")) process.exit(1);
}

function cmdStats(a: Args): void {
  const root = resolveRoot(a._[0]);
  const project = loadProject({ root });
  console.log(`《${project.config.title}》`);
  let total = 0;
  for (const ch of project.chapters) {
    total += ch.wordCount;
    const target = ch.frontmatter.targetWords;
    const pct = target ? `  / ${target} (${Math.round((ch.wordCount / target) * 100)}%)` : "";
    console.log(`  第${String(ch.frontmatter.order).padStart(3)}章  ${ch.frontmatter.title.padEnd(16)} ${String(ch.wordCount).padStart(6)} 字${pct}  [${ch.frontmatter.status ?? "draft"}]`);
  }
  console.log(`\n合计：${project.chapters.length} 章，${total} 字`);
  const byStatus = new Map<string, number>();
  for (const ch of project.chapters) {
    const s = ch.frontmatter.status ?? "draft";
    byStatus.set(s, (byStatus.get(s) ?? 0) + ch.wordCount);
  }
  console.log([...byStatus.entries()].map(([k, v]) => `${k}: ${v} 字`).join("  "));
}

function cmdInit(a: Args): void {
  const dir = path.resolve(a._[0] ?? process.cwd());
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
    if (!fs.existsSync(path.join(dir, ".novelpad"))) fail(`目录非空且不是 NovelPad 作品：${dir}`);
  }
  for (const d of [".novelpad", "chapters", "outline", "characters", "world/locations", "world/factions", "world/items"]) {
    fs.mkdirSync(path.join(dir, d), { recursive: true });
  }
  const cfgPath = path.join(dir, ".novelpad", "config.json");
  if (!fs.existsSync(cfgPath)) {
    const title = path.basename(dir);
    fs.writeFileSync(cfgPath, JSON.stringify({ title, chaptersDir: "chapters", outlineDir: "outline", exportProfile: "default" }, null, 2) + "\n", "utf8");
  }
  const ch1 = path.join(dir, "chapters", "001.md");
  if (!fs.existsSync(ch1)) {
    fs.writeFileSync(
      ch1,
      `---\ntitle: 第一章\norder: 1\nstatus: draft\ncharacters: []\nlocations: []\n---\n\n# 第一章\n\n在这里开始写作。\n`,
      "utf8",
    );
  }
  const gitignore = path.join(dir, ".novelpad", ".gitignore");
  if (!fs.existsSync(gitignore)) fs.writeFileSync(gitignore, "index/\ncache/\n", "utf8");
  console.log(`已在 ${dir} 初始化 NovelPad 作品`);
}

export { parse, resolveRoot, loadProfile, printDiagnostics, cmdExport, cmdCheck, cmdStats, cmdInit, fail, HELP };
