/**
 * 支线内核单测。
 *
 * 重点在**未出生分支**：作者从没用过 git 是常态，我们的仓库是静默初始化的。
 * 这里每一条都对应一个「看起来成功、实际丢稿」的场景。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createBranch,
  deleteBranch,
  ensureBaseline,
  excludeLocalIndex,
  pruneWorktrees,
  unbornBranch,
  unmergedCommits,
  worktreeDirty,
} from "./branch.js";
import type { ExecFn } from "./repo.js";

const pexec = promisify(execFile);

const exec: ExecFn = async (args, opts) => {
  try {
    const { stdout, stderr } = await pexec("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === "number" ? err.code : 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
    };
  }
};

let root: string;

async function git(...args: string[]): Promise<string> {
  const r = await exec(args, { cwd: root });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr}`);
  return r.stdout;
}

function write(rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "np-branch-"));
  await git("init", "-q", "-b", "main");
  await git("config", "core.autocrlf", "false");
  // 故意**不**建任何提交：模拟作者从没用过 git
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("unbornBranch", () => {
  it("从没提交过时认出未出生分支（作者从没用过 git 的常态）", async () => {
    expect(await unbornBranch(exec, root)).toBe("main");
  });

  it("有提交后返回 undefined", async () => {
    write("chapters/001.md", "# 第一章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    expect(await unbornBranch(exec, root)).toBeUndefined();
  });

  it("分离 HEAD 时返回 undefined（不该去补什么基线）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const head = (await git("rev-parse", "HEAD")).trim();
    await git("checkout", "-q", "--detach", head);
    expect(await unbornBranch(exec, root)).toBeUndefined();
  });
});

describe("ensureBaseline", () => {
  it("未出生分支补上基线，内容包含此刻全部文件", async () => {
    write("chapters/001.md", "# 第一章 起点\n\n雨落在瓦上。\n");
    write("lore/characters/lin.md", "# 林晚照\n\n设定。\n");

    const r = await ensureBaseline(exec, root);
    expect(r.created).toBe(true);
    expect(r.commit).toBeTruthy();

    // 分支真的出现了
    const verify = await exec(["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"], { cwd: root });
    expect(verify.code).toBe(0);

    // 内容齐全：不能只提交一部分，否则支线一开就缺章
    const listed = (await git("ls-tree", "-r", "--name-only", "main")).trim().split("\n");
    expect(listed).toContain("chapters/001.md");
    expect(listed).toContain("lore/characters/lin.md");
  });

  it("已有提交时什么都不做（不能把作者的历史推倒重来）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const before = (await git("rev-parse", "HEAD")).trim();

    const r = await ensureBaseline(exec, root);
    expect(r.created).toBe(false);
    expect((await git("rev-parse", "HEAD")).trim()).toBe(before);
  });

  it("不碰作者的暂存区之外的内容：工作区文件一个字都不动", async () => {
    write("chapters/001.md", "# 第一章 原文\n");
    write("chapters/002.md", "# 第二章 原文\n");
    await git("add", "chapters/001.md");

    await ensureBaseline(exec, root);

    // 造基线是把「此刻的工作区」整体变成一个提交，作者已暂存的内容
    // 自然被这个提交吸收——这无法避免，也不该避免（否则基线不完整）。
    // 真正要守住的是：**文件内容不被改写**。
    expect(fs.readFileSync(path.join(root, "chapters/001.md"), "utf8")).toContain("第一章 原文");
    expect(fs.readFileSync(path.join(root, "chapters/002.md"), "utf8")).toContain("第二章 原文");
  });

  it("补完基线后工作区不留脏改动（否则作者一打开就看到一堆未提交）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const status = (await git("status", "--porcelain")).trim();
    expect(status).toBe("");
  });
});

describe("createBranch", () => {
  it("在未出生仓库里建支线：先补基线，支线内容与主线一致", async () => {
    write("chapters/001.md", "# 第一章\n");
    const r = await createBranch(exec, root, "line/林晚照");
    expect(r.ok).toBe(true);
    expect(r.baseline).toBe(true);

    const content = await git("show", "line/林晚照:chapters/001.md");
    expect(content).toContain("第一章");
  });

  it("已有基线时不再重复补", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const r = await createBranch(exec, root, "line/x");
    expect(r.ok).toBe(true);
    expect(r.baseline).toBe(false);
  });

  it("同名分支已存在时返回成功（幂等，作者可能手滑点两次）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const first = await createBranch(exec, root, "line/x");
    const second = await createBranch(exec, root, "line/x");
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("中文分支名可用", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const r = await createBranch(exec, root, "line/林晚照线");
    expect(r.ok).toBe(true);
    const list = await git("branch", "--format=%(refname:short)");
    expect(list).toContain("line/林晚照线");
  });
});

describe("deleteBranch", () => {
  it("有未合并提交时 -d 会拒绝（保护作者的稿子）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    await git("checkout", "-q", "-b", "line/x");
    write("chapters/002.md", "# 第二章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "支线加章");
    await git("checkout", "-q", "main");

    const r = await deleteBranch(exec, root, "line/x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not fully merged|未合并/i);
  });

  it("force 才真的删掉（作者明确说「这条线不要了」）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    await git("checkout", "-q", "-b", "line/x");
    write("chapters/002.md", "# 第二章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "支线加章");
    await git("checkout", "-q", "main");

    const r = await deleteBranch(exec, root, "line/x", { force: true });
    expect(r.ok).toBe(true);
    const list = await git("branch", "--format=%(refname:short)");
    expect(list).not.toContain("line/x");
  });

  it("已合并的分支可以直接删", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    await git("branch", "line/x");
    const r = await deleteBranch(exec, root, "line/x");
    expect(r.ok).toBe(true);
  });

  it("不存在的分支给出 git 的原话", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const r = await deleteBranch(exec, root, "line/nope");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not found|不存在/i);
  });
});

describe("unmergedCommits", () => {
  it("数出支线上还没进主线的提交", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    await git("checkout", "-q", "-b", "line/x");
    write("chapters/002.md", "# 第二章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "加章1");
    write("chapters/003.md", "# 第三章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "加章2");
    await git("checkout", "-q", "main");

    expect(await unmergedCommits(exec, root, "line/x")).toBe(2);
  });

  it("已合并的支线返回 0", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    await git("branch", "line/x");
    expect(await unmergedCommits(exec, root, "line/x")).toBe(0);
  });

  it("分支不存在时不崩，返回 0", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    expect(await unmergedCommits(exec, root, "line/nope")).toBe(0);
  });
});

describe("excludeLocalIndex", () => {
  it("把版本索引写进 .git/info/exclude，不动作者的 .gitignore", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);

    // ensureBaseline 内部已经排除过一次，所以这里只验证结果本身
    const exclude = fs.readFileSync(path.join(root, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain(".novelpad/version/");

    // .gitignore 完全没被创建
    expect(fs.existsSync(path.join(root, ".gitignore"))).toBe(false);
  });

  it("重复调用不会重复写（幂等）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const second = await excludeLocalIndex(exec, root);
    expect(second).toBe(false);
  });

  it("排除后 snapshots.json 不再出现在 status 里", async () => {
    write("chapters/001.md", "# 第一章\n");
    write(".novelpad/version/snapshots.json", '{ "version": 1, "snapshots": [] }\n');
    await ensureBaseline(exec, root);
    await excludeLocalIndex(exec, root);
    const status = await git("status", "--porcelain");
    expect(status).not.toContain("snapshots.json");
  });

  it("批注文件不因 excludeLocalIndex 被排除（共创要共享它）", async () => {
    write("chapters/001.md", "# 第一章\n");
    write(".novelpad/annotations.jsonl", '{"id":"a1"}\n');
    await ensureBaseline(exec, root);
    await excludeLocalIndex(exec, root);

    // 用 check-ignore 直接问 git 的判定，比看 status 稳：
    // 基线提交已经把 annotations.jsonl 收进去了，status 自然干净，
    // 但「干净」不能证明它没被排除规则覆盖。
    const ignored = await exec(["check-ignore", "-v", ".novelpad/annotations.jsonl"], { cwd: root });
    expect(ignored.code).not.toBe(0);

    const tracked = await exec(["ls-files", "--error-unmatch", ".novelpad/annotations.jsonl"], { cwd: root });
    expect(tracked.code).toBe(0);
  });
});

describe("pruneWorktrees", () => {
  it("清掉目录已被删掉的 worktree 记录", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const dir = path.join(path.dirname(root), `${path.basename(root)}-line-x`);
    await git("worktree", "add", "-b", "line/x", dir);
    // 作者在资源管理器里直接删了目录
    fs.rmSync(dir, { recursive: true, force: true });

    const pruned = await pruneWorktrees(exec, root);
    expect(pruned).toBeGreaterThan(0);
    const list = await git("worktree", "list", "--porcelain");
    expect(list).not.toContain("line-x");
  });

  it("现存 worktree 不被清理（作者正在里面写）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const dir = path.join(path.dirname(root), `${path.basename(root)}-line-y`);
    await git("worktree", "add", "-b", "line/y", dir);
    try {
      const pruned = await pruneWorktrees(exec, root);
      expect(pruned).toBe(0);
      const list = await git("worktree", "list", "--porcelain");
      expect(list).toContain("line-y");
    } finally {
      await git("worktree", "remove", dir, "--force");
    }
  });
});

describe("worktreeDirty", () => {
  it("有未提交改动时为 true（删目录前必须问）", async () => {
    write("chapters/001.md", "# 第一章\n");
    await ensureBaseline(exec, root);
    const dir = path.join(path.dirname(root), `${path.basename(root)}-line-z`);
    await git("worktree", "add", "-b", "line/z", dir);
    try {
      expect(await worktreeDirty(exec, dir)).toBe(false);
      fs.writeFileSync(path.join(dir, "chapters", "002.md"), "# 新章\n", "utf8");
      expect(await worktreeDirty(exec, dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await pruneWorktrees(exec, root);
    }
  });

  it("目录不存在时不崩", async () => {
    expect(await worktreeDirty(exec, path.join(root, "nope"))).toBe(false);
  });
});