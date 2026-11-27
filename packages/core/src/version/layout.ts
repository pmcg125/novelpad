/**
 * 作品根 → 仓库根的路径前缀。
 *
 * 为什么需要：git 命令里的路径全部相对**仓库根**（`git show <rev>:<path>`、
 * `git add -- <path>`），而 NovelPad 的所有业务路径都相对**作品根**
 * （`chapters/001.md`、`lore/characters/lin.md`）。
 *
 * 作者常见的目录布局是：
 *   ~/novel/            ← 作品根（.novelpad/ 在这里）
 *     chapters/
 *   ~/novel 本身是仓库根  → 前缀为 ""
 *   或者 ~/writing 是仓库根，作品在 ~/writing/novel/  → 前缀为 "novel/"
 *
 * 不处理这一层时，`git show <commit>:chapters/001.md` 会静默失败
 * （返回 undefined），于是 diff 界面上显示「两版没有差异」——
 * 一个看起来正常、实际错误的结果。这比报错更糟。
 */
import type { ExecFn } from "./repo.js";

export interface RepoLayout {
  /** 仓库根绝对路径 */
  toplevel: string;
  /** 作品根相对仓库根的前缀，"" 或 "sub/dir/"（总是以 / 结尾，空串除外） */
  prefix: string;
}

/**
 * 解析作品根与仓库根的关系。
 * 作品根不在仓库内时返回 undefined（此时不该做任何版本操作）。
 */
export async function repoLayout(exec: ExecFn, root: string): Promise<RepoLayout | undefined> {
  const r = await exec(["rev-parse", "--show-toplevel"], { cwd: root });
  if (r.code !== 0 || !r.stdout.trim()) return undefined;
  const toplevel = r.stdout.trim();

  // 用 git 自己的相对路径算法，避免 Windows 盘符大小写、分隔符、8.3 短名等差异。
  // --show-prefix 输出的就是「当前目录相对仓库根」的前缀，结尾带 /。
  const p = await exec(["rev-parse", "--show-prefix"], { cwd: root });
  if (p.code !== 0) return { toplevel, prefix: "" };
  const prefix = p.stdout.trim();
  return { toplevel, prefix: prefix ? (prefix.endsWith("/") ? prefix : `${prefix}/`) : "" };
}

/** 作品相对路径 → 仓库相对路径 */
export function toRepoPath(layout: RepoLayout, relFromRoot: string): string {
  const clean = relFromRoot.replace(/^\/+/, "").replace(/\\/g, "/");
  return layout.prefix ? `${layout.prefix}${clean}` : clean;
}

/** 仓库相对路径 → 作品相对路径（列文件、看改动时用） */
export function fromRepoPath(layout: RepoLayout, relFromRepo: string): string {
  const clean = relFromRepo.replace(/\\/g, "/");
  if (!layout.prefix) return clean;
  return clean.startsWith(layout.prefix) ? clean.slice(layout.prefix.length) : "";
}