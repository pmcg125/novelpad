/**
 * 支线 worktree —— 分工合写（共创 B）的目录层。
 *
 * 计划 §5.2：新建支线时 `git worktree add` 到 `<作品>-<支线名>`，
 * 独立目录、独立窗口。**用 worktree 而不是 checkout**：作者在支线写
 * 到一半切回主线时，checkout 会把他支线的文件全部换掉，他打开的那个
 * 窗口内容突然变了；worktree 是两个真实目录，各自开着窗口，互不干扰。
 *
 * 这一层只算「要在哪个路径、用哪些参数」，不执行 vscode 操作：
 *   - 纯函数便于测试（Windows 路径大小写、非法字符、重名）
 *   - 执行由 features/branches.ts 做，那里才有 vscode
 */
import path from "node:path";
import type { ExecFn } from "@novelpad/core";

/** 分支名前缀约定：line/ = POV 支线，alt/ = 备选走向 */
export const BRANCH_PREFIXES = ["line", "alt"] as const;
export type BranchPrefix = (typeof BRANCH_PREFIXES)[number];

/** 全角括号、全角标点这类字符在 Windows 路径里其实合法，但作者看到
 *  worktree 目录叫「第七结局（备选）」会觉得奇怪，也会让路径显得杂乱。
 *  归一到 ASCII 的对应形式。 */
const WIDE_MAP: Record<string, string> = {
  "（": "(",
  "）": ")",
  "【": "[",
  "】": "]",
  "〔": "[",
  "〕": "]",
  "「": "",
  "」": "",
  "『": "",
  "』": "",
  "《": "",
  "》": "",
  "〈": "",
  "〉": "",
  "“": "",
  "”": "",
  "‘": "",
  "’": "",
};

/**
 * 把作者输入的中文支线名变成合法分支名。
 *
 * git 的分支名规则（check-ref-format）比想象中严：不允许空格、`~^:?*[`、
 * 不允许 `..`、不能以 `.` 或 `/` 结尾、不能以 `-` 开头。作者会输入
 * 「林晚照 线」「第七结局（备选）」这种，所以必须清洗。
 *
 * 保留中文：git 完全支持 UTF-8 分支名，中文分支名在 `git branch`
 * 里可读性远好于拼音或哈希，这是给作者看的。
 */
export function sanitizeBranchName(input: string): string {
  let s = input.trim();
  // 全角标点先归一，否则下面按 ASCII 删的时候漏掉它们
  for (const [from, to] of Object.entries(WIDE_MAP)) {
    s = s.split(from).join(to);
  }
  // 空白折成 -
  s = s.replace(/\s+/g, "-");
  // git 明确禁止的字符
  s = s.replace(/[~^:?*[\]\\]/g, "");
  // 括号、引号、尖括号这类在 Windows 路径里也非法（worktree 目录要用它）
  s = s.replace(/[()<>"|]/g, "");
  // 连续的点会构成 ..，单独的点也不能出现在开头/结尾
  s = s.replace(/\.{2,}/g, ".");
  // 连续斜杠、首尾斜杠
  s = s.replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  // 以 - 开头是 git 禁止的
  s = s.replace(/^-+/, "");
  // 每段首尾不能是 . 或 /
  s = s
    .split("/")
    .map((seg) => seg.replace(/^\.+/, "").replace(/\.+$/, ""))
    .filter(Boolean)
    .join("/");
  return s;
}

/** 完整分支名：<前缀>/<名字> */
export function fullBranchName(prefix: BranchPrefix | string, name: string): string {
  const clean = sanitizeBranchName(name);
  return `${prefix}/${clean}`;
}

/**
 * worktree 的落地目录。
 *
 * 放在作品目录**外面**、与它平级：`<作品>-<支线>`。
 * 放里面会让支线目录被主线仓库跟踪（除非写 .gitignore），
 * 而写 .gitignore 又意味着作者在主线里看不到它、也不知道自己有过支线。
 */
export function worktreePath(projectRoot: string, branchName: string): string {
  const parent = path.dirname(projectRoot);
  const base = path.basename(projectRoot);
  // 分支名里的 / 换成 -：worktree 目录要是一层，不能嵌套
  const flat = branchName.replace(/[/\\]/g, "-").replace(/^\.+/, "");
  return path.join(parent, `${base}-${flat}`);
}

/**
 * 名字是否可用（不含扩展逻辑，只判「能不能直接用」）。
 * 返回 undefined 表示可用，否则是给作者看的原因。
 */
export function whyNameUnusable(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return "名字不能为空";
  const clean = sanitizeBranchName(raw);
  if (!clean) return "这个名字清洗后什么都不剩，换一个";
  if (clean !== raw.replace(/\s+/g, "-")) {
    // 不算错误，但要告诉作者实际会用什么名字
    return undefined;
  }
  return undefined;
}

/**
 * 名字清洗后与作者输入不同时为 true，用于界面上「将保存为 xxx」提示。
 *
 * 注意空格折成连字符**也算改动**——作者输入「林晚照 线」，实际建出来的
 * 是「林晚照-线」，不提示的话他会找不到自己的分支。
 */
export function isRenamed(input: string): boolean {
  const raw = input.trim();
  if (!raw) return false;
  return sanitizeBranchName(raw) !== raw;
}

/**
 * 分支名 → 作者看得懂的名字。
 *
 * `line/林晚照` → `林晚照`（人物线就是他起的名字）
 * `alt/第七结局` → `备选：第七结局`（备选走向需要和人物线区分开，
 *   否则作者看到「第七结局」会以为是另一条人物线）
 *
 * 二级命名（`line/第一卷/林晚照`）保留后半段，因为卷名是有意义的定位信息。
 */
export function prettyBranch(name: string): string {
  const slash = name.indexOf("/");
  if (slash < 0) return name;
  const prefix = name.slice(0, slash);
  const tail = name.slice(slash + 1);
  if (prefix === "alt") return `备选：${tail}`;
  if (prefix === "line") return tail;
  // 未知前缀原样返回：作者手工建的分支不该被我们瞎解释
  return name;
}

/* ============================================================
 * worktree 列表
 * ============================================================ */

export interface WorktreeInfo {
  /** 目录绝对路径 */
  dir: string;
  /** 检出的分支短名；分离 HEAD 时为 undefined */
  branch?: string;
  /** 该提交短哈希 */
  commit: string;
  /** 是否为主工作区（作品根本身） */
  main: boolean;
  /** 目录当前是否存在（作者可能手工删了） */
  exists: boolean;
}

/**
 * 解析 `git worktree list --porcelain`。
 *
 * porcelain 格式是「空行分隔的记录、每条若干 `key value` 行」。
 * 不用普通 `git worktree list`：它的列宽按最长路径对齐，
 * 路径里含空格时靠列位置切分会切错——而作品目录叫「我的小说 第一部」
 * 是很常见的。
 */
export function parseWorktreeList(stdout: string, projectRoot?: string): WorktreeInfo[] {
  const out: WorktreeInfo[] = [];
  for (const block of stdout.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let dir: string | undefined;
    let branch: string | undefined;
    let commit = "";
    let bare = false;
    let detached = false;

    for (const line of block.split(/\r?\n/)) {
      const sp = line.indexOf(" ");
      const key = sp < 0 ? line : line.slice(0, sp);
      const value = sp < 0 ? "" : line.slice(sp + 1);
      if (key === "worktree") dir = value;
      else if (key === "HEAD") commit = value;
      else if (key === "branch") branch = value.replace(/^refs\/heads\//, "");
      else if (key === "bare") bare = true;
      else if (key === "detached") detached = true;
    }

    if (!dir || bare) continue;
    out.push({
      dir,
      branch: detached ? undefined : branch,
      commit: commit.slice(0, 7),
      main: projectRoot ? samePath(dir, projectRoot) : out.length === 0,
      exists: true,
    });
  }
  return out;
}

/**
 * 路径是否指向同一位置。
 *
 * Windows 上盘符大小写、正反斜杠、末尾斜杠都会让字符串比较失败，
 * 而 git 输出的路径格式与我们拼出来的未必一致。比较前统一归一化。
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
    // 盘符统一小写（C: 与 c: 是同一个盘）
    s = s.replace(/^([A-Za-z]):/, (_m, d: string) => `${d.toLowerCase()}:`);
    return s;
  };
  // Windows 文件系统不区分大小写；Linux 区分，但两个路径都来自 git 输出
  // 和 path.dirname，比较时大小写差异只可能出现在盘符，已单独处理
  return norm(a) === norm(b);
}

/* ============================================================
 * 与 git 对话
 * ============================================================ */

export interface AddWorktreeResult {
  ok: boolean;
  dir?: string;
  error?: string;
}

/**
 * 新建支线并加 worktree。
 *
 * 先 `worktree add -b <branch> <dir>` —— 它一步完成「建分支 + 检出到
 * 新目录」。刻意不加 `--no-checkout`：作者要的是「打开就能写」，
 * 空目录会让他以为搞砸了。
 *
 * 若分支已存在（作者之前建过、后来删了目录），退化为 `worktree add <dir> <branch>`，
 * 检出已有分支而不是报错。
 */
export async function addWorktree(
  exec: ExecFn,
  projectRoot: string,
  branch: string,
): Promise<AddWorktreeResult> {
  const dir = worktreePath(projectRoot, branch);

  const created = await exec(["worktree", "add", "-b", branch, dir], { cwd: projectRoot, timeoutMs: 60_000 });
  if (created.code === 0) return { ok: true, dir };

  // 先分清失败原因。两种 "already exists" 处理方式完全不同：
  //   「a branch named 'x' already exists」→ 分支在，检出它（不新建）
  //   「'<dir>' already exists」            → 目录占了，加 --force 覆盖
  //
  // 判断顺序很重要：两者都含 "already exists"，先判分支的话，
  // 目录冲突会被误当成分支冲突，然后 `worktree add <dir> <branch>`
  // 又因为目录存在再失败一次，作者看到的是「分支已存在」——
  // 一个完全不相关的错误。
  const branchTaken = /branch named .* already exists/i.test(created.stderr);
  const dirTaken = /already exists|not an empty directory/i.test(created.stderr);

  if (branchTaken) {
    const existing = await exec(["worktree", "add", dir, branch], { cwd: projectRoot, timeoutMs: 60_000 });
    if (existing.code === 0) return { ok: true, dir };
    if (!/already exists|not an empty directory/i.test(existing.stderr)) {
      return { ok: false, error: existing.stderr.trim() };
    }
    // 分支和目录都被占：强制检出已有分支到该目录
    const forced = await exec(["worktree", "add", "--force", dir, branch], { cwd: projectRoot, timeoutMs: 60_000 });
    if (forced.code === 0) return { ok: true, dir };
    return { ok: false, error: forced.stderr.trim() };
  }

  if (dirTaken) {
    const forced = await exec(["worktree", "add", "-b", branch, dir, "--force"], {
      cwd: projectRoot,
      timeoutMs: 60_000,
    });
    if (forced.code === 0) return { ok: true, dir };
    return { ok: false, error: forced.stderr.trim() };
  }

  return { ok: false, error: created.stderr.trim() || "git worktree add 失败" };
}

/**
 * 移除 worktree。
 *
 * 不传 `--force`：作者在支线里还有未提交的改动时，git 会拒绝，
 * 那个拒绝是**保护**，不该被我们绕过。调用方据此提示作者先提交。
 */
export async function removeWorktree(
  exec: ExecFn,
  projectRoot: string,
  dir: string,
  opts: { force?: boolean } = {},
): Promise<{ ok: boolean; error?: string }> {
  const args = ["worktree", "remove", dir];
  if (opts.force) args.push("--force");
  const r = await exec(args, { cwd: projectRoot, timeoutMs: 60_000 });
  if (r.code === 0) return { ok: true };
  return { ok: false, error: r.stderr.trim() || "git worktree remove 失败" };
}

/** 列出 worktree，并标出哪些目录已经不在了 */
export async function listWorktrees(
  exec: ExecFn,
  projectRoot: string,
  exists: (dir: string) => boolean,
): Promise<WorktreeInfo[]> {
  const r = await exec(["worktree", "list", "--porcelain"], { cwd: projectRoot });
  if (r.code !== 0) return [];
  return parseWorktreeList(r.stdout, projectRoot).map((w) => ({ ...w, exists: exists(w.dir) }));
}