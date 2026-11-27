/**
 * 托管：把作品推到 GitHub（docs/PLAN-VERSIONING.md §8 V5）。
 *
 * 验收标准是**作者全程不输入 git 命令**。所以这一层要做的不是
 * 「封装 git push」，而是：
 *   1. 判断能不能推（有没有 git、有没有 remote、有没有凭据）
 *   2. 把 git 的报错翻译成人话（"Authentication failed" 不是作者该读的）
 *   3. 推的内容只有**作品**，不含 `.novelpad/version/` 这类本地缓存
 *
 * 安全约束：
 *   - 绝不把 token 写进 `.git/config`（那会随仓库一起被推上去）
 *   - 凭据只在单次命令的 env 里存在
 *   - 不做 `--force`
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecFn } from "./repo.js";

/* ============================================================
 * 远端
 * ============================================================ */

export interface RemoteInfo {
  name: string;
  /** 原始 URL（可能含 token，绝不给界面看） */
  url: string;
  /** 去掉凭据的展示用 URL */
  displayUrl: string;
  /** 能认出来的托管方 */
  host?: "github" | "gitee" | "gitlab" | "other";
}

/**
 * 去掉 URL 里的凭据。
 *
 * `https://user:ghp_xxx@github.com/a/b.git` 里的 token 一旦进了日志、
 * 错误消息或截图，就等于泄露了。所有展示路径都必须过这个函数。
 *
 * 只处理 http(s)：凭据只会出现在这种形式里。`ssh://git@host` 里的
 * `git` 是**用户名**，删掉它 URL 就不合法了。
 */
export function redactUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  return url.replace(/\/\/[^/]*@/, "//");
}

export function detectHost(url: string): RemoteInfo["host"] {
  const u = url.toLowerCase();
  if (u.includes("github.com")) return "github";
  if (u.includes("gitee.com")) return "gitee";
  if (u.includes("gitlab")) return "gitlab";
  if (/^https?:|^git@|^ssh:/.test(u)) return "other";
  return undefined;
}

export async function listRemotes(exec: ExecFn, root: string): Promise<RemoteInfo[]> {
  const r = await exec(["remote", "-v"], { cwd: root });
  if (r.code !== 0) return [];

  const seen = new Map<string, RemoteInfo>();
  for (const line of r.stdout.split(/\r?\n/)) {
    // "origin\thttps://... (fetch)"
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!m) continue;
    const [, name, url] = m;
    if (seen.has(name!)) continue; // fetch/push 通常同一个 URL，取第一条
    seen.set(name!, { name: name!, url: url!, displayUrl: redactUrl(url!), host: detectHost(url!) });
  }
  return [...seen.values()];
}

/** 当前分支的上游；没有则 undefined */
export async function upstreamOf(exec: ExecFn, root: string, branch: string): Promise<{ remote: string; branch: string } | undefined> {
  const r = await exec(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], { cwd: root });
  if (r.code !== 0) return undefined;
  const s = r.stdout.trim();
  const slash = s.indexOf("/");
  if (slash < 0) return undefined;
  return { remote: s.slice(0, slash), branch: s.slice(slash + 1) };
}

/* ============================================================
 * 推送
 * ============================================================ */

export interface PushInput {
  root: string;
  remote?: string;
  branch?: string;
  /** 单次命令用的凭据，不落盘 */
  token?: string;
  username?: string;
  /** 首次推送时建立上游 */
  setUpstream?: boolean;
}

export interface PushOutput {
  ok: boolean;
  /** 已翻译成人话的失败原因 */
  error?: string;
  /** 原始终端输出，仅用于日志 */
  raw?: string;
  /** 推上去之后的可读地址 */
  url?: string;
}

/**
 * 把 git 的原始报错翻译成作者能懂的话。
 *
 * 作者不该看到 "fatal: unable to access ... The requested URL returned error: 403"——
 * 他会以为软件坏了。告诉他到底要做什么。
 */
export function explainPushError(stderr: string): string {
  const s = stderr.toLowerCase();

  if (/could not read username|terminal prompts disabled|authentication failed|403/.test(s)) {
    return "GitHub 不认这个账号。请重新登录（令牌可能过期或权限不够）。";
  }
  if (/repository not found|404/.test(s)) {
    return "GitHub 上找不到这个仓库。可能名字拼错了，或者令牌没有访问它的权限。";
  }
  if (/non-fast-forward|fetch first|rejected/.test(s)) {
    return "云端有你本地没有的内容（可能换了台机器写过）。先拉取再推送，别强推——那会覆盖掉那边的稿子。";
  }
  if (/could not resolve host|network is unreachable|connection timed out|failed to connect/i.test(s)) {
    return "连不上 GitHub。检查一下网络，或者稍后再试。";
  }
  if (/permission denied \(publickey\)/.test(s)) {
    return "SSH 密钥没配好。用 HTTPS 方式推送更省事。";
  }
  if (/no configured push destination|no remote/i.test(s)) {
    return "还没有设置托管位置。先选一个仓库。";
  }
  if (/src refspec .* does not match any/.test(s)) {
    return "这条分支上还没有任何提交，没有东西可推。";
  }
  if (/exceeds github's file size limit|gh001|large file/.test(s)) {
    return "有文件超过 GitHub 的单文件上限（100MB）。图片或素材建议压缩后再推。";
  }
  return stderr.trim() || "推送失败，原因不明";
}

/**
 * 推一条分支上去。
 *
 * 用 `-u` 建立上游：作者下次点「同步」就不必再指定分支。
 * 凭据走 `GIT_ASKPASS` 而不是 URL 里嵌 token——后者会被写进
 * `.git/config`，然后随下一次推送一起泄露。
 */
export async function push(exec: ExecFn, input: PushInput): Promise<PushOutput> {
  const remote = input.remote ?? "origin";
  const branch = input.branch ?? "HEAD";

  const args = ["push"];
  if (input.setUpstream !== false) args.push("-u");
  args.push(remote);
  if (branch !== "HEAD") args.push(branch);

  const env: Record<string, string> = {};
  if (input.token) {
    // 关掉交互式提示：CI / 无终端环境下它会挂住直到超时
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_ASKPASS = askpassScript();
    env.NOVELPAD_GIT_TOKEN = input.token;
    env.NOVELPAD_GIT_USER = input.username ?? "x-access-token";
  }

  const r = await exec(args, { cwd: input.root, timeoutMs: 180_000, env });
  const raw = `${r.stdout}\n${r.stderr}`.trim();

  if (r.code !== 0) return { ok: false, error: explainPushError(r.stderr || r.stdout), raw };

  const remotes = await listRemotes(exec, input.root);
  const used = remotes.find((x) => x.name === remote);
  return { ok: true, raw, url: used?.displayUrl };
}

/**
 * 生成一次性 askpass 脚本。
 *
 * 为什么不用 URL 里嵌 token：
 *   - `git remote set-url https://token@...` 会把 token 永久写进 .git/config
 *   - 那个文件在 `.git/` 里，虽然不会被提交，但会出现在备份、截图、
 *     以及作者误发的「把我的仓库发给你看看」里
 * 为什么不用 `-c credential.helper=...`：
 *   同上，且会污染全局配置。
 *
 * Windows 用 .bat（cmd 解析），其他平台用 sh。
 */
let cachedAskpass: string | undefined;
function askpassScript(): string {
  if (cachedAskpass) return cachedAskpass;
  // exec 的 env 只能传路径，脚本本身要在第一次调用时落盘。
  // 用固定名字 + 覆盖写，避免临时文件越积越多。
  const file =
    process.platform === "win32"
      ? path.join(os.tmpdir(), "novelpad-askpass.bat")
      : path.join(os.tmpdir(), "novelpad-askpass.sh");

  // 被问的是「用户名」还是「密码」：匹配 password 关键词。
  // 用 `findstr` 的管道会在提示语含 `&`/`>` 时炸掉，改用 if 比较 ERRORLEVEL。
  //
  // 默认用户名是 x-access-token：GitHub 的 PAT 校验不看用户名，
  // 但必须给一个非空值，否则 git 会再次弹提示。
  const body =
    process.platform === "win32"
      ? [
          "@echo off",
          "setlocal",
          'set "P=%~1"',
          'echo %P% | findstr /I "assword" >nul',
          "if %ERRORLEVEL%==0 (",
          "  echo %NOVELPAD_GIT_TOKEN%",
          ") else (",
          "  echo %NOVELPAD_GIT_USER%",
          ")",
          "endlocal",
          "",
        ].join("\r\n")
      : [
          "#!/bin/sh",
          'case "$1" in',
          "  *assword*) printf '%s\\n' \"$NOVELPAD_GIT_TOKEN\" ;;",
          "  *) printf '%s\\n' \"$NOVELPAD_GIT_USER\" ;;",
          "esac",
          "",
        ].join("\n");

  try {
    fs.writeFileSync(file, body, { encoding: "utf8", mode: 0o700 });
  } catch {
    /* 写不了就让 git 走默认路径，报错由 explainPushError 翻译 */
  }
  cachedAskpass = file;
  return file;
}

/* ============================================================
 * 远端配置
 * ============================================================ */

/** 设置（或替换）远端地址。作者换仓库时用 */
export async function setRemote(exec: ExecFn, root: string, name: string, url: string): Promise<{ ok: boolean; error?: string }> {
  const existing = await listRemotes(exec, root);
  const has = existing.some((r) => r.name === name);
  const args = has ? ["remote", "set-url", name, url] : ["remote", "add", name, url];
  const r = await exec(args, { cwd: root });
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || "设置远端失败" };
}

export async function removeRemote(exec: ExecFn, root: string, name: string): Promise<boolean> {
  const r = await exec(["remote", "remove", name], { cwd: root });
  return r.code === 0;
}

/* ============================================================
 * 待推送内容
 * ============================================================ */

export interface PushPreview {
  /** 有几条提交还没推上去 */
  ahead: number;
  /** 云端有几条本地没有 */
  behind: number;
  /** 有没有未提交的改动（不影响推送，但要告诉作者） */
  dirty: boolean;
  /** 当前分支 */
  branch?: string;
  /** 上游是否存在 */
  hasUpstream: boolean;
}

/**
 * 推送前的预览。
 *
 * 没有上游时不能算 ahead/behind——那会得到「全部提交都要推」这种
 * 正确但没用的数字。此时直接报 hasUpstream: false，界面改成
 * 「第一次推送」的说法。
 */
export async function pushPreview(exec: ExecFn, root: string): Promise<PushPreview> {
  const branchRes = await exec(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() || undefined : undefined;

  const status = await exec(["status", "--porcelain"], { cwd: root });
  const dirty = status.code === 0 && status.stdout.trim().length > 0;

  if (!branch) return { ahead: 0, behind: 0, dirty, hasUpstream: false };

  const up = await upstreamOf(exec, root, branch);
  if (!up) return { ahead: 0, behind: 0, dirty, branch, hasUpstream: false };

  const counts = await exec(["rev-list", "--left-right", "--count", `${branch}...@{upstream}`], { cwd: root });
  if (counts.code !== 0) return { ahead: 0, behind: 0, dirty, branch, hasUpstream: true };

  // 输出是 "<ahead>\t<behind>"
  const [a, b] = counts.stdout.trim().split(/\s+/);
  return {
    ahead: Number(a) || 0,
    behind: Number(b) || 0,
    dirty,
    branch,
    hasUpstream: true,
  };
}

/* ============================================================
 * 拉取
 * ============================================================ */

/**
 * 拉取远端更新。
 *
 * 只用 `--ff-only`：作者的工作区里可能有正在写的段落，
 * 一次真正的 merge 会在他的文件里插进冲突标记——他那时的
 * 第一反应是「我的稿子坏了」。快进失败就如实说「需要手动处理」。
 */
export async function pull(
  exec: ExecFn,
  root: string,
  opts: { remote?: string; branch?: string; token?: string; username?: string } = {},
): Promise<{ ok: boolean; error?: string; updated: boolean }> {
  const env: Record<string, string> = {};
  if (opts.token) {
    env.GIT_TERMINAL_PROMPT = "0";
    env.GIT_ASKPASS = askpassScript();
    env.NOVELPAD_GIT_TOKEN = opts.token;
    env.NOVELPAD_GIT_USER = opts.username ?? "x-access-token";
  }

  const before = await exec(["rev-parse", "HEAD"], { cwd: root });
  const args = ["pull", "--ff-only"];
  if (opts.remote) args.push(opts.remote);
  if (opts.branch) args.push(opts.branch);

  const r = await exec(args, { cwd: root, timeoutMs: 180_000, env });
  if (r.code !== 0) {
    const s = r.stderr.toLowerCase();
    if (/not possible to fast-forward|diverged/.test(s)) {
      return { ok: false, updated: false, error: "云端和你本地都有对方没有的改动。这种时候不能自动合，避免把你正在写的稿子搅乱。" };
    }
    return { ok: false, updated: false, error: explainPushError(r.stderr) };
  }

  const after = await exec(["rev-parse", "HEAD"], { cwd: root });
  return { ok: true, updated: before.stdout.trim() !== after.stdout.trim() };
}