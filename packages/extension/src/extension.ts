/**
 * NovelPad 扩展入口
 */
import * as vscode from "vscode";
import { execFileSync } from "node:child_process";
import { ProjectStore } from "./store";
import { ChaptersProvider } from "./views/chapters";
import { EntitiesProvider } from "./views/entities";
import { Linter } from "./features/linter";
import { registerLanguageFeatures } from "./features/language";
import { registerCommands } from "./commands";
import { registerFocusMode } from "./features/focus";
import { VersionManager } from "./features/version";
import { ProseDecorator } from "./features/typeset";
import { AnnotationsFeature } from "./features/annotations";
import { registerCopilot } from "./copilot";
import { registerRagAndDecision } from "./decision";
import { openGraph, refreshGraph } from "./views/graph";
import { openTimeline, openTimelineAIOnly, refreshTimeline } from "./views/timeline";
import { closeStudioIfIdle, maybeOpenStudio, openStudio, refreshStudio } from "./views/studio";
import { BranchManager, listMergeableBranches } from "./features/branches";
import { applyShellTheme } from "./features/shell-theme";
import {
  AutoPusher,
  HostStatusBar,
  backup,
  connectInteractive,
  describeStatus,
  restore,
  status as hostStatus,
} from "./features/host";

export function activate(context: vscode.ExtensionContext): void {
  const store = new ProjectStore();
  const chapters = new ChaptersProvider(store);
  const entities = new EntitiesProvider(store);

  // 壳外观：把自带主题设成默认值。
  //
  // 这件事必须在第一屏之前做，否则用户先看到一眼默认深色再「跳」成
  // 宣纸，观感很差。主题写在扩展的 configurationDefaults 里做不到
  // （那会连标准 VS Code 一起改），只能在这里做一次。
  void applyShellTheme(context);
  const linter = new Linter(store);

  context.subscriptions.push(
    store,
    linter,
    vscode.window.createTreeView("novelpad.chapters", { treeDataProvider: chapters }),
    vscode.window.createTreeView("novelpad.entities", { treeDataProvider: entities }),
    ...registerLanguageFeatures(store),
    ...registerCommands(store, linter, chapters, entities),
    ...registerFocusMode(),
  );

  // 版本管理：自动存档 + 时间线。
  // 必须在 Copilot 之前建好——续写/改写要往里塞 AI 来源标记，
  // 否则那些快照在时间线上看起来和作者自己写的一样。
  const version = new VersionManager(store);
  version.start();

  // Novel Copilot
  const copilot = registerCopilot(context, store, version);

  // RAG + 决策模型（注入 Copilot）
  registerRagAndDecision(context, store, copilot.continuation);

  // 图谱
  context.subscriptions.push(
    vscode.commands.registerCommand("novelpad.graph.open", () => openGraph(store, "net")),
    vscode.commands.registerCommand("novelpad.graph.chain", () => openGraph(store, "chain")),
  );
  store.onDidChange(() => refreshGraph());

  // 版本管理：自动存档 + 时间线
  context.subscriptions.push(
    version,
    vscode.commands.registerCommand("novelpad.timeline", () => openTimeline(store)),
    vscode.commands.registerCommand("novelpad.version.milestone", async () => {
      if (!store.root) return void vscode.window.showWarningMessage("请先打开一个作品");
      const label = await vscode.window.showInputBox({
        prompt: "这一版叫什么？（比如「第三章改完雨夜对峙」）",
        placeHolder: "里程碑名称",
        validateInput: (v) => (v.trim() ? undefined : "写个名字，以后好找"),
      });
      if (!label) return;
      const note = await vscode.window.showInputBox({ prompt: "备注（可留空）", placeHolder: "这版改了什么" });
      const rec = await version.milestone(label.trim(), note?.trim() || undefined);
      if (rec) {
        void vscode.window.showInformationMessage(`已存一版：${rec.label}`);
        refreshTimeline();
      }
    }),
    vscode.commands.registerCommand("novelpad.version.saveNow", async () => {
      await version.flush("manual");
      refreshTimeline();
      void vscode.window.showInformationMessage("已存档");
    }),
    // 「只看 AI 改过的地方」：打开时间线并直接切筛选
    vscode.commands.registerCommand("novelpad.version.aiOnly", () => {
      if (!store.root) return void vscode.window.showWarningMessage("请先打开一个作品");
      openTimelineAIOnly(store);
    }),
    // AI 分账（§5.3）：「撤销这次续写」按段落把 AI 写进来的删掉
    vscode.commands.registerCommand("novelpad.version.undoAI", async (id?: string) => {
      if (!store.root) return { ok: false, message: "没有打开作品" };
      const { loadIndex } = await import("@novelpad/core");
      const idx = loadIndex(store.root.fsPath);
      const aiRecords = idx.snapshots.filter((s) => s.origin.kind === "ai");
      type Rec = (typeof aiRecords)[number];

      if (!aiRecords.length) {
        void vscode.window.showInformationMessage("还没有 AI 续写的记录");
        return { ok: false, message: "没有 AI 记录" };
      }

      // 带了 id 就直接撤（时间线点按钮进来）；否则让作者选一条
      const target: Rec | undefined = id
        ? aiRecords.find((s) => s.id === id)
        : aiRecords.length === 1
          ? aiRecords[0]
          : undefined;

      if (!target && !id) {
        const pick = await vscode.window.showQuickPick(
          aiRecords
            .slice()
            .sort((a, b) => (a.time < b.time ? 1 : -1))
            .map((s) => ({
              label: `$(${s.kind === "milestone" ? "flag" : "history"}) ${s.label ?? s.chapter ?? "自动存档"}`,
              description: new Date(s.time).toLocaleString("zh-CN") + (s.words?.delta ? ` · ${s.words.delta > 0 ? "+" : ""}${s.words.delta} 字` : ""),
              rec: s,
            })),
          { placeHolder: "撤销哪一次 AI 续写？" },
        );
        if (!pick) return { ok: false, message: "已取消" };
        return version.undoAI(pick.rec);
      }

      if (!target) return { ok: false, message: "找不到这条 AI 记录" };
      return version.undoAI(target);
    }),
  );
  store.onDidChange(() => refreshTimeline());

  // 支线（共创 B：分工合写）：worktree + 章节级合并
  const branches = new BranchManager(store);
  const branchTree = vscode.window.createTreeView("novelpad.branches", {
    treeDataProvider: branches.provider,
  });
  const branchFromArg = (arg: unknown): string | undefined => {
    // 菜单/树视图传下来的可能是节点本身，也可能是命令参数
    if (typeof arg === "string") return arg;
    if (arg && typeof arg === "object") {
      const n = arg as { branch?: { name?: string }; label?: string };
      if (n.branch?.name) return n.branch.name;
    }
    return undefined;
  };
  context.subscriptions.push(
    branchTree,
    branches,
    vscode.commands.registerCommand("novelpad.branch.new", () => branches.create()),
    vscode.commands.registerCommand("novelpad.branch.refresh", () => branches.provider.refresh()),
    vscode.commands.registerCommand("novelpad.branch.open", async (arg: unknown) => {
      const name = branchFromArg(arg);
      if (!name) {
        // 从命令面板/章节视图进来的：让作者选一条
        const root = store.root?.fsPath;
        if (!root) {
          void vscode.window.showWarningMessage("请先打开一个作品");
          return;
        }
        const all = await listMergeableBranches(root);
        if (!all.length) {
          void vscode.window.showInformationMessage("还没有可以并回来的支线");
          return;
        }
        const picked = await vscode.window.showQuickPick(all, { placeHolder: "把哪条支线并回主稿？" });
        if (picked) await branches.openMerge(picked);
        return;
      }
      await branches.openMerge(name);
    }),
    vscode.commands.registerCommand("novelpad.branch.openWorktree", async (arg: unknown) => {
      const name = branchFromArg(arg);
      if (name) await branches.openWorktree(name);
    }),
    vscode.commands.registerCommand("novelpad.branch.remove", async (arg: unknown) => {
      const name = branchFromArg(arg);
      if (name) await branches.remove(name);
    }),
  );
  store.onDidChange(() => branches.provider.refresh());
  branches.provider.refresh();

  // L4 装饰级排版：只在作品内的 Markdown 生效，纯视觉，不碰正文
  context.subscriptions.push(new ProseDecorator(store));

  // 编辑批注（共创 A）：波浪线 + 悬停线程 + 建议一键接受
  let authorCache: { id: string; name: string } | undefined;
  const output = vscode.window.createOutputChannel("NovelPad");
  const annotations = new AnnotationsFeature(
    store,
    () => {
      // 没账号体系，用 git 配置里的邮箱当身份；拿不到就是 local。
      // 每次调用都起一次 git 子进程，所以缓存在闭包里。
      if (!authorCache) {
        const email = gitEmail();
        authorCache = email ? { id: email, name: email } : { id: "local", name: "我" };
      }
      return authorCache;
    },
    output,
  );
  const annotationTree = vscode.window.createTreeView("novelpad.annotations", {
    treeDataProvider: annotations.treeProvider(),
    showCollapseAll: true,
  });
  annotations.attachBadge(annotationTree);
  context.subscriptions.push(output, annotations, annotationTree);

  // 书房（L5）：替代 Welcome 页。只在没有编辑器时出现。
  // 不给它单独注册「关闭」命令：从命令面板调用时若书房没开，那句
  // closeActiveEditor 会关掉作者正在写的正文。标签页自带关闭按钮。
  context.subscriptions.push(
    vscode.commands.registerCommand("novelpad.studio", () => openStudio(context, store)),
  );
  // 一旦作者打开正文，书房就该让位——它不是挡在稿子前面的一个标签页
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => closeStudioIfIdle()),
  );

  // 托管（V5）：作者全程不输入 git 命令
  const hostBar = new HostStatusBar(store, context.secrets);
  hostBar.start();
  // 存档后自动备份（若作者开了 novelpad.host.autoPush）。
  // 挂在 onDidSnapshot 上而不是定时器上：只有真的存下一版才推，
  // 否则会反复上传同一份内容，流量和「被监视感」都不必要。
  const autoPush = new AutoPusher(store, context.secrets, (state) => {
    if (state === "done" || state === "failed") void hostBar.refresh();
  });
  context.subscriptions.push(autoPush, version.onDidSnapshot(() => void autoPush.afterSave()));
  context.subscriptions.push(
    hostBar,
    vscode.commands.registerCommand("novelpad.host.connect", () => connectInteractive(store, context.secrets)),
    vscode.commands.registerCommand("novelpad.host.push", async () => {
      const r = await backup(store, context.secrets);
      if (r.ok) void vscode.window.showInformationMessage(r.message);
      else void vscode.window.showWarningMessage(r.message);
      await hostBar.refresh();
    }),
    vscode.commands.registerCommand("novelpad.host.pull", async () => {
      const r = await restore(store, context.secrets);
      if (r.ok) void vscode.window.showInformationMessage(r.message);
      else void vscode.window.showErrorMessage(r.message);
      await hostBar.refresh();
    }),
    vscode.commands.registerCommand("novelpad.host.status", async () => {
      const s = await hostStatus(store, context.secrets);
      if (!s.connected) {
        const act = await vscode.window.showInformationMessage(
          "这部作品还没做云端备份。连接之后，换电脑也能接着写。",
          "连接到 GitHub",
          "稍后",
        );
        if (act === "连接到 GitHub") await connectInteractive(store, context.secrets);
        await hostBar.refresh();
        return;
      }
      const p = s.preview;
      const lines = [
        `地址：${s.remote?.displayUrl ?? ""}`,
        `状态：${describeStatus(s)}`,
      ];
      if (p?.dirty) lines.push("有未提交的改动（点「备份到云端」会先自动存一版）");
      const act = await vscode.window.showInformationMessage(lines.join("\n"), { modal: true }, "备份到云端", "从云端取回");
      if (act === "备份到云端") await vscode.commands.executeCommand("novelpad.host.push");
      if (act === "从云端取回") await vscode.commands.executeCommand("novelpad.host.pull");
    }),
  );

  // 状态栏：当前章节字数 / 全书字数
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "novelpad.stats";
  context.subscriptions.push(status);

  const updateStatus = () => {
    const cfg = vscode.workspace.getConfiguration("novelpad");
    if (!cfg.get<boolean>("showWordCount", true) || !store.project) {
      status.hide();
      return;
    }
    const total = store.project.chapters.reduce((s, c) => s + c.wordCount, 0);
    const doc = vscode.window.activeTextEditor?.document;
    const ch = doc ? store.project.chapters.find((c) => c.path === doc.uri.fsPath) : undefined;
    status.text = ch ? `$(book) ${ch.wordCount.toLocaleString()} / ${total.toLocaleString()} 字` : `$(book) ${total.toLocaleString()} 字`;
    status.show();
  };

  store.onDidChange(() => {
    chapters.refresh();
    entities.refresh();
    updateStatus();
    refreshStudio();
    if (store.project) void linter.run();
  });

  // 编辑器切换 / 保存
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("novelpad")) updateStatus();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/\.(md|yaml|yml)$/i.test(doc.uri.fsPath)) {
        store.scheduleRefresh();
        linter.runOnSave();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void store.refresh();
    }),
  );

  void store.refresh().then(() => {
    store.startWatching();
    // 刷新完成后再判断：作品名与字数要能立刻显示在书房首页上
    maybeOpenStudio(context, store);
  });
}

export function deactivate(): void {
  /* subscriptions 自动 dispose */
}

/**
 * 从 git 配置里取作者邮箱，用作批注身份。
 *
 * 没有账号体系是有意的：计划里明确「编辑只需 clone 仓库、用 NovelPad 打开，
 * 不需要账号、不需要服务器」。邮箱只用来在多人批注里区分是谁写的。
 */
function gitEmail(): string | undefined {
  try {
    const out = execFileSync("git", ["config", "user.email"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
