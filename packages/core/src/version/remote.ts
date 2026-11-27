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
  /** 省略或 "HEAD" = 推当前分支（内部会解析成分支名并显式拼 refspec） */
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
 * 除分支之外还要推的 ref。
 *
 * 为什么不能只推分支：时间线的记录住在 `refs/novelpad/{milestone,publish}/…`，
 * 而索引 `.novelpad/version/snapshots.json` 是**故意不进 git 的**（本地缓存，
 * 每个 worktree 各一份，跟踪它会让两个窗口互相覆盖）。只推分支的话，
 * 换台机器 clone 下来正文全在、时间线一片空白——「昨晚那版」找不回来。
 * rebuildIndex 正是靠这些 ref 重建索引的，推了它们才算备份了时间线。
 *
 * 不推 `refs/novelpad/auto/`：那是按章滚动的短期缓存（每章只留 20 个），
 * 推上去会在仓库里堆几百条作者看不懂的 ref，而且它随时可重建，不是要保的东西。
 *
 * 通配 refspec 在没有匹配时**静默跳过**（实测 exit 0），所以「从没存过版」
 * 不会让这次推送报错。这些 ref 不在 `refs/heads/` 下，GitHub 的分支列表
 * 也不会多出条目来。
 */
const TRUNK_REF_SPECS = ["refs/novelpad/milestone/*", "refs/novelpad/publish/*"].flatMap((r) => [`${r}:${r}`]);

/** 与 TRUNK_REF_SPECS 对应的拉取映射；落到本地同名 ref，rebuildIndex 才扫得到 */
const EXTRA_FETCH_REF_SPECS = ["refs/novelpad/milestone", "refs/novelpad/publish"].flatMap((r) => [
  `+${r}/*:${r}/*`,
]);

/**
 * 让 `git fetch` / 「从云端取回」真的能把时间线带下来。
 *
 * 关键一步：clone 和普通 fetch 默认只取 `refs/heads/*`。我们把里程碑 ref
 * 推上去了，却不改 fetch 配置的话，那些 ref 在新机器上永远取不到——
 * 等于写一份没人能读的备份，比不推更糟（作者会以为已经备份好了）。
 *
 * 写进 `.git/config` 的 `remote.<name>.fetch`。这不违反「凭据不落盘」：
 * refspec 不是密钥，而且 `.git/config` 本身不会被提交或推送。
 * 幂等：已有同名条目就不再加，重复调用不会让配置越堆越长。
 */
export async function ensureHostingFetch(
  exec: ExecFn,
  root: string,
  remote = "origin",
): Promise<{ ok: boolean; added: number; error?: string }> {
  const cur = await exec(["config", "--get-all", `remote.${remote}.fetch`], { cwd: root });
  const have = new Set(cur.code === 0 ? cur.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : []);
  if (!have.size) {
    return { ok: false, added: 0, error: `找不到远端 ${remote}` };
  }
  const missing = EXTRA_FETCH_REF_SPECS.filter((s) => !have.has(s));
  if (!missing.length) return { ok: true, added: 0 };

  for (const spec of missing) {
    const r = await exec(["config", "--add", `remote.${remote}.fetch`, spec], { cwd: root });
    if (r.code !== 0) return { ok: false, added: 0, error: r.stderr.trim() || "写入拉取配置失败" };
  }
  return { ok: true, added: missing.length };
}

/**
 * 推一条分支上去。
 *
 * **必须显式给出 refspec。** 不带 refspec 时 git 按 `push.default`
 * 决定推什么，而分支还没有上游时它会直接报错：
 *
 *     fatal: The current branch main has no upstream branch.
 *
 * 也就是说作者第一次点「备份」必然失败；而在某些 push.default 配置下
 * 它返回 **exit 0 却什么都没推**——那更糟，界面显示"已备份"，云端是空的。
 *
 * 所以这里先把 HEAD 解析成分支名，再拼 `<分支>:<分支>`。
 * 凭据走 `GIT_ASKPASS` 而不是 URL 里嵌 token——后者会被写进
 * `.git/config`，然后随下一次推送一起泄露。
 */
export async function push(exec: ExecFn, input: PushInput): Promise<PushOutput> {
  const remote = input.remote ?? "origin";

  // 分支名：调用方给就用，给的是 "HEAD" 或没给就解析当前分支
  let branch = input.branch && input.branch !== "HEAD" ? input.branch : undefined;
  if (!branch) {
    const cur = await exec(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: input.root });
    branch = cur.code === 0 ? cur.stdout.trim() : "";
  }
  // 未出生分支（一个字没存过就点备份）：git 会说一句看不懂的
  // "src refspec does not match any"，这里直接说人话。
  if (!branch) {
    return { ok: false, error: "这部作品还没有存过档，没有内容可备份。先写点什么，或点一次「存一版」。" };
  }

  const args = ["push"];
  // 上游只跟着分支建，所以 `-u` 必须待在主 refspec 那一组里；
  // 里程碑 / 发布版是额外带上去的历史，不参与上游跟踪，单独一组。
  if (input.setUpstream !== false) args.push("-u");
  args.push(remote, `${branch}:${branch}`, ...TRUNK_REF_SPECS);

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
 * **不用 `git pull`。** pull 一旦带显式 refspec（我们为了把里程碑 ref
 * 一起取回来必须带），git 会说 `Cannot fast-forward to multiple branches`
 * 并且不动 HEAD——实测如此，界面显示失败但云端内容其实取到了一半。
 * 所以拆成 fetch + merge，两件事各自可控：
 *
 *   - `fetch` 按 `.git/config` 的 refspec 取，包含里程碑 / 发布版，
 *     时间线这才跟着稿子一起回来了。
 *   - `merge --ff-only <remote>/<branch>` 只在能快进时动工作区。
 *
 * 只用快进：作者的工作区里可能有正在写的段落，一次真正的 merge 会在
 * 他的文件里插进冲突标记——他那时的第一反应是「我的稿子坏了」。
 * 快进失败就如实说「需要手动处理」，绝不自己合。
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
  const remote = opts.remote ?? "origin";

  // 取回时间线 ref 的前提。失败不拦：老仓库没这条配置也能只同步正文。
  await ensureHostingFetch(exec, root, remote);

  const fetched = await exec(["fetch", remote], { cwd: root, timeoutMs: 180_000, env });
  if (fetched.code !== 0) {
    return { ok: false, updated: false, error: explainPushError(fetched.stderr || fetched.stdout) };
  }

  // 目标分支：调用方给了就用，没给取当前分支
  let branch = opts.branch;
  if (!branch) {
    const cur = await exec(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root });
    branch = cur.code === 0 ? cur.stdout.trim() : "";
  }
  if (!branch) {
    return { ok: false, updated: false, error: "这部作品当前不在任何分支上，没法取回。" };
  }

  // 远端还没有这条分支（第一次取回、或那边只推过别的分支）
  const remoteTip = await exec(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], { cwd: root });
  if (remoteTip.code !== 0) {
    return { ok: false, updated: false, error: "云端还没有这部作品的内容，或者那个仓库里没有这条分支。" };
  }

  const before = await exec(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root });
  const merge = await exec(["merge", "--ff-only", `refs/remotes/${remote}/${branch}`], {
    cwd: root,
    timeoutMs: 60_000,
    env,
  });
  if (merge.code !== 0) {
    const s = merge.stderr.toLowerCase();
    if (/not possible to fast-forward|diverged|come from nowhere/.test(s)) {
      return { ok: false, updated: false, error: "云端和你本地都有对方没有的改动。这种时候不能自动合，避免把你正在写的稿子搅乱。" };
    }
    if (/local changes would be overwritten|uncommitted changes/.test(s)) {
      return { ok: false, updated: false, error: "你有还没存进版本库的改动，先点一次「存一版」再取回。" };
    }
    return { ok: false, updated: false, error: explainPushError(merge.stderr || merge.stdout) };
  }

  const after = await exec(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root });
  return { ok: true, updated: before.stdout.trim() !== after.stdout.trim() };
}