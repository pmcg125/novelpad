/**
 * 支线管理（共创 B：分工合写）。
 *
 * 把 core 的 git 层接到编辑器上：
 *   - 新建支线 → 建分支 + worktree + 在新窗口打开
 *   - 支线列表（树视图）→ 显示未合并提交数、打开的目录
 *   - 合并支线 → 打开合并界面
 *
 * 关键的 UX 决定：**作者不该看见 branch / worktree / merge 这些词**。
 * 界面上是「支线」「并回主稿」「这条线还没并回来」。
 */
import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import {
  applyMerge,
  chapterComparison,
  compareBranches,
  createBranch,
  currentBranch,
  deleteBranch,
  detectDefaultBranch,
  detectGit,
  ensureBaseline,
  excludeLocalIndex,
  listBranches,
  nodeExec,
  planMerge,
  pruneWorktrees,
  repoLayout,
  unbornBranch,
  unmergedCommits,
  worktreeDirty,
  type BranchInfo,
  type MergeAction,
  type MergeDecision,
  type MergePlanItem,
} from "@novelpad/core";
import {
  addWorktree,
  fullBranchName,
  isRenamed,
  listWorktrees,
  prettyBranch,
  removeWorktree,
  sanitizeBranchName,
  whyNameUnusable,
  type BranchPrefix,
  type WorktreeInfo,
} from "./worktree.js";
import type { ProjectStore } from "../store";

/* ============================================================
 * 树视图
 * ============================================================ */

export interface BranchNode {
  kind: "branch" | "worktree" | "hint";
  label: string;
  description?: string;
  branch?: BranchInfo;
  worktree?: WorktreeInfo;
  /** 支线相对主稿的未合并提交数 */
  ahead?: number;
  tooltip?: string;
}

export class BranchesProvider implements vscode.TreeDataProvider<BranchNode> {
  private readonly _onDidChange = new vscode.EventEmitter<BranchNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private nodes: BranchNode[] = [];

  constructor(private readonly store: ProjectStore) {}

  refresh(): void {
    void this.reload().then(() => this._onDidChange.fire(undefined));
  }

  private async reload(): Promise<void> {
    const root = this.store.root?.fsPath;
    if (!root) {
      this.nodes = [];
      return;
    }

    try {
      await ensureRepoQuiet(root);
      const base = (await detectDefaultBranch(nodeExec, root)) ?? "main";
      const branches = await listBranches(nodeExec, root, base);
      const worktrees = await listWorktrees(nodeExec, root, existsSync);

      // 一个分支至多一个 worktree，反过来映射便于取目录
      const wtByBranch = new Map<string, WorktreeInfo>();
      for (const w of worktrees) if (w.branch) wtByBranch.set(w.branch, w);

      const nodes: BranchNode[] = [];
      for (const b of branches) {
        // 主线不列在「支线」里
        if (b.name === base) continue;
        const ahead = await unmergedCommits(nodeExec, root, b.name, base);
        const dir = wtByBranch.get(b.name)?.dir;
        nodes.push({
          kind: "branch",
          label: prettyBranch(b.name),
          description: ahead > 0 ? `${ahead} 版未并回` : "已并回主稿",
          branch: b,
          ahead,
          tooltip: dir ? `独立窗口：${dir}` : "还没打开成独立窗口",
        });
      }

      // 有 worktree 但分支已被删（作者手工操作过）→ 单独列出，别让它变成孤儿
      const orphan = worktrees.filter(
        (w) => !w.main && (!w.branch || !branches.some((b) => b.name === w.branch)),
      );
      for (const w of orphan) {
        nodes.push({
          kind: "worktree",
          label: path.basename(w.dir),
          description: w.exists ? "目录已不在版本库的分支上" : "目录已被删除",
          worktree: w,
        });
      }

      if (!nodes.length) {
        nodes.push({
          kind: "hint",
          label: "还没有支线",
          description: "点右上角新建",
          tooltip: "支线用于分工合写：一人一条线，各写各的，写完并回主稿。",
        });
      }

      this.nodes = nodes;
    } catch {
      this.nodes = [{ kind: "hint", label: "读取支线失败", description: "点刷新重试" }];
    }
  }

  getTreeItem(node: BranchNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
    item.description = node.description;
    item.tooltip = node.tooltip;
    item.contextValue =
      node.kind === "branch" ? "novelpadBranch" : node.kind === "worktree" ? "novelpadWorktree" : "novelpadHint";

    if (node.kind === "branch" && node.branch) {
      item.iconPath = new vscode.ThemeIcon(node.ahead && node.ahead > 0 ? "git-branch" : "check");
      item.command = {
        command: "novelpad.branch.open",
        title: "打开合并界面",
        arguments: [node.branch.name],
      };
    } else if (node.kind === "worktree") {
      item.iconPath = new vscode.ThemeIcon("folder");
    } else {
      item.iconPath = new vscode.ThemeIcon("info");
    }
    return item;
  }

  getChildren(element?: BranchNode): BranchNode[] {
    return element ? [] : this.nodes;
  }
}

/** `line/林晚照` → `林晚照`；`alt/结局二` → `备选：结局二` */
export { prettyBranch };

/* ============================================================
 * 交互
 * ============================================================ */

export class BranchManager implements vscode.Disposable {
  readonly provider: BranchesProvider;

  constructor(private readonly store: ProjectStore) {
    this.provider = new BranchesProvider(store);
  }

  /** 「新建支线」：问名字 → 建分支 → 建 worktree → 新窗口打开 */
  async create(): Promise<void> {
    const root = this.store.root?.fsPath;
    if (!root) {
      void vscode.window.showWarningMessage("请先打开一个作品");
      return;
    }

    const name = await vscode.window.showInputBox({
      prompt: "这条支线叫什么？（比如「林晚照线」「第七结局备选」）",
      placeHolder: "支线名字",
      validateInput: (v) => whyNameUnusable(v),
    });
    if (!name) return;

    const prefix = await vscode.window.showQuickPick(
      [
        { label: "人物线", description: "从某个角色的视角推进", value: "line" as BranchPrefix },
        { label: "备选走向", description: "试写另一种可能，不满意可以丢掉", value: "alt" as BranchPrefix },
      ],
      { placeHolder: "这条支线是" },
    );
    if (!prefix) return;

    const branch = fullBranchName(prefix.value, name);
    if (isRenamed(name)) {
      const ok = await vscode.window.showInformationMessage(
        `名字会被整理成「${sanitizeBranchName(name)}」，可以吗？`,
        "可以",
        "重填",
      );
      if (ok !== "可以") {
        await this.create();
        return;
      }
    }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在新建支线…" },
      async () => {
        await ensureRepoQuiet(root);
        // 先补基线：作者从没提交过时 main 是未出生分支，
        // 直接建 worktree 会得到一个空目录——他打开看到空白，以为稿子丢了。
        const created = await createBranch(nodeExec, root, branch);
        if (!created.ok) {
          void vscode.window.showErrorMessage(`建支线失败：${created.error}`);
          return;
        }

        const wt = await addWorktree(nodeExec, root, branch);
        if (!wt.ok || !wt.dir) {
          void vscode.window.showErrorMessage(`建目录失败：${wt.error}`);
          return;
        }

        this.provider.refresh();

        const action = await vscode.window.showInformationMessage(
          `支线「${prettyBranch(branch)}」已建好，目录在 ${wt.dir}`,
          "在新窗口打开",
        );
        if (action === "在新窗口打开") {
          await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wt.dir), {
            forceNewWindow: true,
          });
        }
      },
    );
  }

  /**
   * 打开合并界面。
   *
   * 这里是「按章挑选」的入口——不是 git merge。
   */
  async openMerge(source: string): Promise<void> {
    const root = this.store.root?.fsPath;
    if (!root) return;
    await ensureRepoQuiet(root);

    const base = (await detectDefaultBranch(nodeExec, root)) ?? "main";
    if (source === base) {
      void vscode.window.showInformationMessage("这是主稿，不用合并");
      return;
    }

    const { openMergeView } = await import("../views/merge.js");
    openMergeView(this.store, this, source);
  }

  /** 打开这条支线的独立目录（已存在时直接开，不重建） */
  async openWorktree(branch: string): Promise<void> {
    const root = this.store.root?.fsPath;
    if (!root) return;
    await ensureRepoQuiet(root);

    const wts = await listWorktrees(nodeExec, root, existsSync);
    const hit = wts.find((w) => w.branch === branch && w.exists);
    if (hit) {
      await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(hit.dir), {
        forceNewWindow: true,
      });
      return;
    }

    // 目录不在了（作者删了，或从没建过）→ 建一个
    const wt = await addWorktree(nodeExec, root, branch);
    if (!wt.ok || !wt.dir) {
      void vscode.window.showErrorMessage(`打开失败：${wt.error}`);
      return;
    }
    this.provider.refresh();
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(wt.dir), {
      forceNewWindow: true,
    });
  }

  /** 删除支线：先查未合并提交与未保存改动，明确确认才动手 */
  async remove(branch: string): Promise<void> {
    const root = this.store.root?.fsPath;
    if (!root) return;
    await ensureRepoQuiet(root);

    const base = (await detectDefaultBranch(nodeExec, root)) ?? "main";
    const ahead = await unmergedCommits(nodeExec, root, branch, base);

    const wts = await listWorktrees(nodeExec, root, existsSync);
    const wt = wts.find((w) => w.branch === branch);
    const dirty = wt?.exists ? await worktreeDirty(nodeExec, wt.dir) : false;

    const warnings: string[] = [];
    if (ahead > 0) warnings.push(`这条线上还有 ${ahead} 版没并回主稿`);
    if (dirty) warnings.push("那个目录里还有没保存进版本库的改动");

    const msg = warnings.length
      ? `${warnings.join("；")}。删掉就找不回来了。`
      : `确定删掉支线「${prettyBranch(branch)}」？`;

    const ok = await vscode.window.showWarningMessage(msg, { modal: true }, "删掉");
    if (ok !== "删掉") return;

    if (wt?.exists) {
      const r = await removeWorktree(nodeExec, root, wt.dir, { force: dirty });
      if (!r.ok) {
        // 目录被占用（作者正开着那个窗口）→ 提示关掉再试，不要强删
        void vscode.window.showErrorMessage(
          `删除目录失败：${r.error}\n如果那个窗口还开着，先关掉它。`,
        );
        return;
      }
    }

    const del = await deleteBranch(nodeExec, root, branch, { force: ahead > 0 || dirty });
    if (!del.ok) {
      void vscode.window.showErrorMessage(`删分支失败：${del.error}`);
      return;
    }

    this.provider.refresh();
  }

  /**
   * 把支线选定的章节并回主稿。
   *
   * `materialize` 在这里做：把来源分支的文件写到作者当前工作区。
   * 内核不碰文件系统写操作，只负责算该取哪一版并造提交。
   */
  async merge(
    source: string,
    decisions: readonly MergeDecision[],
    summary: string,
  ): Promise<{ ok: boolean; written: number; message?: string }> {
    const root = this.store.root?.fsPath;
    if (!root) return { ok: false, written: 0, message: "没有打开作品" };
    await ensureRepoQuiet(root);

    const base = (await detectDefaultBranch(nodeExec, root)) ?? "main";
    const layout = await repoLayout(nodeExec, root);

    const result = await applyMerge(
      nodeExec,
      root,
      {
        source,
        // 合并结果挂到主稿分支上：作者点「并回主稿」就该真的并回去
        targetRef: `refs/heads/${base}`,
        decisions,
        summary,
        prefix: layout?.prefix,
      },
      async (file, action: MergeAction) => {
        const repoPath = layout?.prefix ? `${layout.prefix}${file}` : file;
        const diskPath = path.join(root, ...file.split("/"));

        if (action === "delete") {
          fs.rmSync(diskPath, { force: true });
          return;
        }

        const r = await nodeExec(["show", `${source}:${repoPath}`], { cwd: root, timeoutMs: 30_000 });
        if (r.code !== 0) throw new Error(`读不到 ${file} 的支线版本`);
        fs.mkdirSync(path.dirname(diskPath), { recursive: true });
        fs.writeFileSync(diskPath, r.stdout, "utf8");
      },
    );

    if (!result.ok) return { ok: false, written: 0, message: result.error };

    // 合并后要刷新：工作区文件变了，章节树与字数都对不上
    this.store.scheduleRefresh(0);
    this.provider.refresh();

    if (result.empty) return { ok: true, written: 0, message: "没有需要写入的改动" };
    return { ok: true, written: result.written };
  }

  /**
   * 支线相对主稿的逐章对比（供合并界面用）。
   * 抽在这里是为了让 webview 不直接碰 core。
   */
  async compare(source: string): Promise<
    | {
        ok: true;
        base: string;
        conflicts: number;
        takeable: number;
        totalDelta: number;
        chapters: MergePlanItem[];
      }
    | { ok: false; message: string }
  > {
    const root = this.store.root?.fsPath;
    if (!root) return { ok: false, message: "没有打开作品" };
    await ensureRepoQuiet(root);

    const base = (await detectDefaultBranch(nodeExec, root)) ?? "main";
    const layout = await repoLayout(nodeExec, root);
    const cmp = await compareBranches(nodeExec, root, base, source, layout?.prefix);

    return {
      ok: true,
      base,
      conflicts: cmp.conflicts,
      takeable: cmp.takeable,
      totalDelta: cmp.totalDelta,
      chapters: planMerge(cmp),
    };
  }

  /** 取某章在两边的全文，供冲突章节人工挑 */
  async chapter(source: string, file: string): Promise<{ targetText: string; sourceText: string } | undefined> {
    const root = this.store.root?.fsPath;
    if (!root) return undefined;
    await ensureRepoQuiet(root);

    const base = (await detectDefaultBranch(nodeExec, root)) ?? "main";
    const layout = await repoLayout(nodeExec, root);
    const cmp = await chapterComparison(nodeExec, root, base, source, file, layout?.prefix);
    return { targetText: cmp.targetText, sourceText: cmp.sourceText };
  }

  dispose(): void {
    /* 没有长驻资源；provider 由调用方持有 */
  }
}

/** 当前分支短名（状态栏用） */
export async function currentBranchName(root: string): Promise<string | undefined> {
  return currentBranch(nodeExec, root);
}

/**
 * 可并回的支线（不含主稿）。
 *
 * 命令面板里的「并回主稿」没有参数，需要先让作者选一条。
 * 返回值过滤掉主稿本身，并按「未合并提交数」排前面——作者最可能
 * 想并的正是那条还没并回来的。
 */
export async function listMergeableBranches(root: string): Promise<string[]> {
  await ensureRepoQuiet(root);
  const base = (await detectDefaultBranch(nodeExec, root)) ?? "main";
  const all = await listBranches(nodeExec, root, base);
  const rest = all.filter((b) => b.name !== base);

  const scored: { name: string; ahead: number }[] = [];
  for (const b of rest) {
    scored.push({ name: b.name, ahead: await unmergedCommits(nodeExec, root, b.name, base) });
  }
  return scored.sort((a, b) => b.ahead - a.ahead).map((s) => s.name);
}

function existsSync(dir: string): boolean {
  try {
    return fs.existsSync(dir);
  } catch {
    return false;
  }
}

/**
 * 静默准备好支线操作所需的一切。
 *
 * 作者可能刚打开一个还没初始化的作品：没有仓库、没有基线、
 * `.novelpad/version` 没被排除、worktree 记录里还有早就删掉的目录。
 * 这些都不该让作者看到错误弹窗——它们全部能自动修好。
 */
async function ensureRepoQuiet(root: string): Promise<void> {
  const avail = await detectGit(nodeExec, root);
  if (!avail.available) return;

  const unborn = await unbornBranch(nodeExec, root);
  if (unborn) {
    const r = await ensureBaseline(nodeExec, root);
    if (r.error) return;
  }
  await excludeLocalIndex(nodeExec, root);
  await pruneWorktrees(nodeExec, root);
}