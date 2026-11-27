/**
 * 托管接入层（docs/PLAN-VERSIONING.md §8 V5）。
 *
 * 验收标准是**作者全程不输入 git 命令**。所以这里不暴露 remote / push /
 * upstream 这些词，只有三件事：
 *   - 「连接到 GitHub」：建仓库 + 设远端 + 推第一版
 *   - 「备份到云端」：有改动就推
 *   - 「从云端取回」：快进合并
 *
 * 关键取舍：**不自己实现 OAuth**。
 *   自己走设备码流程要注册 OAuth App、维护 client_secret、处理刷新——
 *   对一个本地优先的桌面软件来说，这是把「作者的稿子」绑在一个我们
 *   还没能力维护的凭据链上。
 *
 *   改用两条现成的路：
 *     1. 装了 `gh` 且已登录 → 直接借用它的凭据（作者的机器上通常都有）
 *     2. 否则让作者粘一个 Personal Access Token
 *
 *   token 存进 SecretStorage（OS 钥匙串），**不写 .git/config**，
 *   因为后者会进备份、截图、以及作者误发的「帮我看看仓库」。
 */
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  backfillFromRefs,
  ensureRepo,
  listRemotes,
  nodeExec,
  pull,
  push,
  pushPreview,
  repoLayout,
  setRemote,
  syncTrunk,
  type PushPreview,
  type RemoteInfo,
} from "@novelpad/core";
import type { ProjectStore } from "../store";
import { backupHint, describeStatus, explainCreateError, hostingProblem, suggestRepoName } from "./host-rules.js";

// 纯逻辑在 host-rules.ts（可在 vitest 里加载）。
// 这里只做转发，避免两处实现各改一半。
export { describeStatus, hostingProblem, suggestRepoName };

const pexec = promisify(execFile);
const SECRET_TOKEN = "novelpad.host.token";
const SECRET_USER = "novelpad.host.user";

/* ============================================================
 * 凭据
 * ============================================================ */

export interface HostCredential {
  token: string;
  username: string;
  /** 来源：gh CLI 借来的 / 作者自己粘的 */
  from: "gh" | "manual";
}

/** 从 `gh auth token` 取凭据。没装 gh 或没登录都返回 undefined。 */
async function fromGh(): Promise<HostCredential | undefined> {
  try {
    const { stdout } = await pexec("gh", ["auth", "token"], {
      timeout: 8000,
      windowsHide: true,
      // gh 在未登录时会把提示打到 stderr 而不是返回非零——两个都要看
    });
    const token = stdout.trim();
    if (!token) return undefined;
    const user = await ghUser();
    return { token, username: user ?? "x-access-token", from: "gh" };
  } catch {
    return undefined;
  }
}

async function ghUser(): Promise<string | undefined> {
  try {
    const { stdout } = await pexec("gh", ["api", "user", "--jq", ".login"], { timeout: 8000, windowsHide: true });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** gh 是否可用（决定「连接」界面给哪种方式） */
export async function ghAvailable(): Promise<{ ok: boolean; user?: string }> {
  const user = await ghUser();
  return user ? { ok: true, user } : { ok: false };
}

/* ============================================================
 * 连接
 * ============================================================ */

export interface ConnectInput {
  /** 仓库名（不含 owner） */
  repo: string;
  /** true = 私有仓库。默认私有。 */
  private?: boolean;
  /** 组织名；留空推到自己名下 */
  owner?: string;
}

export interface ConnectResult {
  ok: boolean;
  error?: string;
  url?: string;
  /** 已经建好但推送失败——仓库在，稿子没上去，要如实说 */
  repoCreated?: boolean;
}

/**
 * 一键连接：建仓库 → 设远端 → 推第一版。
 *
 * 三步都可能失败，且失败含义完全不同，不能合成一个「连接失败」：
 *   - 建仓库失败 → 作者要改名字或换账号
 *   - 设远端失败 → 本地 .git 有问题
 *   - 推送失败 → 仓库已建好，重试推送即可（不能让他以为白建了）
 */
export async function connect(
  store: ProjectStore,
  secrets: vscode.SecretStorage,
  input: ConnectInput,
): Promise<ConnectResult> {
  const root = store.root?.fsPath;
  if (!root) return { ok: false, error: "请先打开一个作品" };

  const cred = await resolveCredential(secrets, { interactive: true });
  if (!cred) return { ok: false, error: "没有可用的 GitHub 凭据" };

  const repo = input.repo.trim();
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo)) {
    return { ok: false, error: "仓库名只能包含字母、数字、点、下划线和连字符" };
  }

  /* ---- 1. 建仓库 ---- */
  const created = await createRepo(cred, {
    name: repo,
    private: input.private !== false,
    owner: input.owner?.trim() || undefined,
  });
  if (!created.ok) return { ok: false, error: created.error };

  /* ---- 2. 设远端 ---- */
  // 必须先确保仓库存在：作者可能刚建作品、一个字没写就点了连接，
  // 那时 `.git` 还没被我们的懒初始化创建出来，`git remote add` 会直接失败。
  try {
    await ensureRepo(nodeExec, root);
  } catch (e) {
    return { ok: false, repoCreated: true, url: `https://github.com/${created.fullName}`, error: `本地版本库建不起来：${(e as Error).message}` };
  }

  const url = `https://github.com/${created.fullName}.git`;
  const set = await setRemote(nodeExec, root, "origin", url);
  if (!set.ok) {
    return {
      ok: false,
      repoCreated: true,
      url: `https://github.com/${created.fullName}`,
      error: `仓库建好了，但本地没连上：${set.error}`,
    };
  }

  /* ---- 3. 推第一版 ---- */
  const pushed = await pushWithCred(store, cred);
  if (!pushed.ok) {
    return {
      ok: false,
      repoCreated: true,
      url: `https://github.com/${created.fullName}`,
      error: `仓库建好了（${created.fullName}），但稿子没推上去：${pushed.error}。稍后点「备份到云端」重试即可。`,
    };
  }

  await secrets.store(SECRET_TOKEN, cred.token);
  await secrets.store(SECRET_USER, cred.username);

  return { ok: true, url: `https://github.com/${created.fullName}` };
}

interface CreateRepoOut {
  ok: boolean;
  fullName?: string;
  error?: string;
}

/**
 * 建仓库。
 *
 * 优先用 `gh repo create`（它有现成的登录态与组织权限处理）。
 * 没有 gh 时退回 REST API——这就是自己拼一个 POST，不值得引 octokit。
 */
async function createRepo(cred: HostCredential, opts: { name: string; private: boolean; owner?: string }): Promise<CreateRepoOut> {
  if (cred.from === "gh") {
    try {
      const args = ["repo", "create", opts.owner ? `${opts.owner}/${opts.name}` : opts.name, opts.private ? "--private" : "--public", "--description", "NovelPad 作品"];
      // 不带 --source：我们只想建一个空仓库，本地这边自己 set remote + push，
      // 否则 gh 会顺手做一次它自己的初始化，和我们的 refs/novelpad/* 打架。
      const { stdout } = await pexec("gh", args, { timeout: 30_000, windowsHide: true });
      const url = /(https:\/\/github\.com\/[^\s]+)/.exec(stdout)?.[1];
      if (!url) return { ok: false, error: "仓库建好了，但没读出地址" };
      return { ok: true, fullName: url.replace("https://github.com/", "").replace(/\.git$/, "") };
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? (e as Error).message ?? "");
      return { ok: false, error: explainCreateError(msg, opts.name) };
    }
  }

  // REST 兜底
  const body = JSON.stringify({ name: opts.name, private: opts.private, description: "NovelPad 作品", auto_init: false });
  const res = await fetch("https://api.github.com/user/repos", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cred.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "NovelPad",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, error: explainCreateError(text, opts.name) };
  }
  const json = (await res.json()) as { full_name?: string };
  return json.full_name ? { ok: true, fullName: json.full_name } : { ok: false, error: "仓库建好了，但没读出地址" };
}

/* ============================================================
 * 凭据解析
 * ============================================================ */

/**
 * 拿到可用凭据。
 *
 * 顺序：SecretStorage → gh CLI →（interactive 时）问作者要 token。
 * 用 gh 的凭据时会顺手存进 SecretStorage：下次 gh 没登录也能用。
 */
export async function resolveCredential(
  secrets: vscode.SecretStorage,
  opts: { interactive?: boolean } = {},
): Promise<HostCredential | undefined> {
  const saved = await secrets.get(SECRET_TOKEN);
  if (saved) {
    const user = (await secrets.get(SECRET_USER)) ?? "x-access-token";
    return { token: saved, username: user, from: "manual" };
  }

  const gh = await fromGh();
  if (gh) return gh;

  if (!opts.interactive) return undefined;

  const token = await vscode.window.showInputBox({
    title: "连接 GitHub",
    prompt: "粘贴一个 GitHub Personal Access Token（需要 repo 权限）",
    placeHolder: "ghp_…  /  github_pat_…",
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().length < 10 ? "这个太短了，不像是令牌" : undefined),
  });
  if (!token) return undefined;

  const user = await githubUserOf(token.trim());
  if (!user) {
    void vscode.window.showErrorMessage("这个令牌无效，或者没有读取账号的权限。");
    return undefined;
  }
  return { token: token.trim(), username: user, from: "manual" };
}

async function githubUserOf(token: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "NovelPad" },
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { login?: string };
    return j.login;
  } catch {
    return undefined;
  }
}

/* ============================================================
 * 推送 / 拉取
 * ============================================================ */

async function pushWithCred(
  store: ProjectStore,
  cred: HostCredential | undefined,
): Promise<{ ok: boolean; error?: string; url?: string }> {
  const root = store.root?.fsPath;
  if (!root) return { ok: false, error: "请先打开一个作品" };
  const remote = vscode.workspace.getConfiguration("novelpad").get<string>("host.remote", "origin");

  /*
   * 推之前先把主干同步到此刻的稿子。
   *
   * 这一步不能省：自动存档挂在 `refs/novelpad/auto/…`，**不在任何分支上**，
   * `git push` 永远不会带走它们。少了这次同步，作者写完三小时直接点备份，
   * 推上去的是上次「存一版」时的内容，而界面会告诉他"已备份"。
   *
   * 顺序也是有意为之：先 flush 待落盘的编辑（saveNow），再同步主干，
   * 最后推。反过来会把「编辑器里改了但还没存档」的内容算进主干，
   * 那与作者看到的时间线不一致。
   */
  await vscode.commands.executeCommand("novelpad.version.saveNow");
  let trunkSkipped: string | undefined;
  try {
    await ensureRepo(nodeExec, root);
    const sync = await syncTrunk(nodeExec, root);
    if (!sync.ok) {
      // 同步失败不等于不能推：主干维持在上次的位置，推它仍然有意义
      // （至少里程碑不丢）。所以这里记下原因，继续推。
      trunkSkipped = sync.error ?? sync.skipped;
    } else if (sync.skipped) {
      trunkSkipped = sync.skipped;
    }
  } catch (e) {
    trunkSkipped = e instanceof Error ? e.message : String(e);
  }

  const r = await push(nodeExec, {
    root,
    remote,
    // 没有可用凭据时不传 token：让 git 用它自己的 credential helper
    // （GitHub Desktop / GCM 常常已经配好）。传空串会让 askpass 脚本
    // 吐出一个空密码，那比没有凭据更糟。
    token: cred?.token || undefined,
    username: cred?.username || undefined,
    setUpstream: true,
  });
  if (!r.ok) return { ok: false, error: r.error, url: r.url };
  // 推成功了但最近的内容没进主干——必须说，否则作者以为已经备份好了
  if (trunkSkipped) return { ok: false, error: `云端只到上一版：${trunkSkipped}`, url: r.url };
  return { ok: true, url: r.url };
}

/** 「备份到云端」：没配远端就引导去连接；有内容才推 */
export async function backup(store: ProjectStore, secrets: vscode.SecretStorage): Promise<{ ok: boolean; message: string }> {
  const root = store.root?.fsPath;
  if (!root) return { ok: false, message: "请先打开一个作品" };

  const remoteName = vscode.workspace.getConfiguration("novelpad").get<string>("host.remote", "origin");
  const remotes = await listRemotes(nodeExec, root);
  if (!remotes.some((r) => r.name === remoteName)) {
    return { ok: false, message: "还没有连接到云端。先点「连接到 GitHub」。" };
  }

  const cred = await resolveCredential(secrets, { interactive: true });
  if (!cred) return { ok: false, message: "没有可用的 GitHub 凭据" };

  // 存档与主干同步都在 pushWithCred 里做（所有推送路径共用一套顺序）
  const r = await pushWithCred(store, cred);
  if (!r.ok) return { ok: false, message: r.error ?? "推送失败" };
  return { ok: true, message: "已备份到云端" };
}

/** 「从云端取回」：只做快进，绝不自动合并 */
export async function restore(store: ProjectStore, secrets: vscode.SecretStorage): Promise<{ ok: boolean; message: string }> {
  const root = store.root?.fsPath;
  if (!root) return { ok: false, message: "请先打开一个作品" };

  const remotes = await listRemotes(nodeExec, root);
  if (!remotes.length) return { ok: false, message: "还没有连接到云端" };

  const cred = await resolveCredential(secrets, { interactive: false });
  const r = await pull(nodeExec, root, {
    token: cred?.token,
    username: cred?.username,
  });
  if (!r.ok) return { ok: false, message: r.error ?? "取回失败" };

  /*
   * 取回之后把云端新来的版本补进时间线。
   *
   * 这一步必须**在判断 updated 之前**做：新机器 clone 完第一次点取回时，
   * 正文往往已经是最新的（clone 拿到了分支），`updated` 是 false，
   * 但里程碑 ref 是这次 fetch 才回来的——提前返回的话，时间线在
   * 最需要它的那台机器上永远是空的。
   *
   * 用 backfillFromRefs 而不是 rebuildIndex：后者会把已有记录的标签、
   * 备注、字数、AI 来源一起冲掉（那些信息 ref 名里推不出来）。
   */
  const { added } = await backfillFromRefs(nodeExec, root);

  if (!r.updated && !added) return { ok: true, message: "云端没有新的东西" };

  await store.refresh();
  return {
    ok: true,
    message: added
      ? `已取回云端的改动，时间线补回 ${added} 版`
      : "已取回云端的改动",
  };
}

/* ============================================================
 * 状态
 * ============================================================ */

export interface HostStatus {
  /** 有没有远端 */
  connected: boolean;
  remote?: RemoteInfo;
  preview?: PushPreview;
  /** 有没有可用凭据（不判断是否有效，只看有没有） */
  hasCredential: boolean;
}

export async function status(store: ProjectStore, secrets: vscode.SecretStorage): Promise<HostStatus> {
  const root = store.root?.fsPath;
  if (!root) return { connected: false, hasCredential: false };

  const remoteName = vscode.workspace.getConfiguration("novelpad").get<string>("host.remote", "origin");
  const remotes = await listRemotes(nodeExec, root);
  const remote = remotes.find((r) => r.name === remoteName);
  const hasCredential = Boolean((await secrets.get(SECRET_TOKEN)) ?? (await fromGh()));

  if (!remote) return { connected: false, hasCredential };

  const preview = await pushPreview(nodeExec, root);
  return { connected: true, remote, preview, hasCredential };
}

/** 人话状态，给状态栏用 */

/* ============================================================
 * 交互入口
 * ============================================================ */

/**
 * 「连接到 GitHub」命令。
 *
 * 装了 gh 就直接一路问到底；没装就提示去装或粘 token——
 * 但**不要**在第一次点击时就弹一个空白输入框，作者不知道要粘什么。
 */
export async function connectInteractive(store: ProjectStore, secrets: vscode.SecretStorage): Promise<void> {
  const root = store.root?.fsPath;
  if (!root) return void vscode.window.showWarningMessage("请先打开一个作品");

  // 先确认仓库边界：作品若埋在别人的仓库里，推上去会连带整个仓库。
  // 这一步必须在建仓库之前做——仓库已经建好了再拦，作者会以为白建了。
  const layout = await repoLayout(nodeExec, root);
  if (layout) {
    const problem = hostingProblem(layout.toplevel, root);
    if (problem) return void vscode.window.showErrorMessage(problem);
  }

  // 已经连过：问要不要换
  const existing = await listRemotes(nodeExec, root);
  const origin = existing.find((r) => r.name === "origin");
  if (origin) {
    const action = await vscode.window.showInformationMessage(
      `已经连接到 ${origin.displayUrl}。要换成别的仓库吗？`,
      "换一个",
      "取消",
    );
    if (action !== "换一个") return;
  }

  const gh = await ghAvailable();
  if (!gh.ok) {
    const how = await vscode.window.showInformationMessage(
      "没检测到已登录的 GitHub CLI。可以装一个（命令行 gh auth login），或者直接粘一个访问令牌。",
      "粘令牌",
      "看怎么装",
      "取消",
    );
    if (how === "看怎么装") {
      void vscode.env.openExternal(vscode.Uri.parse("https://cli.github.com/"));
      return;
    }
    if (how !== "粘令牌") return;
  }

  const name = await vscode.window.showInputBox({
    title: "连接到 GitHub",
    prompt: "在 GitHub 上给这部作品起个仓库名",
    value: suggestRepoName(store.project?.config.title ?? ""),
    ignoreFocusOut: true,
    validateInput: (v) => {
      if (!v.trim()) return "写个名字";
      if (!/^[A-Za-z0-9._-]+$/.test(v.trim())) return "只能用字母、数字、点、下划线和连字符";
      return undefined;
    },
  });
  if (!name) return;

  const vis = await vscode.window.showQuickPick(
    [
      { label: "私有仓库", description: "只有你和被邀请的人能看（推荐）", value: true },
      { label: "公开仓库", description: "任何人都能看到你的稿子", value: false },
    ],
    { title: "谁能看这个仓库？", placeHolder: "写小说一般选私有" },
  );
  if (!vis) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "正在连接 GitHub…", cancellable: false },
    async (progress) => {
      progress.report({ message: "建仓库" });
      const r = await connect(store, secrets, { repo: name.trim(), private: vis.value });
      if (!r.ok) {
        const action = await vscode.window.showErrorMessage(r.error ?? "连接失败", r.url ? "打开仓库" : "知道了");
        if (action === "打开仓库" && r.url) void vscode.env.openExternal(vscode.Uri.parse(r.url));
        return;
      }
      const action = await vscode.window.showInformationMessage(`已连接到 ${r.url}`, "打开仓库");
      if (action === "打开仓库" && r.url) void vscode.env.openExternal(vscode.Uri.parse(r.url));
    },
  );
}

/**
 * 建议一个仓库名。
 *
 * GitHub 仓库名只能是 ASCII，而作品名通常是中文——直接用会把
 * 中文全删掉变成空串，或者被自己的校验挡住。纯逻辑见 host-rules.ts。
 */

/** 状态栏文案 + 命令 */
export class HostStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: ProjectStore,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    this.item.command = "novelpad.host.status";
  }

  start(): void {
    this.refresh();
    // 30s 一次：预算很小（两次 git 子进程），但足以让「N 版待备份」
    // 在作者写完一段后变成「已同步」
    this.timer = setInterval(() => this.refresh(), 30_000);
  }

  async refresh(): Promise<void> {
    const root = this.store.root?.fsPath;
    if (!root) {
      this.item.hide();
      return;
    }
    try {
      const s = await status(this.store, this.secrets);
      this.item.text = s.connected ? `$(cloud) ${describeStatus(s)}` : "$(cloud-offline) 未连接云端";
      // tooltip 用 backupHint：它会额外提醒「有改动还没存进版本库，
      // 备份前会自动存一版」。作者看到「已同步」时最容易误会成
      // 「现在写的也备份好了」，那句提醒就是防这个。
      this.item.tooltip = s.connected
        ? `${s.remote?.displayUrl ?? ""}\n${backupHint(s)}\n点击查看托管状态`
        : "点击连接到 GitHub，给稿子做个云端备份";
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.item.dispose();
  }
}

/** 仓库根相对作品：拿给 git 用的前缀；状态展示也用 */
export async function repoPrefixHint(root: string): Promise<string> {
  const l = await repoLayout(nodeExec, root);
  return l?.prefix ?? "";
}

/* ============================================================
 * 自动备份
 * ============================================================ */

/**
 * 存档后自动推送，对应设置 `novelpad.host.autoPush`。
 *
 * 几个必要的克制：
 *   - 只在**作者自己的存档之后**触发，不是定时轮询。定时推送会在
 *     作者深夜写敏感内容时不断上传，那感觉像被监视。
 *   - 失败**静默**。网络断了就断了，下次存档时再试；弹错误框会让
 *     作者以为稿子出了问题。只有连续失败才在状态栏留个记号。
 *   - 同一时间只允许一个推送在飞。存档很快（30s 合并一次），
 *     而推送可能要几十秒，不排队会并发起一堆 git 进程。
 */
export class AutoPusher implements vscode.Disposable {
  private busy = false;
  private queued = false;
  private disposed = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly secrets: vscode.SecretStorage,
    private readonly onState?: (state: "pushing" | "done" | "failed" | "idle") => void,
  ) {}

  /** 存档之后调用。没开自动备份、没连远端时什么都不做。 */
  async afterSave(): Promise<void> {
    if (this.disposed) return;
    if (!vscode.workspace.getConfiguration("novelpad").get<boolean>("host.autoPush", false)) return;

    if (this.busy) {
      // 正在推：这一轮的改动留给下一次存档，不排队堆积。
      // 堆起来后一旦网络恢复会连推十几版，作者看到的进度条会一直转。
      this.queued = true;
      return;
    }

    const s = await status(this.store, this.secrets);
    if (!s.connected) return;
    if (!s.preview?.dirty && s.preview?.ahead === 0) return; // 没东西可推

    this.busy = true;
    this.onState?.("pushing");
    try {
      const cred = await resolveCredential(this.secrets, { interactive: false });
      const r = await pushWithCred(this.store, cred ?? { token: "", username: "", from: "manual" });
      this.onState?.(r.ok ? "done" : "failed");
      // 失败不打扰作者：网络问题居多，下次存档会自动重试
    } catch {
      this.onState?.("failed");
    } finally {
      this.busy = false;
      if (this.queued && !this.disposed) {
        this.queued = false;
        void this.afterSave();
      } else {
        this.onState?.("idle");
      }
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}

/**
 * 检查「这个目录能不能安全地托管」。
 *
 * 关键风险：作品根可能**不是**仓库根。作者的 `~/writing` 下可能有好几部
 * 小说、一堆无关文件，甚至整个 home 目录都被 `git init` 过。那种情况下
 * `git push` 会把整个仓库推上去——包括他没打算公开的东西。
 *
 * 所以托管前必须确认：仓库根就是作品根。纯逻辑在 host-rules.ts。
 */