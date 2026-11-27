/**
 * 支线（分工合写）的 git 层。
 *
 * 计划 §5.2：分支即分工，但分支名用人话（`line/林晚线`、`alt/第七结局`）。
 * 新建支线 = `git worktree add` 到 `<作品>-林晚线/`，独立目录、独立窗口。
 *
 * 这一层只管 git，不认识 vscode：
 *   - 执行由扩展侧 features/branches.ts 做
 *   - 纯函数在 features/worktree.ts（名字清洗、路径比较）
 */
import fs from "node:fs";
import path from "node:path";
import type { ExecFn } from "./repo.js";
import { createSnapshot } from "./repo.js";
import { repoLayout } from "./layout.js";

/* ============================================================
 * 未出生分支（作者从没用过 git）
 * ============================================================ */

/**
 * HEAD 是否指向一个还不存在的分支。
 *
 * 这是**常态**而不是异常：我们的仓库是静默初始化的，作者只写正文、
 * 从不提交，于是 `refs/heads/main` 从未被创建。此时：
 *   - 自动存档照样工作（它们挂在自己的 ref 上，不需要分支）
 *   - 但 `git worktree add -b line/x` 会 inferring '--orphan'，
 *     造出一个**空目录**——作者打开支线看到空白，以为稿子丢了
 *
 * 所以建支线前必须先补一个基线提交。
 */
export async function unbornBranch(exec: ExecFn, root: string): Promise<string | undefined> {
  // 先确认 HEAD 指向某个分支（不是分离 HEAD）
  const head = await exec(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
  const name = head.stdout.trim();
  if (head.code !== 0 || !name) return undefined;

  const exists = await exec(["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`], { cwd: root });
  return exists.code === 0 && exists.stdout.trim() ? undefined : name;
}

/**
 * 给未出生的分支补一个基线提交：把此刻的工作区全部内容提交上去。
 *
 * 用 createSnapshot 而不是 `git commit`：
 *   - 不必先 `git add`（会污染作者的暂存区）
 *   - 不必有 git 身份（内部有兜底）
 *   - 走的是同一条代码路径，行为一致
 *
 * 返回 undefined 表示「本来就有提交，无需补」。
 */
export async function ensureBaseline(
  exec: ExecFn,
  root: string,
  opts: { message?: string } = {},
): Promise<{ created: boolean; commit?: string; error?: string }> {
  const unborn = await unbornBranch(exec, root);
  if (!unborn) return { created: false };

  const layout = await repoLayout(exec, root);
  if (!layout) return { created: false, error: "作品不在 git 仓库内" };

  // 先排除本地索引再提交。反过来的话 snapshots.json 会进基线，
  // 之后把它排除掉，`git status` 就显示它「已被删除」——
  // 作者打开源代码管理面板会看到一条莫名其妙的删除记录。
  await excludeLocalIndex(exec, root);

  const res = await createSnapshot(exec, root, {
    message: opts.message ?? "NovelPad：建立基线",
    // 全部内容，包括设定与配置 —— 支线要能独立打开就写作
    paths: ["."],
    ref: `refs/heads/${unborn}`,
    // 独立根提交：这是仓库的第一个提交
    parent: "none",
  });

  if (!res.ok) return { created: false, error: res.error };

  // 把索引同步到刚造的提交上，否则 `git status` 会显示
  // 每个文件都是「已删除」——因为真实索引还是空的（快照用的是临时索引）。
  //
  // 只重置 cwd 下的路径：作品在仓库子目录时，`reset` 不带 pathspec
  // 会把仓库根其他文件的索引条目一起抹掉，作者会看到它们全部「被删除」。
  // 带 pathspec 的 reset **不移动 HEAD**，只是把匹配路径的索引条目
  // 设为该提交里的版本，恰好是我们要的。
  await exec(["reset", "--mixed", res.commit!, "--", "."], { cwd: root });

  return { created: true, commit: res.commit };
}

/**
 * 把版本索引排除出 git，但**不碰作者的 .gitignore**。
 *
 * `.novelpad/version/snapshots.json` 是本地缓存（坏了能从 ref 重建），
 * 每个 worktree 各有一份，跟踪它会让两个窗口互相覆盖。
 * 但 `.novelpad/annotations.jsonl` 必须随 git 走——那是共创的共享数据。
 *
 * 用 `.git/info/exclude` 而不是 `.gitignore`：后者是作者的文件，
 * 改它会在他的 `git status` 里冒出一条他没写过的改动。
 */
export async function excludeLocalIndex(exec: ExecFn, root: string): Promise<boolean> {
  const layout = await repoLayout(exec, root);
  if (!layout) return false;

  const gitDir = await exec(["rev-parse", "--git-dir"], { cwd: layout.toplevel });
  if (gitDir.code !== 0) return false;
  const dir = path.resolve(layout.toplevel, gitDir.stdout.trim());
  const file = path.join(dir, "info", "exclude");

  const lines = [".novelpad/version/", ".novelpad/index/", ".novelpad/cache/"];
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    const has = new Set(current.split(/\r?\n/).map((l) => l.trim()));
    const missing = lines.filter((l) => !has.has(l));
    if (!missing.length) return false;
    const next = current.endsWith("\n") || !current ? current : current + "\n";
    fs.writeFileSync(file, next + missing.join("\n") + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/* ============================================================
 * 分支操作
 * ============================================================ */

export interface CreateBranchResult {
  ok: boolean;
  /** 实际建出来的分支名 */
  branch?: string;
  /** 是否补了基线提交 */
  baseline?: boolean;
  error?: string;
}

/**
 * 建一条支线分支（不建 worktree）。
 *
 * 基线从哪来：**当前 HEAD**。作者在主线写，点「新建支线」是从此刻岔出去，
 * 而不是从某个更早的提交。当前分支未出生时先补基线提交——
 * 没有基线的支线等于从零开始，会丢掉作者已写的所有章节。
 */
export async function createBranch(exec: ExecFn, root: string, branch: string): Promise<CreateBranchResult> {
  const base = await ensureBaseline(exec, root);
  if (base.error) return { ok: false, error: base.error };

  // 不给起点 = 从 HEAD 岔出
  const r = await exec(["branch", branch], { cwd: root });
  if (r.code !== 0) {
    const msg = r.stderr.trim();
    if (/already exists/i.test(msg)) return { ok: true, branch, baseline: base.created };
    return { ok: false, error: msg || "git branch 失败" };
  }
  return { ok: true, branch, baseline: base.created };
}

/**
 * 删分支。
 *
 * 用 `-d` 而不是 `-D`：git 会在分支有未合并提交时拒绝，
 * 那个拒绝是保护——上面可能还有作者写的章节。强制删除只留给
 * 调用方明确要求（比如他自己确认「这条线不要了」）。
 */
export async function deleteBranch(
  exec: ExecFn,
  root: string,
  branch: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const r = await exec(["branch", opts.force ? "-D" : "-d", branch], { cwd: root });
  if (r.code === 0) return { ok: true };
  return { ok: false, error: r.stderr.trim() || "git branch 删除失败" };
}

/** 分支上是否还有未合并的提交（用于删分支前提示「这条线上还有 3 章」） */
export async function unmergedCommits(
  exec: ExecFn,
  root: string,
  branch: string,
  into = "HEAD",
): Promise<number> {
  const r = await exec(["rev-list", "--count", `${into}..${branch}`], { cwd: root });
  if (r.code !== 0) return 0;
  return Number(r.stdout.trim()) || 0;
}

/* ============================================================
 * worktree 清理
 * ============================================================ */

/**
 * 清理失效的 worktree 记录。
 *
 * 作者可能直接删目录（资源管理器里右键删除），此时 git 仍记着它，
 * 以后再想用同名目录会报 "already registered"。`git worktree prune`
 * 只清理**目录已经不在了**的记录，不动现存工作区，所以是安全的。
 */
export async function pruneWorktrees(exec: ExecFn, root: string): Promise<number> {
  const before = await exec(["worktree", "list", "--porcelain"], { cwd: root });
  const countBefore = before.code === 0 ? before.stdout.split(/\r?\n\r?\n/).filter((s) => s.trim()).length : 0;
  const r = await exec(["worktree", "prune"], { cwd: root });
  if (r.code !== 0) return 0;
  const after = await exec(["worktree", "list", "--porcelain"], { cwd: root });
  const countAfter = after.code === 0 ? after.stdout.split(/\r?\n\r?\n/).filter((s) => s.trim()).length : countBefore;
  return Math.max(0, countBefore - countAfter);
}

/**
 * worktree 里是否有未保存的改动。
 *
 * 用于「关掉这条支线」前的提示：有未提交内容就删目录，
 * 作者写的东西会**真的消失**（worktree 目录不在版本库里）。
 */
export async function worktreeDirty(exec: ExecFn, dir: string): Promise<boolean> {
  const r = await exec(["status", "--porcelain"], { cwd: dir });
  if (r.code !== 0) return false;
  return r.stdout.trim().length > 0;
}