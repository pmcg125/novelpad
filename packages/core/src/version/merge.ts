/**
 * 章节级合并 —— 分工合写（共创 B）的内核。
 *
 * **不做自动文本合并**，这是有意的设计，不是没做完。计划 §5.2：
 *
 *   章节冲突（两人改了同一章）→ 显示两版全文，人工挑选段落
 *
 * 理由：三路文本合并（3-way merge）在散文上效果极差。代码有语法结构、
 * 大括号给你天然锚点；散文没有——两个人都改了同一段，git 的
 * 「冲突标记 + <<<<<<<」给作者看的就是一坨没法用的东西，最后还得
 * 手工重写一遍。既然无论如何都要人读，不如直接把两个版本并排摆出来，
 * 按**章**为单位让人选择。
 *
 * 所以这一层提供的是「决策所需的事实」，不是「决策结果」：
 *
 *   listBranches      有哪些支线
 *   compareBranches   两边各改了哪些章、各多少字
 *   chapterContent    某章在某个分支上的全文
 *   planMerge         逐章给出建议动作（采用 / 保留 / 人工挑）
 *   applyMerge        把选定的章节写进目标分支，一次提交
 *
 * ── 为什么按「章」而不是按「文件」 ──
 *
 * 章节是天然的分工边界。一人写林晚照的 POV，一人写主线，交叉点极少。
 * 按文件粒度会让「两个人都改了同一个人物卡」变成冲突——那是设定，
 * 合并不是最优解；按章粒度则各写各的，几乎零冲突。
 */
import path from "node:path";
import type { ExecFn } from "./repo.js";
import { createSnapshot, refExists } from "./repo.js";

/* ============================================================
 * 类型
 * ============================================================ */

export interface BranchInfo {
  /** 短名（main、line/林晚照） */
  name: string;
  /** 完整 ref（refs/heads/...） */
  ref: string;
  /** 顶端提交 */
  commit: string;
  /** 提交时间 ISO */
  committedAt: string;
  /** 相对于给定基准的领先/落后提交数 */
  ahead: number;
  behind: number;
  /** 是否为当前检出的分支 */
  current: boolean;
}

/** 一章在两个分支上的情况 */
export type ChapterVerdict =
  /** 只有目标分支改了 → 保留目标 */
  | "keep-target"
  /** 只有来源分支改了 → 可直接采用 */
  | "take-source"
  /** 两边改得一模一样 → 无需动作 */
  | "identical"
  /** 两边都改了且内容不同 → 必须人工挑 */
  | "conflict"
  /** 来源分支删了这章 */
  | "deleted-in-source"
  /** 目标分支删了这章、来源改过 → 要不要复活 */
  | "recreated";

export interface ChapterChange {
  /** 作品相对路径，如 chapters/003.md */
  file: string;
  verdict: ChapterVerdict;
  /** 各版本的字符数（中文按字算，不用字节） */
  targetChars: number;
  sourceChars: number;
  /** 共同祖先的字符数；新建章节为 0 */
  baseChars: number;
  /** 增删字数（正数为增） */
  delta: number;
  /** 章节标题（从 Markdown 一级标题取，取不到就用文件名） */
  title: string;
}

export interface MergeComparison {
  /** 基准分支（通常是 main） */
  target: string;
  /** 来源分支（支线） */
  source: string;
  /** 共同祖先提交；没有共同祖先时为 undefined（两棵独立历史） */
  mergeBase?: string;
  chapters: ChapterChange[];
  /** 有冲突的章节数 */
  conflicts: number;
  /** 可直接采用的章节数 */
  takeable: number;
  /** 总字数变化 */
  totalDelta: number;
}

/** 作者对某一章的处置 */
export type MergeAction = "take-source" | "keep-target" | "delete";

export interface MergeDecision {
  file: string;
  action: MergeAction;
}

/* ============================================================
 * 分支列表
 * ============================================================ */

/** git 的默认分支名探测顺序（master 是旧默认，main 是新默认） */
const DEFAULT_BRANCHES = ["main", "master"];

/**
 * 列出分支，并标出相对基准的领先/落后。
 *
 * `for-each-ref` 一次拿全，避免 N 个分支起 N 次 git 进程。
 * 格式用 %00 分隔而不是空格：分支名可以含空格（「林晚照 线」），
 * 空格分隔会把它劈成两段，于是解析出不存在的时间戳。
 */
export async function listBranches(exec: ExecFn, root: string, base?: string): Promise<BranchInfo[]> {
  const baseRef = base ?? (await detectDefaultBranch(exec, root));
  const fmt = ["%(refname)", "%(refname:short)", "%(objectname)", "%(committerdate:iso-strict)"].join("%00");
  const r = await exec(["for-each-ref", `--format=${fmt}`, "refs/heads/"], { cwd: root });
  if (r.code !== 0) return [];

  const current = await currentBranch(exec, root);
  const out: BranchInfo[] = [];

  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [ref, name, commit, committedAt] = line.split("\0");
    if (!ref || !name || !commit) continue;

    let ahead = 0;
    let behind = 0;
    if (baseRef && name !== baseRef) {
      const counts = await exec(["rev-list", "--left-right", "--count", `${baseRef}...${name}`], { cwd: root });
      if (counts.code === 0) {
        // 输出形如 "3\t5"：左边是 base 独有（behind），右边是 name 独有（ahead）
        const [b, a] = counts.stdout.trim().split(/\s+/);
        behind = Number(b) || 0;
        ahead = Number(a) || 0;
      }
    }

    out.push({
      name,
      ref,
      commit,
      committedAt: committedAt ?? "",
      ahead,
      behind,
      current: name === current,
    });
  }

  // 当前分支排最前，其余按名字
  return out.sort((a, b) => (a.current === b.current ? a.name.localeCompare(b.name) : a.current ? -1 : 1));
}

/** 当前检出的分支；分离 HEAD 时返回 undefined */
export async function currentBranch(exec: ExecFn, root: string): Promise<string | undefined> {
  const r = await exec(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
  return r.code === 0 ? r.stdout.trim() || undefined : undefined;
}

/** 探测默认分支：main 优先，其次 master，再退到当前分支 */
export async function detectDefaultBranch(exec: ExecFn, root: string): Promise<string | undefined> {
  for (const name of DEFAULT_BRANCHES) {
    const r = await exec(["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`], { cwd: root });
    if (r.code === 0 && r.stdout.trim()) return name;
  }
  return currentBranch(exec, root);
}

/* ============================================================
 * 两分支比较
 * ============================================================ */

/**
 * 比较两个分支的章节差异。
 *
 * 四类判断完全基于「三方比较」（base / target / source）：
 *
 *   base==target && base!=source  → 只有来源改了，可采纳
 *   base==source && base!=target  → 只有目标改了，保留
 *   base==target==source          → 没变
 *   target==source（且 != base）  → 两边改成一样的，无需动作
 *   其余                          → 真冲突
 *
 * 少了 base 这一维就会把「只有来源改了」误判成冲突——那是协作里最常见、
 * 也最不该烦人的情况（对方写了一章，我完全没碰）。
 */
export async function compareBranches(
  exec: ExecFn,
  root: string,
  target: string,
  source: string,
  /** 作品相对仓库根的路径前缀 */
  prefix = "",
): Promise<MergeComparison> {
  const baseOut = await exec(["merge-base", target, source], { cwd: root });
  const mergeBase = baseOut.code === 0 ? baseOut.stdout.trim() || undefined : undefined;

  // 两边相对 base 的改动文件。没有 base 时（两棵独立历史）两边全部算改动。
  const targetFiles = await changedFilesSince(exec, root, mergeBase, target);
  const sourceFiles = await changedFilesSince(exec, root, mergeBase, source);

  // 只看作品目录内的 Markdown
  const relevant = (f: string): boolean => {
    if (!f.toLowerCase().endsWith(".md")) return false;
    return !f.split("/").some((seg) => seg.startsWith("."));
  };
  const within = (f: string): boolean => (prefix ? f.startsWith(prefix) : true);

  const files = new Set(
    [...targetFiles, ...sourceFiles].filter((f) => relevant(f) && within(f)),
  );

  const chapters: ChapterChange[] = [];
  for (const file of [...files].sort()) {
    const [baseText, targetText, sourceText] = await Promise.all([
      mergeBase ? readAt(exec, root, mergeBase, file) : Promise.resolve(undefined),
      readAt(exec, root, target, file),
      readAt(exec, root, source, file),
    ]);

    const verdict = decideVerdict(baseText, targetText, sourceText);
    if (verdict === "identical") continue;

    const targetChars = charCount(targetText);
    const sourceChars = charCount(sourceText);
    chapters.push({
      file: prefix ? file.slice(prefix.length) : file,
      verdict,
      targetChars,
      sourceChars,
      baseChars: charCount(baseText),
      delta: sourceChars - targetChars,
      title: chapterTitle(sourceText ?? targetText, file),
    });
  }

  return {
    target,
    source,
    mergeBase,
    chapters,
    conflicts: chapters.filter((c) => c.verdict === "conflict").length,
    takeable: chapters.filter((c) => c.verdict === "take-source").length,
    totalDelta: chapters.reduce((s, c) => s + c.delta, 0),
  };
}

/** 三方判定（纯逻辑，单独导出便于测试） */
export function decideVerdict(
  base: string | undefined,
  target: string | undefined,
  source: string | undefined,
): ChapterVerdict {
  const b = base ?? null;
  const t = target ?? null;
  const s = source ?? null;

  // ── 来源没有这一章 ──
  if (s === null) {
    if (t === null) return "identical"; // 两边都没有
    // 目标新增、来源从来没有 → 与本分支无关，保留
    if (b === null) return "keep-target";
    // 来源删掉了曾经有的一章
    return "deleted-in-source";
  }

  // ── 目标没有这一章 ──
  if (t === null) {
    if (b === null) {
      // 来源新增、目标从来没有 → 协作里最常见的情况，直接采用。
      // 这里判成 conflict 会让每一次「对方新写了一章」都变成待决策，
      // 分工合写就彻底没意义了。
      return "take-source";
    }
    // 目标删了、来源改过 → 要不要复活，人定
    return "recreated";
  }

  if (t === s) {
    // 内容一致就是无需动作：无论是两边都没动，还是两边改成了一样的
    return "identical";
  }

  if (b === t) return "take-source"; // 只有来源改了
  if (b === s) return "keep-target"; // 只有目标改了

  // 两边都从 base 出发改成了不同内容 → 真冲突
  return "conflict";
}

/** 某分支上某文件的全文；不存在返回 undefined */
async function readAt(
  exec: ExecFn,
  root: string,
  rev: string,
  repoPath: string,
): Promise<string | undefined> {
  const r = await exec(["show", `${rev}:${repoPath}`], { cwd: root, timeoutMs: 30_000 });
  return r.code === 0 ? r.stdout : undefined;
}

/** 相对 base 改动的文件（含新增、修改、删除）；base 为空则列出该提交全部文件 */
async function changedFilesSince(
  exec: ExecFn,
  root: string,
  base: string | undefined,
  rev: string,
): Promise<string[]> {
  const args = base
    ? ["diff", "--name-only", "--no-renames", base, rev]
    : ["ls-tree", "-r", "--name-only", rev];
  const r = await exec(args, { cwd: root, timeoutMs: 30_000 });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/**
 * 字符数。
 *
 * 用 `[...s].length` 而不是 `s.length`：后者数的是 UTF-16 码元，
 * emoji 和部分生僻字（𠮷、扩展 B 区汉字）会被算成两个，
 * 字数统计和进度条会凭空虚高。
 */
export function charCount(text: string | undefined): number {
  if (!text) return 0;
  // 去掉 Markdown 结构标记再数，贴近作者心里的「字数」
  const plain = text
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "") // frontmatter
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "");
  return [...plain.replace(/\s/g, "")].length;
}

/** 章节标题：取第一个一级标题，否则用文件名 */
export function chapterTitle(text: string | undefined, file: string): string {
  if (text) {
    const m = text.match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
  }
  return path.posix.basename(file).replace(/\.md$/i, "");
}

/* ============================================================
 * 合并计划
 * ============================================================ */

export interface MergePlanItem extends ChapterChange {
  /** 建议动作 */
  suggested: MergeAction;
  /** 需要作者确认（冲突与复活） */
  needsDecision: boolean;
}

/**
 * 生成合并计划：逐章给出建议动作。
 *
 * 建议不是「替他决定」，是「把无争议的挑出来」——冲突章节一律
 * needsDecision，不会被静默采用。
 */
export function planMerge(cmp: MergeComparison): MergePlanItem[] {
  return cmp.chapters.map((c) => {
    switch (c.verdict) {
      case "take-source":
        return { ...c, suggested: "take-source" as const, needsDecision: false };
      case "keep-target":
        return { ...c, suggested: "keep-target" as const, needsDecision: false };
      case "deleted-in-source":
        // 来源删了：默认保留目标的版本（删除比保留更难撤销）
        return { ...c, suggested: "keep-target" as const, needsDecision: true };
      case "recreated":
        return { ...c, suggested: "keep-target" as const, needsDecision: true };
      case "conflict":
      case "identical":
      default:
        return { ...c, suggested: "keep-target" as const, needsDecision: true };
    }
  });
}

/* ============================================================
 * 执行合并
 * ============================================================ */

export interface ApplyMergeInput {
  /** 来源分支 */
  source: string;
  /** 目标分支的 ref（refs/heads/main 或 refs/novelpad/...） */
  targetRef: string;
  /** 作者的逐章决定 */
  decisions: readonly MergeDecision[];
  /** 提交信息前的人话摘要，如「合并 林晚照 线」 */
  summary: string;
  /** 作品相对仓库根的前缀 */
  prefix?: string;
}

export interface ApplyMergeResult {
  ok: boolean;
  /** 产生的新提交；无改动时为空 */
  commit?: string;
  /** 实际写入的章节数 */
  written: number;
  /** 无改动（所有决定都是保留目标） */
  empty?: boolean;
  error?: string;
}

/**
 * 把来源分支的选定章节写进目标分支。
 *
 * 做法：**在工作区落地文件，再用 createSnapshot 造提交**。
 * 不走 `git merge` / `cherry-pick`：
 *
 *   - `merge` 会把两个分支的历史缠成一个，作者的时间线上突然出现
 *     一条他没写过的分支；而我们的时间线是按 ref 读快照的。
 *   - `cherry-pick` 是提交级粒度，无法按章挑选。
 *   - 用 createSnapshot 造的是一个**干净的单父提交**，正好符合
 *     「这次合并就是一次新存档」的语义，也天然记进时间线。
 *
 * 代价是必须先改工作区文件。这一步在扩展侧做（它持有编辑器和文件监听），
 * 内核只负责算出「该取哪一版」。所以这个函数接收**已落盘的工作区**，
 * 只做提交。
 */
export async function applyMerge(
  exec: ExecFn,
  root: string,
  input: ApplyMergeInput,
  /** 由调用方提供：把某章写成来源分支的版本 / 删掉 */
  materialize: (file: string, action: MergeAction) => Promise<void>,
): Promise<ApplyMergeResult> {
  const writable = input.decisions.filter((d) => d.action !== "keep-target");
  if (!writable.length) return { ok: true, written: 0, empty: true };

  try {
    for (const d of writable) await materialize(d.file, d.action);
  } catch (e) {
    return { ok: false, written: 0, error: `写入文件失败：${e instanceof Error ? e.message : String(e)}` };
  }

  const paths = writable.map((d) => (input.prefix ? `${input.prefix}${d.file}` : d.file));

  // 目标 ref 可能还不存在（第一次合并到一条新支线）。此时没有树可作基底，
  // 只能从空树起步——那种情况下目标分支本来就是空的，不存在丢文件的问题。
  const baseExists = await refExists(exec, root, input.targetRef);

  const snap = await createSnapshot(exec, root, {
    message: `${input.summary}\n\n来源：${input.source}\n章节：${writable.length}`,
    paths,
    ref: input.targetRef,
    // 接目标 ref 的顶端，让时间线看起来是「接在后面的一版」
    parent: input.targetRef,
    // **必须带 base**：从目标 ref 的整棵树起步，把本次选定的章节叠加进去。
    // 不带的话写出的树只含这几章，分支上其余章节会从历史里消失——
    // 实测过：合并一章后 ls-tree 只剩那一章。
    ...(baseExists ? { base: input.targetRef } : {}),
  });

  if (!snap.ok) return { ok: false, written: 0, error: snap.error };
  if (snap.empty) return { ok: true, written: 0, empty: true, commit: snap.commit };
  return { ok: true, commit: snap.commit, written: writable.length };
}

/* ============================================================
 * 冲突章节的双版对照
 * ============================================================ */

export interface ChapterComparison {
  file: string;
  targetText: string;
  sourceText: string;
  targetChars: number;
  sourceChars: number;
}

/**
 * 取某章在两个分支上的全文，供人工挑选。
 *
 * 不返回行级/段落级 diff：计划里明确「显示两版全文，人工挑选段落」。
 * 双栏 diff 在散文上会让作者不停左右对照，实际效率低于直接读两遍。
 * 段落级 diff 留给「同一分支的历史版本对比」（时间线用）。
 */
export async function chapterComparison(
  exec: ExecFn,
  root: string,
  target: string,
  source: string,
  /** 作品相对路径 */
  file: string,
  prefix = "",
): Promise<ChapterComparison> {
  const repoPath = prefix ? `${prefix}${file}` : file;
  const [t, s] = await Promise.all([
    readAt(exec, root, target, repoPath),
    readAt(exec, root, source, repoPath),
  ]);
  return {
    file,
    targetText: t ?? "",
    sourceText: s ?? "",
    targetChars: charCount(t),
    sourceChars: charCount(s),
  };
}