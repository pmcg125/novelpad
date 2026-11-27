/**
 * 托管层的纯逻辑（无 vscode 依赖，可在 vitest 里加载）。
 *
 * 为什么单独一个文件：`host.ts` 引了 vscode，一旦在同一个文件里
 * 写纯函数，测试就加载不了它。这与 `worktree.ts` / `branches.ts`
 * 的拆分是同一个理由。
 */
import type { PushPreview } from "@novelpad/core";

/* ============================================================
 * 仓库名
 * ============================================================ */

/**
 * 从作品名推一个 GitHub 仓库名。
 *
 * 坑：中文小说名占绝大多数，而 GitHub 仓库名只接受 ASCII。
 * 简单 `replace(/[^a-z0-9]/g, '-')` 会把《长夜将明》变成空串，
 * 于是作者看到输入框里一片空白，不知道该填什么。
 *
 * 所以：ASCII 名能用就用；不能用则退回带日期的稳定名——
 * 至少它合法、可读、不重名。
 */
export function suggestRepoName(title: string, today: Date = new Date()): string {
  const ascii = title
    .trim()
    .toLowerCase()
    // 先按「非字母数字」切，再合并连续分隔符
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  // 至少两个字符：`a` 这种太容易撞名，也不像作品名
  if (ascii.length >= 2) return ascii;

  const stamp = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, "0")}${String(today.getDate()).padStart(2, "0")}`;
  return `novelpad-${stamp}`;
}

/** GitHub 仓库名的合法字符集 */
export function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9._-]{1,100}$/.test(name.trim());
}

/* ============================================================
 * 仓库边界
 * ============================================================ */

/**
 * 判断作品能不能安全托管。
 *
 * 真实风险不是理论上的：作者的 `~/Documents` 很可能被某个工具
 * `git init` 过，或者他把好几部小说放在同一个 `~/写作` 仓库里。
 * 那种情况下 `git push` 会推整个仓库——包括日记、合同、别的作品。
 * 这是不可逆的信息泄露，且作者点「备份」时完全想不到。
 *
 * 所以仓库根必须**就是**作品根。不是就拦住并说清原因。
 */
export function hostingProblem(toplevel: string | undefined, root: string): string | undefined {
  if (!toplevel) return undefined; // 还没建仓库，稍后 ensureRepo 会建

  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = norm(toplevel);
  const b = norm(root);
  // Windows 盘符与路径大小写不敏感
  const same = process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (same) return undefined;

  return `这个作品放在另一个 git 仓库里面（${toplevel}）。直接托管会把整个仓库都推上去——包括和这部作品无关的文件。请先把作品单独放一个文件夹。`;
}

/* ============================================================
 * 错误翻译
 * ============================================================ */

/** 建仓库失败的原因，翻成作者能据此动手的话 */
export function explainCreateError(raw: string, name: string): string {
  const s = raw.toLowerCase();

  if (/name already exists|already been taken|"errors"/.test(s) && /already/.test(s)) {
    return `已经有一个叫「${name}」的仓库了。换个名字，或者连到已有的那个。`;
  }
  if (/bad credentials|401/.test(s)) {
    return "GitHub 不认这个账号，令牌可能过期了。重新连接一次。";
  }
  if (/resource not accessible|403|scope/.test(s)) {
    return "令牌权限不够。建仓库需要 repo（或 public_repo）权限。";
  }
  if (/could not resolve host|enotfound|econnrefused|network|timeout/i.test(raw)) {
    return "连不上 GitHub，检查一下网络再试。";
  }
  if (/name is invalid|invalid name/.test(s)) {
    return `「${name}」不是合法的仓库名。只能用字母、数字、点、下划线和连字符。`;
  }
  return raw.trim() || "建仓库失败，原因不明";
}

/* ============================================================
 * 状态文案
 * ============================================================ */

export interface HostStatusView {
  connected: boolean;
  preview?: PushPreview;
}

/**
 * 状态栏文案。
 *
 * 不用「ahead / behind / upstream」——作者不知道这些词。
 * 说「N 版待备份」「云端有新的」，他才知道自己该点什么。
 */
export function describeStatus(s: HostStatusView): string {
  if (!s.connected) return "未连接云端";
  const p = s.preview;
  if (!p) return "已连接";
  if (!p.hasUpstream) return "还没推过第一版";
  if (p.ahead > 0 && p.behind > 0) return `${p.ahead} 版待备份 · 云端也有新的`;
  if (p.ahead > 0) return `${p.ahead} 版待备份`;
  if (p.behind > 0) return `云端有 ${p.behind} 版新的`;
  return "已同步";
}

/**
 * 「待备份」里是否真的包含正文改动。
 *
 * `ahead > 0` 只说明有提交没推——但作者可能只改了大纲或删了张图。
 * 提示文案不必区分到这个粒度，但 dirty 时必须提醒「先存档再备份」，
 * 否则推上去的是上次保存的内容，他会以为备份白做了。
 */
export function backupHint(s: HostStatusView): string {
  if (!s.connected) return "还没连接到云端";
  if (!s.preview) return "已连接";
  if (s.preview.dirty) return "有改动还没存进版本库，备份前会自动存一版";
  return describeStatus(s);
}