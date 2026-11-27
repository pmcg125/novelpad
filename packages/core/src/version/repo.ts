/**
 * 文章版 git 封装。
 *
 * 设计约束（见 docs/PLAN-VERSIONING.md）：
 *   - 不引入 simple-git，直接调 git CLI（体积 + 供应链）
 *   - 自动存档挂在**平行 ref 命名空间**，不污染 git log、不动 HEAD、不动 index 的分支指针
 *   - 全部命令走注入的 exec，测试里可换成假实现，不碰真实仓库
 *
 * 为什么「一个快照一个 ref」而不是「一章一条链」：
 *   链式 ref 想裁掉旧提交只能改写历史（graft / 重新造提交），代价高且危险；
 *   每个快照独立 ref，滚动就只是 `update-ref -d`，被删的提交变不可达，交给 git 回收。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoLayout, toRepoPath } from "./layout.js";

/* ============================================================
 * 命令执行（可注入）
 * ============================================================ */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  args: readonly string[],
  opts: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
) => Promise<ExecResult>;

/** 默认实现：execFile，带超时，永不抛异常（错误放进返回值） */
export const nodeExec: ExecFn = (args, { cwd, timeoutMs = 20_000, env }) =>
  new Promise((resolve) => {
    const fullEnv = env ? { ...process.env, ...env } : process.env;
    execFile(
      "git",
      args as string[],
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, env: fullEnv },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: number }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });

/* ============================================================
 * 常量
 * ============================================================ */

export const AUTO_REF_PREFIX = "refs/novelpad/auto/";
export const MILESTONE_REF_PREFIX = "refs/novelpad/milestone/";
export const PUBLISH_REF_PREFIX = "refs/novelpad/publish/";

/** 每个章节保留的自动存档数 */
export const AUTO_KEEP_PER_CHAPTER = 20;

/* ============================================================
 * 仓库检测
 * ============================================================ */

export interface GitAvailability {
  available: boolean;
  version?: string;
}

/** git 是否可用（作者机器可能没装） */
export async function detectGit(exec: ExecFn, cwd: string): Promise<GitAvailability> {
  const r = await exec(["--version"], { cwd, timeoutMs: 5_000 });
  if (r.code !== 0) return { available: false };
  const m = r.stdout.match(/git version (\S+)/);
  return { available: true, version: m?.[1] };
}

/** 作品根是否是 git 仓库（workspace 可能在子目录，所以要向上找） */
export async function isRepo(exec: ExecFn, root: string): Promise<boolean> {
  const r = await exec(["rev-parse", "--show-toplevel"], { cwd: root });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/**
 * 懒初始化：git init + 统一分支名。
 * 已存在仓库时什么都不做。
 */
export async function ensureRepo(exec: ExecFn, root: string): Promise<{ created: boolean; toplevel: string }> {
  const existing = await exec(["rev-parse", "--show-toplevel"], { cwd: root });
  if (existing.code === 0) {
    return { created: false, toplevel: existing.stdout.trim() || root };
  }
  await exec(["init"], { cwd: root });
  // 默认分支名统一成 main，避免作者换机器后看到 master/main 不一致
  await exec(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: root });
  return { created: true, toplevel: root };
}

/* ============================================================
 * ref 命名
 * ============================================================ */

/** 把任意字符串变成合法的 ref 路径分量 */
export function sanitizeRefComponent(s: string): string {
  return (
    s
      .trim()
      .replace(/[\s~^:?*[\\]+/g, "-")
      .replace(/\.{2,}/g, ".")
      .replace(/^[.-]+|[.-]+$/g, "")
      .replace(/\.lock$/, "")
      .slice(0, 80) || "default"
  );
}

/** 紧凑时间戳，用作 ref 末段，保证同一章节内按名称排序即时间序 */
export function stamp(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p(date.getMilliseconds(), 3)}`;
}

/** 自动存档 ref：refs/novelpad/auto/<章节>/<时间戳> */
export function autoRefName(chapterKey: string, at: Date = new Date()): string {
  return `${AUTO_REF_PREFIX}${sanitizeRefComponent(chapterKey)}/${stamp(at)}`;
}

export function milestoneRefName(id: string): string {
  return MILESTONE_REF_PREFIX + sanitizeRefComponent(id);
}

export function publishRefName(tag: string): string {
  return PUBLISH_REF_PREFIX + sanitizeRefComponent(tag);
}

/* ============================================================
 * 快照
 * ============================================================ */

export interface SnapshotInput {
  /** 提交信息（内部用，不给作者看） */
  message: string;
  /** 要纳入快照的路径（相对仓库根）；空数组 = 全部改动 */
  paths?: readonly string[];
  /** 挂到哪个 ref；不传则只造提交不挂 ref（由调用方决定） */
  ref?: string;
  /** 父提交：默认接 HEAD（里程碑用）；"none" 表示造独立根提交（自动存档用，便于精确裁剪） */
  parent?: string | "none";
  /**
   * 与哪个提交的树做去重比较（不成为父提交）。
   * 自动存档是独立根提交，没有父可比，所以要显式指定「上一版」。
   */
  dedupeAgainst?: string;
}

export interface SnapshotResult {
  ok: boolean;
  commit?: string;
  /** 内容与父提交完全一致，没有产生新提交 */
  empty?: boolean;
  error?: string;
}

/**
 * 创建快照。
 *
 * 用 `commit-tree` 而不是 `commit`：不移动 HEAD、不改分支指针，
 * 作者的分支历史保持干净；我们只在自己管理的 ref 上挂提交。
 */
export async function createSnapshot(exec: ExecFn, root: string, input: SnapshotInput): Promise<SnapshotResult> {
  const paths = input.paths && input.paths.length ? [...input.paths] : ["."];

  // 用**临时索引**暂存，不用作者的真实索引。三个理由：
  //
  // 1. 范围正确：`write-tree` 写出的是整个索引。作品位于仓库子目录时，
  //    真实索引里可能已有仓库其他文件，快照会把它们一起带走
  //    （端到端测试踩到过：快照里凭空多了仓库根的 unrelated.txt）。
  // 2. 不污染作者：往真实索引 `git add` 会改变他的 `git status`，
  //    甚至把半成品塞进他准备提交的内容里。工具不该动用户的暂存区。
  // 3. 可并发：临时索引是独立文件，不会和用户或其他窗口抢 index.lock。
  //
  // `read-tree --empty` 从空树开始，所以快照只含本次 add 进来的路径。
  const tmpIndex = path.join(
    os.tmpdir(),
    `novelpad-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const env = { GIT_INDEX_FILE: tmpIndex };
  const cleanup = () => {
    try {
      fs.rmSync(tmpIndex, { force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  };

  try {
    // 1) 空索引 → 暂存（-A 让删除也被记录）
    const reset = await exec(["read-tree", "--empty"], { cwd: root, env });
    if (reset.code !== 0) return { ok: false, error: reset.stderr.trim() || "git read-tree 失败" };

    const add = await exec(["add", "-A", "--", ...paths], { cwd: root, env });
    if (add.code !== 0) return { ok: false, error: add.stderr.trim() || "git add 失败" };

    // 2) 写出树对象
    const tree = await exec(["write-tree"], { cwd: root, env });
    if (tree.code !== 0) return { ok: false, error: tree.stderr.trim() || "git write-tree 失败" };
    return finishSnapshot(exec, root, input, tree.stdout.trim());
  } finally {
    cleanup();
  }
}

/** 造提交对象并挂 ref（与暂存无关的后半段） */
async function finishSnapshot(
  exec: ExecFn,
  root: string,
  input: SnapshotInput,
  treeId: string,
): Promise<SnapshotResult> {
  // 3) 父提交
  let parent: string | undefined;
  if (input.parent !== "none") {
    if (typeof input.parent === "string" && input.parent) {
      const r = await exec(["rev-parse", "--verify", "--quiet", input.parent + "^{commit}"], { cwd: root });
      if (r.code === 0 && r.stdout.trim()) parent = r.stdout.trim();
    } else {
      const h = await exec(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { cwd: root });
      if (h.code === 0 && h.stdout.trim()) parent = h.stdout.trim();
    }
  }

  // 4) 内容与参照提交相同 → 不产生新提交，避免时间线被空快照淹没
  const compareTo = input.dedupeAgainst || parent;
  if (compareTo) {
    const refTree = await exec(["rev-parse", compareTo + "^{tree}"], { cwd: root });
    if (refTree.code === 0 && refTree.stdout.trim() === treeId) {
      return { ok: true, commit: compareTo, empty: true };
    }
  }

  // 5) 造提交对象
  const args = ["commit-tree", treeId, "-m", input.message];
  if (parent) args.push("-p", parent);
  const commit = await exec(args, { cwd: root, timeoutMs: 30_000 });
  if (commit.code !== 0) return { ok: false, error: commit.stderr.trim() || "git commit-tree 失败" };
  const commitId = commit.stdout.trim();

  // 6) 挂 ref
  if (input.ref) {
    const upd = await exec(["update-ref", input.ref, commitId], { cwd: root });
    if (upd.code !== 0) return { ok: false, error: upd.stderr.trim() || "git update-ref 失败" };
  }

  return { ok: true, commit: commitId };
}

/* ============================================================
 * 读取
 * ============================================================ */

export interface RefInfo {
  /** 完整 ref 名 */
  name: string;
  commit: string;
  /** 提交时间 ISO；取不到时为空串 */
  time: string;
}

/**
 * 列出某个命名空间下的 ref，按提交时间新到旧。
 * 用 for-each-ref 一次取完，避免每个 ref 跑一次 log。
 */
export async function listRefs(exec: ExecFn, root: string, prefix: string): Promise<RefInfo[]> {
  const r = await exec(["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(creatordate:iso-strict)", prefix], { cwd: root });
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = "", commit = "", time = ""] = line.split("\u001f");
      return { name, commit, time };
    })
    .filter((x) => x.name)
    .sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : a.name < b.name ? 1 : -1));
}

export interface CommitInfo {
  commit: string;
  time: string;
  message: string;
}

/** 解析 `log --format=%H%x1f%cI%x1f%s%x00` 的输出 */
export function parseLog(stdout: string): CommitInfo[] {
  return stdout
    .split("\u0000")
    .map((s) => s.replace(/^\n+/, ""))
    .filter(Boolean)
    .map((rec) => {
      const [commit, time, ...rest] = rec.split("\u001f");
      return { commit: commit ?? "", time: time ?? "", message: rest.join("\u001f").trim() };
    })
    .filter((c) => c.commit.length > 0);
}

export async function logRef(exec: ExecFn, root: string, ref: string, limit = 50): Promise<CommitInfo[]> {
  const r = await exec(["log", "--format=%H%x1f%cI%x1f%s%x00", "-n", String(limit), ref, "--"], { cwd: root });
  if (r.code !== 0) return [];
  return parseLog(r.stdout);
}

/** 读某个提交里的文件内容；文件不存在返回 undefined */
export async function readFileAt(exec: ExecFn, root: string, commit: string, path: string): Promise<string | undefined> {
  const r = await exec(["show", `${commit}:${path}`], { cwd: root, timeoutMs: 30_000 });
  if (r.code !== 0) return undefined;
  return r.stdout;
}

/**
 * 从提交里读文件，路径相对**作品根**。
 *
 * `<rev>:<path>` 里的 path **永远相对提交树根**，与 cwd 无关。
 * 作品位于仓库子目录时，必须补上仓库前缀才能命中。
 * （与 `createSnapshot` 的 pathspec 相反——那条是相对 cwd，不能再补。）
 *
 * 补错的后果是静默的：git 返回非零，这里返回 undefined，
 * 界面于是显示「两版没有差异」——看起来正常，结果是错的。
 */
export async function readProjectFileAt(
  exec: ExecFn,
  root: string,
  commit: string,
  relFromProject: string,
): Promise<string | undefined> {
  const layout = await repoLayout(exec, root);
  const rel = layout ? toRepoPath(layout, relFromProject) : relFromProject;
  return readFileAt(exec, root, commit, rel);
}

/** 某提交改动了哪些文件（相对仓库根） */
export async function changedFiles(exec: ExecFn, root: string, commit: string): Promise<string[]> {
  const r = await exec(["show", "--pretty=format:", "--name-only", commit], { cwd: root });
  if (r.code !== 0) return [];
  return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/* ============================================================
 * 恢复
 * ============================================================ */

export interface RestoreResult {
  ok: boolean;
  error?: string;
  /** 恢复前自动打的保护快照，作者点错了还能回来 */
  guard?: string;
}

/**
 * 恢复到某提交。**先打保护快照**——这是这套系统的底线。
 */
export async function restoreTo(
  exec: ExecFn,
  root: string,
  commit: string,
  opts: { paths?: readonly string[]; guardRef?: string; guardMessage?: string } = {},
): Promise<RestoreResult> {
  const guard = await createSnapshot(exec, root, {
    message: opts.guardMessage ?? `novelpad: before-restore ${new Date().toISOString()}`,
    ref: opts.guardRef,
    parent: "none",
  });
  if (!guard.ok) return { ok: false, error: guard.error };

  const paths = opts.paths && opts.paths.length ? ["--", ...opts.paths] : [];
  // checkout 只动工作区文件，不动 HEAD
  const r = await exec(["checkout", commit, ...paths], { cwd: root, timeoutMs: 60_000 });
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "git checkout 失败", guard: guard.commit };
  return { ok: true, guard: guard.commit };
}

/* ============================================================
 * 滚动清理
 * ============================================================ */

/**
 * 某个章节的自动存档只保留最近 `keep` 个。
 * 返回被删掉的数量。
 */
export async function trimAutoRefs(
  exec: ExecFn,
  root: string,
  chapterKey: string,
  keep = AUTO_KEEP_PER_CHAPTER,
): Promise<number> {
  if (keep < 1) return 0;
  const prefix = `${AUTO_REF_PREFIX}${sanitizeRefComponent(chapterKey)}/`;
  const refs = await listRefs(exec, root, prefix);
  if (refs.length <= keep) return 0;
  let deleted = 0;
  for (const old of refs.slice(keep)) {
    if (await deleteRef(exec, root, old.name)) deleted++;
  }
  return deleted;
}

/** 删除自动存档 ref；里程碑与发布版不允许删 */
export async function deleteRef(exec: ExecFn, root: string, ref: string): Promise<boolean> {
  if (!ref.startsWith(AUTO_REF_PREFIX)) return false;
  const r = await exec(["update-ref", "-d", ref], { cwd: root });
  return r.code === 0;
}

/**
 * ref 是否已存在。
 * 用 `show-ref --verify`：不存在时退出码非 0，属于正常情况，不应当抛。
 */
export async function refExists(exec: ExecFn, root: string, ref: string): Promise<boolean> {
  const r = await exec(["show-ref", "--verify", "--quiet", ref], { cwd: root });
  return r.code === 0;
}

/** 全部自动存档（供时间线视图使用） */
export function autoRefs(exec: ExecFn, root: string): Promise<RefInfo[]> {
  return listRefs(exec, root, AUTO_REF_PREFIX);
}

/** 从自动存档 ref 名里取回章节 key */
export function chapterOf(ref: string): string {
  if (!ref.startsWith(AUTO_REF_PREFIX)) return "";
  const rest = ref.slice(AUTO_REF_PREFIX.length);
  const slash = rest.indexOf("/");
  return slash === -1 ? rest : rest.slice(0, slash);
}