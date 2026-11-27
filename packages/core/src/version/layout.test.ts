import { describe, expect, it } from "vitest";
import { fromRepoPath, repoLayout, toRepoPath } from "./layout.js";
import type { ExecFn } from "./repo.js";

/** 构造一个「作品位于仓库子目录」的执行器 */
function makeGit(opts: { toplevel?: string; prefix?: string; fail?: boolean } = {}): ExecFn {
  return async (args) => {
    const ok = (s = "") => ({ code: 0, stdout: s, stderr: "" });
    const bad = (s = "not a git repo") => ({ code: 1, stdout: "", stderr: s });
    if (opts.fail) return bad();
    if (args[0] === "rev-parse") {
      const spec = args[args.length - 1];
      if (spec === "--show-toplevel") return ok(`${opts.toplevel ?? "/repo"}\n`);
      if (spec === "--show-prefix") return ok(`${opts.prefix ?? ""}\n`);
    }
    return bad("unhandled " + args.join(" "));
  };
}

describe("repoLayout", () => {
  it("作品根就是仓库根时前缀为空", async () => {
    const l = await repoLayout(makeGit(), "/repo");
    expect(l).toEqual({ toplevel: "/repo", prefix: "" });
  });

  it("作品在子目录时给出带斜杠的前缀", async () => {
    const l = await repoLayout(makeGit({ prefix: "novel/" }), "/repo/novel");
    expect(l?.prefix).toBe("novel/");
  });

  it("git 返回的前缀缺尾斜杠时补上（否则拼接会变成 novel001.md）", async () => {
    const l = await repoLayout(makeGit({ prefix: "novel" }), "/repo/novel");
    expect(l?.prefix).toBe("novel/");
  });

  it("多层子目录", async () => {
    const l = await repoLayout(makeGit({ prefix: "works/novel/" }), "/repo/works/novel");
    expect(l?.prefix).toBe("works/novel/");
  });

  it("不是 git 仓库时返回 undefined，而不是假装前缀为空", async () => {
    // 假装成功会让后续 git show 静默失败 → 界面显示「没有差异」，比报错更糟
    expect(await repoLayout(makeGit({ fail: true }), "/notrepo")).toBeUndefined();
  });
});

describe("toRepoPath / fromRepoPath", () => {
  it("无前缀时原样返回", () => {
    expect(toRepoPath({ toplevel: "/repo", prefix: "" }, "chapters/001.md")).toBe("chapters/001.md");
  });

  it("有前缀时拼接", () => {
    expect(toRepoPath({ toplevel: "/repo", prefix: "novel/" }, "chapters/001.md")).toBe("novel/chapters/001.md");
  });

  it("去掉开头的斜杠", () => {
    expect(toRepoPath({ toplevel: "/r", prefix: "" }, "/chapters/001.md")).toBe("chapters/001.md");
  });

  it("反斜杠统一成正斜杠（Windows 路径）", () => {
    expect(toRepoPath({ toplevel: "/r", prefix: "novel/" }, "chapters\\001.md")).toBe("novel/chapters/001.md");
  });

  it("往返一致", () => {
    const l = { toplevel: "/repo", prefix: "novel/" };
    const repo = toRepoPath(l, "lore/characters/lin.md");
    expect(repo).toBe("novel/lore/characters/lin.md");
    expect(fromRepoPath(l, repo)).toBe("lore/characters/lin.md");
  });

  it("仓库路径不在作品前缀下时返回空串（调用方据此过滤）", () => {
    const l = { toplevel: "/repo", prefix: "novel/" };
    expect(fromRepoPath(l, "other-project/chapters/001.md")).toBe("");
  });

  it("无前缀时 fromRepoPath 原样返回", () => {
    expect(fromRepoPath({ toplevel: "/r", prefix: "" }, "chapters/001.md")).toBe("chapters/001.md");
  });
});