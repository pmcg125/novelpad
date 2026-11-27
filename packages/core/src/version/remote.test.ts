/**
 * 托管层单测。
 *
 * 两个重点：
 *   1. URL 里的 token 绝不能出现在任何展示路径上（截图、日志、错误消息）
 *   2. git 的原始报错必须被翻译成作者能懂、且能据此行动的话
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExecFn } from "./repo.js";
import { rebuildIndex } from "./snapshot.js";
import {
  detectHost,
  ensureHostingFetch,
  explainPushError,
  listRemotes,
  pull,
  push,
  pushPreview,
  redactUrl,
  removeRemote,
  setRemote,
  upstreamOf,
} from "./remote.js";

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

describe("redactUrl", () => {
  it("去掉 https URL 里的 token", () => {
    expect(redactUrl("https://pmcg125:ghp_abc123@github.com/a/b.git")).toBe("https://github.com/a/b.git");
  });

  it("去掉只有 token 没有用户名的形式", () => {
    expect(redactUrl("https://ghp_abc123@github.com/a/b.git")).toBe("https://github.com/a/b.git");
  });

  it("不含凭据的 URL 原样返回", () => {
    expect(redactUrl("https://github.com/a/b.git")).toBe("https://github.com/a/b.git");
    expect(redactUrl("git@github.com:a/b.git")).toBe("git@github.com:a/b.git");
  });

  it("SSH 里的 user@host 不被误删（那是用户名不是口令）", () => {
    // 这条守的是正则别写太狠：`//[^@]*@` 会连 "git@" 一起吃掉
    expect(redactUrl("ssh://git@github.com/a/b.git")).toBe("ssh://git@github.com/a/b.git");
  });
});

describe("detectHost", () => {
  it("认出 GitHub / Gitee / GitLab", () => {
    expect(detectHost("https://github.com/a/b.git")).toBe("github");
    expect(detectHost("git@github.com:a/b.git")).toBe("github");
    expect(detectHost("https://gitee.com/a/b.git")).toBe("gitee");
    expect(detectHost("https://gitlab.com/a/b.git")).toBe("gitlab");
  });

  it("自建仓库算 other", () => {
    expect(detectHost("https://git.mycompany.cn/a/b.git")).toBe("other");
  });

  it("不是 URL 时返回 undefined", () => {
    expect(detectHost("E:/some/path")).toBeUndefined();
  });
});

describe("explainPushError", () => {
  it("认证失败说要重新登录", () => {
    expect(explainPushError("fatal: Authentication failed for 'https://github.com/a/b'")).toContain("重新登录");
    expect(explainPushError("fatal: could not read Username for 'https://github.com': terminal prompts disabled")).toContain("重新登录");
  });

  it("404 说名字错了或没权限，而不是「仓库不存在」这种会让作者以为稿子丢了的话", () => {
    const msg = explainPushError("remote: Repository not found.\nfatal: repository 'https://github.com/a/b/' not found");
    expect(msg).toContain("权限");
  });

  it("被拒绝时明确劝阻强推（强推会覆盖别人的稿子）", () => {
    const msg = explainPushError("! [rejected]        main -> main (non-fast-forward)");
    expect(msg).toContain("别强推");
  });

  it("网络问题单独一类", () => {
    expect(explainPushError("fatal: unable to access ... Could not resolve host: github.com")).toContain("连不上");
  });

  it("大文件给出可操作建议", () => {
    expect(explainPushError("remote: error: GH001: Large files detected")).toContain("压缩");
  });

  it("没设置远端时说清楚要选仓库", () => {
    expect(explainPushError("fatal: No configured push destination.")).toContain("还没有设置托管位置");
  });

  it("分支上没有提交时不说「推送失败」，说没东西可推", () => {
    expect(explainPushError("error: src refspec main does not match any")).toContain("没有东西可推");
  });

  it("认不出的错误原样返回（别把原因吞掉）", () => {
    expect(explainPushError("something weird happened")).toBe("something weird happened");
  });

  it("空输入不崩", () => {
    expect(explainPushError("")).toBe("推送失败，原因不明");
  });
});

/* ============================================================
 * 真实 git 仓库
 * ============================================================ */

let root: string;
let bare: string;

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
  root = fs.mkdtempSync(path.join(os.tmpdir(), "np-remote-"));
  bare = fs.mkdtempSync(path.join(os.tmpdir(), "np-remote-bare-"));
  await git("init", "-q", "-b", "main");
  await git("config", "core.autocrlf", "false");
  await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  // 裸仓库的 HEAD 必须也指向 main：否则 clone 出来的仓库里没有 main 分支，
  // 后面 `git push origin main` 会报 "src refspec main does not match any"，
  // 看起来像是 pull/push 逻辑坏了，其实只是测试夹具没对齐默认分支名。
  await git("init", "-q", "--bare", "-b", "main", bare);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(bare, { recursive: true, force: true });
});

describe("listRemotes", () => {
  it("列出远端并去掉凭据", async () => {
    await git("remote", "add", "origin", "https://ghp_secret@github.com/a/b.git");
    const rs = await listRemotes(exec, root);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.name).toBe("origin");
    expect(rs[0]!.host).toBe("github");
    // 关键：displayUrl 里不能有 token
    expect(rs[0]!.displayUrl).not.toContain("ghp_secret");
    expect(rs[0]!.displayUrl).toBe("https://github.com/a/b.git");
  });

  it("fetch 与 push 地址不同时只取一条（不重复列出）", async () => {
    await git("remote", "add", "origin", "https://github.com/a/b.git");
    await git("remote", "set-url", "--push", "origin", "https://github.com/c/d.git");
    const rs = await listRemotes(exec, root);
    expect(rs).toHaveLength(1);
  });

  it("没有远端时返回空数组", async () => {
    expect(await listRemotes(exec, root)).toEqual([]);
  });

  it("不在仓库里时不崩（作者可能刚删了 .git）", async () => {
    const nope = fs.mkdtempSync(path.join(os.tmpdir(), "np-norepo-"));
    try {
      expect(await listRemotes(exec, nope)).toEqual([]);
    } finally {
      fs.rmSync(nope, { recursive: true, force: true });
    }
  });
});

describe("setRemote / removeRemote", () => {
  it("第一次是 add，第二次是 set-url（作者换仓库）", async () => {
    expect((await setRemote(exec, root, "origin", "https://github.com/a/one.git")).ok).toBe(true);
    expect((await setRemote(exec, root, "origin", "https://github.com/a/two.git")).ok).toBe(true);

    const rs = await listRemotes(exec, root);
    expect(rs).toHaveLength(1);
    expect(rs[0]!.displayUrl).toBe("https://github.com/a/two.git");
  });

  it("删除远端", async () => {
    await setRemote(exec, root, "origin", "https://github.com/a/b.git");
    expect(await removeRemote(exec, root, "origin")).toBe(true);
    expect(await listRemotes(exec, root)).toEqual([]);
  });

  it("删不存在的远端返回 false（不抛）", async () => {
    expect(await removeRemote(exec, root, "nope")).toBe(false);
  });
});

describe("upstreamOf", () => {
  it("没设上游时返回 undefined", async () => {
    expect(await upstreamOf(exec, root, "main")).toBeUndefined();
  });

  it("设了上游后能读出远端与分支名", async () => {
    await git("remote", "add", "origin", bare);
    await git("push", "-q", "-u", "origin", "main");
    const up = await upstreamOf(exec, root, "main");
    expect(up).toEqual({ remote: "origin", branch: "main" });
  });
});

describe("pushPreview", () => {
  it("没上游时 hasUpstream 为 false（界面要说「第一次推送」而不是「0 条待推」）", async () => {
    const p = await pushPreview(exec, root);
    expect(p.hasUpstream).toBe(false);
    expect(p.branch).toBe("main");
  });

  it("有上游时能算出待推的提交数", async () => {
    await git("remote", "add", "origin", bare);
    await git("push", "-q", "-u", "origin", "main");
    write("chapters/001.md", "# 第一章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "第一章");

    const p = await pushPreview(exec, root);
    expect(p.hasUpstream).toBe(true);
    expect(p.ahead).toBe(1);
    expect(p.behind).toBe(0);
  });

  it("有未提交改动时 dirty 为 true（不影响推送，但要告诉作者）", async () => {
    await git("remote", "add", "origin", bare);
    await git("push", "-q", "-u", "origin", "main");
    write("chapters/001.md", "# 未提交\n");
    const p = await pushPreview(exec, root);
    expect(p.dirty).toBe(true);
  });

  it("分离 HEAD 时不崩", async () => {
    await git("checkout", "-q", "--detach", "HEAD");
    const p = await pushPreview(exec, root);
    expect(p.hasUpstream).toBe(false);
    expect(p.branch).toBeUndefined();
  });
});

/*
 * 这一组每个用例都要起十几个 git 进程（clone / fetch / push / merge），
 * Windows 上单次 spawn 就要一两百毫秒，默认 5s 会随机超时。
 * 逐个用例放宽（第三个参数），不写进全局配置：那样会掩盖别的用例真的变慢。
 */
const GIT = 60_000;

describe("push / pull（真实 git）", () => {
  it("推到本地裸仓库，pushPreview 随后归零", async () => {
    await setRemote(exec, root, "origin", bare);
    write("chapters/001.md", "# 第一章\n");
    await git("add", "-A");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "第一章");

    const r = await push(exec, { root, remote: "origin", branch: "main" });
    expect(r.ok).toBe(true);

    const p = await pushPreview(exec, root);
    expect(p.ahead).toBe(0);
    expect(p.hasUpstream).toBe(true);
  }, GIT);

  it("第二次推送（内容没变）也成功，不报「已是最新」为错误", async () => {
    await setRemote(exec, root, "origin", bare);
    const first = await push(exec, { root, remote: "origin", branch: "main" });
    expect(first.ok).toBe(true);
    const second = await push(exec, { root, remote: "origin", branch: "main" });
    expect(second.ok).toBe(true);
  }, GIT);

  it("远端是自己的另一个克隆时，pull 能把新提交拿下来", async () => {
    await setRemote(exec, root, "origin", bare);
    await push(exec, { root, remote: "origin", branch: "main" });

    // 模拟另一台机器
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "np-remote-other-"));
    try {
      const pexecIn = async (cwd: string, ...args: string[]) => {
        const res = await exec(args, { cwd });
        if (res.code !== 0) throw new Error(res.stderr);
        return res.stdout;
      };
      await pexecIn(other, "clone", "-q", bare, ".");
      await pexecIn(other, "config", "core.autocrlf", "false");
      fs.mkdirSync(path.join(other, "chapters"), { recursive: true });
      fs.writeFileSync(path.join(other, "chapters", "002.md"), "# 第二章\n", "utf8");
      await pexecIn(other, "add", "-A");
      await pexecIn(other, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "-m", "第二章");
      await pexecIn(other, "push", "-q", "origin", "main");

      const r = await pull(exec, root);
      expect(r.ok).toBe(true);
      expect(r.updated).toBe(true);
      expect(fs.readFileSync(path.join(root, "chapters", "002.md"), "utf8")).toContain("第二章");
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  }, GIT);

  it("没有新内容时 pull 报 updated: false（不误报「有更新」）", async () => {
    await setRemote(exec, root, "origin", bare);
    await push(exec, { root, remote: "origin", branch: "main" });
    const r = await pull(exec, root);
    expect(r.ok).toBe(true);
    expect(r.updated).toBe(false);
  }, GIT);

  it("推送带上里程碑 / 发布版 ref，另一台机器 pull 能重建时间线", async () => {
    await setRemote(exec, root, "origin", bare);
    write("chapters/001.md", "# 第一章\n");
    await git("add", "-A");
    // 提交信息按 milestoneSnapshot 的真实格式写：标签只能从这里找回来
    // （snapshots.json 是本地缓存，故意不进 git）
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "milestone: 第二章 渡口");
    const tip = (await git("rev-parse", "HEAD")).trim();
    // 里程碑挂在提交上（真实流程里由 milestoneSnapshot 造）
    await git("update-ref", "refs/novelpad/milestone/m_1", tip);
    await git("update-ref", "refs/novelpad/publish/v1", tip);
    // 自动存档不该被推上去：它是可重建的短期缓存
    await git("update-ref", "refs/novelpad/auto/001/20261127", tip);

    expect((await push(exec, { root, remote: "origin", branch: "main" })).ok).toBe(true);

    const remoteRefs = (await exec(["for-each-ref", "--format=%(refname)"], { cwd: bare })).stdout;
    expect(remoteRefs).toContain("refs/heads/main");
    expect(remoteRefs).toContain("refs/novelpad/milestone/m_1");
    expect(remoteRefs).toContain("refs/novelpad/publish/v1");
    expect(remoteRefs).not.toContain("refs/novelpad/auto/");

    // 新机器：clone 只拿 refs/heads/*，必须有 fetch 配置才能取回时间线
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "np-remote-tl-"));
    try {
      const inOther = async (...args: string[]) => {
        const res = await exec(args, { cwd: other });
        if (res.code !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
        return res.stdout;
      };
      await inOther("clone", "-q", bare, ".");
      await inOther("config", "core.autocrlf", "false");
      // merge --ff-only 通常不需要身份，但别让测试依赖机器上的全局配置
      await inOther("config", "user.name", "o");
      await inOther("config", "user.email", "o@o");
      expect(await inOther("for-each-ref", "refs/novelpad")).toBe("");

      const r = await pull(exec, other);
      expect(r.ok).toBe(true);
      const got = (await exec(["for-each-ref", "--format=%(refname)", "refs/novelpad"], { cwd: other })).stdout;
      expect(got).toContain("refs/novelpad/milestone/m_1");
      expect(got).toContain("refs/novelpad/publish/v1");

      // 时间线真的能重建出来，而且作者写的标签还在
      const idx = await rebuildIndex(exec, other);
      expect(idx.snapshots.map((s) => s.kind).sort()).toEqual(["milestone", "publish"]);
      const milestone = idx.snapshots.find((s) => s.kind === "milestone");
      expect(milestone?.label).toBe("第二章 渡口");
      // 反例守卫：publish 的 ref 指向同一条提交，但它的标签不该被误当成里程碑标签
      expect(idx.snapshots.find((s) => s.kind === "publish")?.label).toBeUndefined();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  }, GIT);

  it("从没存过版时推送不因通配 refspec 无匹配而失败", async () => {
    await setRemote(exec, root, "origin", bare);
    const r = await push(exec, { root, remote: "origin", branch: "main" });
    expect(r.ok).toBe(true);
    const refs = (await exec(["for-each-ref", "--format=%(refname)"], { cwd: bare })).stdout;
    expect(refs).not.toContain("refs/novelpad/");
  }, GIT);

  it("ensureHostingFetch 幂等，且不会堆重复条目", async () => {
    await setRemote(exec, root, "origin", bare);
    expect((await ensureHostingFetch(exec, root, "origin")).added).toBeGreaterThan(0);
    const second = await ensureHostingFetch(exec, root, "origin");
    expect(second.ok).toBe(true);
    expect(second.added).toBe(0);

    const all = (await exec(["config", "--get-all", "remote.origin.fetch"], { cwd: root })).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    expect(new Set(all).size).toBe(all.length);
  }, GIT);

  it("远端不存在时说清而不是静默", async () => {
    const r = await ensureHostingFetch(exec, root, "nope");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("找不到远端");
  }, GIT);

  it("两边分叉时 pull 拒绝并给出人话（不强合，避免搅乱作者的稿子）", async () => {
    await setRemote(exec, root, "origin", bare);
    await push(exec, { root, remote: "origin", branch: "main" });

    // 另一台机器先推一条
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "np-remote-div-"));
    try {
      const pexecIn = async (cwd: string, ...args: string[]) => {
        const res = await exec(args, { cwd });
        if (res.code !== 0) throw new Error(res.stderr);
        return res.stdout;
      };
      await pexecIn(other, "clone", "-q", bare, ".");
      await pexecIn(other, "config", "core.autocrlf", "false");
      fs.writeFileSync(path.join(other, "a.md"), "对方写的\n", "utf8");
      await pexecIn(other, "add", "-A");
      await pexecIn(other, "-c", "user.name=o", "-c", "user.email=o@o", "commit", "-q", "-m", "对方");
      await pexecIn(other, "push", "-q", "origin", "main");

      // 本地也提交一条 → 分叉
      write("b.md", "我写的\n");
      await git("add", "-A");
      await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "我的");

      const r = await pull(exec, root);
      expect(r.ok).toBe(false);
      expect(r.error).toContain("不能自动合");
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  }, GIT);
});