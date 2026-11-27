/**
 * 支线 worktree 的纯逻辑单测。
 *
 * 重点在**名字清洗**与**路径比较**：这两处错了不会报错，只会让
 * 作者的支线建到奇怪的位置，或者「删除」删不掉。
 */
import { describe, expect, it } from "vitest";
import {
  addWorktree,
  fullBranchName,
  isRenamed,
  parseWorktreeList,
  removeWorktree,
  samePath,
  sanitizeBranchName,
  worktreePath,
  whyNameUnusable,
} from "./worktree.js";
import type { ExecFn } from "@novelpad/core";

describe("sanitizeBranchName", () => {
  it("保留中文（git 支持 UTF-8 分支名，可读性远好于拼音）", () => {
    expect(sanitizeBranchName("林晚照")).toBe("林晚照");
  });

  it("空格折成连字符（作者会输入「林晚照 线」）", () => {
    expect(sanitizeBranchName("林晚照 线")).toBe("林晚照-线");
  });

  it("去掉 git 禁止的字符", () => {
    expect(sanitizeBranchName("a~b^c:d?e*f[g]h\\i")).toBe("abcdefgh i".replace(" ", ""));
  });

  it("去掉 Windows 路径里非法的字符（worktree 目录要用它）", () => {
    // 全角括号先归一到 ASCII，再删掉
    expect(sanitizeBranchName("第七结局（备选）")).toBe("第七结局备选");
    expect(sanitizeBranchName("第七结局【备选】")).toBe("第七结局备选");
    expect(sanitizeBranchName('a<b>c"d|e')).toBe("abcde");
  });

  it("连续的点折成一个，避免构成 ..", () => {
    expect(sanitizeBranchName("v1..2")).toBe("v1.2");
  });

  it("首尾的点被去掉（git 不允许段以 . 开头/结尾）", () => {
    expect(sanitizeBranchName(".hidden.")).toBe("hidden");
  });

  it("去掉开头的连字符", () => {
    expect(sanitizeBranchName("-branch")).toBe("branch");
  });

  it("连续斜杠折成一个，首尾斜杠去掉", () => {
    expect(sanitizeBranchName("/a//b/")).toBe("a/b");
  });

  it("空输入返回空串", () => {
    expect(sanitizeBranchName("")).toBe("");
    expect(sanitizeBranchName("   ")).toBe("");
  });

  it("全是非法字符时返回空串（调用方要靠它拦住）", () => {
    expect(sanitizeBranchName("///")).toBe("");
    expect(sanitizeBranchName("()<>")).toBe("");
  });

  it("保留数字与常见标点", () => {
    expect(sanitizeBranchName("v2.1-结局")).toBe("v2.1-结局");
  });
});

describe("fullBranchName", () => {
  it("加前缀", () => {
    expect(fullBranchName("line", "林晚照")).toBe("line/林晚照");
    expect(fullBranchName("alt", "第七结局")).toBe("alt/第七结局");
  });

  it("名字里的斜杠保留，形成二级命名", () => {
    expect(fullBranchName("line", "第一卷/林晚照")).toBe("line/第一卷/林晚照");
  });
});

describe("worktreePath", () => {
  it("放在作品目录外面、与它平级", () => {
    const p = worktreePath("E:/novel", "line/林晚照");
    expect(p.replace(/\\/g, "/")).toBe("E:/novel-line-林晚照");
  });

  it("分支名里的斜杠拍平成一层（worktree 目录不能嵌套）", () => {
    const p = worktreePath("/home/me/book", "line/a/b").replace(/\\/g, "/");
    expect(p).toBe("/home/me/book-line-a-b");
  });

  it("不以作品目录为父目录（否则支线会被主线仓库跟踪）", () => {
    const root = "/x/novel";
    const p = worktreePath(root, "line/x").replace(/\\/g, "/");
    expect(p.startsWith(root + "/")).toBe(false);
  });
});

describe("whyNameUnusable", () => {
  it("空名给出原因", () => {
    expect(whyNameUnusable("  ")).toBe("名字不能为空");
  });

  it("清洗后为空也给出原因", () => {
    expect(whyNameUnusable("///")).toBe("这个名字清洗后什么都不剩，换一个");
  });

  it("正常名字返回 undefined", () => {
    expect(whyNameUnusable("林晚照")).toBeUndefined();
  });
});

describe("isRenamed", () => {
  it("名字被改动时提示作者", () => {
    expect(isRenamed("第七结局（备选）")).toBe(true);
    // 空格会被折成连字符，作者看到的分支名不同，也必须提示
    expect(isRenamed("a  b")).toBe(true);
    expect(isRenamed("林晚照 线")).toBe(true);
  });

  it("原样返回 false", () => {
    expect(isRenamed("林晚照")).toBe(false);
    expect(isRenamed("v2.1-结局")).toBe(false);
  });

  it("空输入返回 false（还没开始输入）", () => {
    expect(isRenamed("   ")).toBe(false);
  });
});

describe("parseWorktreeList", () => {
  const sample = [
    "worktree E:/novel",
    "HEAD 1234567890abcdef",
    "branch refs/heads/main",
    "",
    "worktree E:/novel-line-x",
    "HEAD abcdef1234567890",
    "branch refs/heads/line/x",
    "",
  ].join("\n");

  it("解析出目录、分支、短哈希", () => {
    const list = parseWorktreeList(sample, "E:/novel");
    expect(list).toHaveLength(2);
    expect(list[0].dir).toBe("E:/novel");
    expect(list[0].branch).toBe("main");
    expect(list[0].main).toBe(true);
    expect(list[1].branch).toBe("line/x");
    expect(list[1].main).toBe(false);
  });

  it("提交哈希截到 7 位", () => {
    const list = parseWorktreeList(sample);
    expect(list[0].commit).toBe("1234567");
  });

  it("路径含空格也能正确解析（普通 list 会靠列宽对齐而切错）", () => {
    const withSpace = "worktree E:/我的小说 第一部\nHEAD abc\nbranch refs/heads/main\n";
    const list = parseWorktreeList(withSpace);
    expect(list[0].dir).toBe("E:/我的小说 第一部");
  });

  it("bare 仓库被跳过", () => {
    const bare = "worktree E:/repo\nbare\n\n";
    expect(parseWorktreeList(bare)).toHaveLength(0);
  });

  it("分离 HEAD 时 branch 为 undefined", () => {
    const detached = "worktree E:/w\nHEAD abc\ndetached\n";
    const list = parseWorktreeList(detached);
    expect(list[0].branch).toBeUndefined();
  });

  it("空输入返回空数组", () => {
    expect(parseWorktreeList("")).toEqual([]);
  });

  it("Windows 盘符大小写不同仍认作主工作区", () => {
    const s = "worktree e:/novel\nHEAD abc\nbranch refs/heads/main\n";
    expect(parseWorktreeList(s, "E:/novel")[0].main).toBe(true);
  });
});

describe("samePath", () => {
  it("正反斜杠视为同一路径", () => {
    expect(samePath("E:\\novel\\a", "E:/novel/a")).toBe(true);
  });

  it("盘符大小写不同视为同一路径", () => {
    expect(samePath("e:/novel", "E:/novel")).toBe(true);
  });

  it("末尾斜杠不影响", () => {
    expect(samePath("E:/novel/", "E:/novel")).toBe(true);
  });

  it("不同路径不相等", () => {
    expect(samePath("E:/novel", "E:/novel2")).toBe(false);
  });
});

/* ============================================================
 * git 交互（用桩执行器）
 * ============================================================ */

function fakeExec(handler: (args: readonly string[]) => { code: number; stdout?: string; stderr?: string }): {
  exec: ExecFn;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: ExecFn = async (args) => {
    calls.push([...args]);
    const r = handler(args);
    return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { exec, calls };
}

describe("addWorktree", () => {
  it("新建分支并检出到平级目录", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0 }));
    const r = await addWorktree(exec, "E:/novel", "line/林晚照");
    expect(r.ok).toBe(true);
    expect(r.dir?.replace(/\\/g, "/")).toBe("E:/novel-line-林晚照");
    expect(calls[0].slice(0, 3)).toEqual(["worktree", "add", "-b"]);
  });

  it("分支已存在时退化为检出已有分支", async () => {
    let n = 0;
    const { exec } = fakeExec((args) => {
      n++;
      if (args.includes("-b") && n === 1) {
        return { code: 128, stderr: "fatal: a branch named 'line/x' already exists" };
      }
      return { code: 0 };
    });
    const r = await addWorktree(exec, "E:/novel", "line/x");
    expect(r.ok).toBe(true);
  });

  it("目录已存在时用 --force 重试", async () => {
    let n = 0;
    const { exec, calls } = fakeExec(() => {
      n++;
      if (n === 1) return { code: 128, stderr: "fatal: 'E:/novel-x' already exists" };
      return { code: 0 };
    });
    const r = await addWorktree(exec, "E:/novel", "line/x");
    expect(r.ok).toBe(true);
    expect(calls[1]).toContain("--force");
  });

  it("其它错误原样返回 stderr（不要吞掉原因）", async () => {
    const { exec } = fakeExec(() => ({ code: 128, stderr: "fatal: not a git repository" }));
    const r = await addWorktree(exec, "E:/novel", "line/x");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a git repository");
  });
});

describe("removeWorktree", () => {
  it("默认不传 --force（有未提交改动时应被 git 拦住）", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0 }));
    await removeWorktree(exec, "E:/novel", "E:/novel-x");
    expect(calls[0]).toEqual(["worktree", "remove", "E:/novel-x"]);
    expect(calls[0]).not.toContain("--force");
  });

  it("作者明确要求时才传 --force", async () => {
    const { exec, calls } = fakeExec(() => ({ code: 0 }));
    await removeWorktree(exec, "E:/novel", "E:/novel-x", { force: true });
    expect(calls[0]).toContain("--force");
  });

  it("失败时保留 git 的原话", async () => {
    const { exec } = fakeExec(() => ({ code: 128, stderr: "fatal: contains modified or untracked files" }));
    const r = await removeWorktree(exec, "E:/novel", "E:/novel-x");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("modified or untracked");
  });
});