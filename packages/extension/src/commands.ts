/**
 * 命令：新建章节 / 角色、导出、统计、检查
 */
import * as vscode from "vscode";
import { exportDocx, exportTxt, resolveProfile } from "@novelpad/core";
import type { ProjectStore } from "./store";
import type { Linter } from "./features/linter";
import type { ChaptersProvider } from "./views/chapters";
import type { EntitiesProvider } from "./views/entities";
import { chapterTemplate, characterTemplate, toId } from "./templates";

export function registerCommands(
  store: ProjectStore,
  linter: Linter,
  chapters: ChaptersProvider,
  entities: EntitiesProvider,
): vscode.Disposable[] {
  const d: vscode.Disposable[] = [];
  const cmd = (id: string, fn: (...a: any[]) => unknown) => d.push(vscode.commands.registerCommand(id, fn));

  cmd("novelpad.initProject", async () => {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, openLabel: "选择作品文件夹" });
    if (!picked?.[0]) return;
    const root = picked[0];
    for (const dir of [".novelpad", "chapters", "outline", "characters", "world/locations", "world/factions", "world/items"]) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ...dir.split("/")));
    }
    const title = await vscode.window.showInputBox({ prompt: "作品名", value: "未命名作品" });
    if (!title) return;
    const cfg = vscode.Uri.joinPath(root, ".novelpad", "config.json");
    try {
      await vscode.workspace.fs.stat(cfg);
    } catch {
      await vscode.workspace.fs.writeFile(cfg, Buffer.from(JSON.stringify({ title, chaptersDir: "chapters", outlineDir: "outline", exportProfile: "default" }, null, 2) + "\n"));
    }
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, ".novelpad", ".gitignore"), Buffer.from("index/\ncache/\n"));
    await store.refresh();
    chapters.refresh();
    entities.refresh();
    void vscode.window.showInformationMessage(`NovelPad：已创建《${title}》`);
  });

  cmd("novelpad.newChapter", async () => {
    const root = store.root;
    if (!root) return void vscode.window.showWarningMessage("请先打开一个作品（含 .novelpad 的文件夹）");
    const project = store.project;
    const next = (project?.chapters.length ?? 0) + 1;
    const maxOrder = project?.chapters.length ? Math.max(...project.chapters.map((c) => c.frontmatter.order)) : 0;
    const order = Math.max(next, maxOrder + 1);
    const title = await vscode.window.showInputBox({ prompt: "章节标题", value: `第${order}章`, validateInput: (v) => (v.trim() ? undefined : "标题不能为空") });
    if (!title) return;
    const lastVolume = project?.chapters.find((c) => c.frontmatter.order === maxOrder)?.frontmatter.volume;
    const volume = await vscode.window.showInputBox({ prompt: "所属卷（可留空）", value: lastVolume ?? "" });
    const fileName = `${String(order).padStart(3, "0")}.md`;
    const content = chapterTemplate({ order, title, volume: volume || undefined });
    const uri = vscode.Uri.joinPath(root, project?.config.chaptersDir ?? "chapters", fileName);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    const doc = await vscode.window.showTextDocument(uri);
    const pos = new vscode.Position(doc.document.lineCount, 0);
    doc.selection = new vscode.Selection(pos, pos);
  });

  cmd("novelpad.newCharacter", async () => {
    const root = store.root;
    if (!root) return void vscode.window.showWarningMessage("请先打开一个作品");
    const name = await vscode.window.showInputBox({ prompt: "角色名", validateInput: (v) => (v.trim() ? undefined : "不能为空") });
    if (!name) return;
    const id = await vscode.window.showInputBox({ prompt: "文件名（ID）", value: toId(name) });
    if (!id) return;
    const role = await vscode.window.showQuickPick(["protagonist", "antagonist", "supporting", "minor"], { placeHolder: "定位" });
    const yaml = characterTemplate({ name, role });
    const uri = vscode.Uri.joinPath(root, "characters", `${id}.yaml`);
    try {
      await vscode.workspace.fs.stat(uri);
      return void vscode.window.showWarningMessage(`已存在 ${id}.yaml`);
    } catch {
      /* 不存在才创建 */
    }
    await vscode.workspace.fs.writeFile(uri, Buffer.from(yaml, "utf8"));
    await vscode.window.showTextDocument(uri);
  });

  cmd("novelpad.openChapter", async (ch?: { path: string }) => {
    if (!ch) return;
    await vscode.window.showTextDocument(vscode.Uri.file(ch.path), { preview: false });
  });

  cmd("novelpad.openEntity", async (e?: { path: string }) => {
    if (!e) return;
    await vscode.window.showTextDocument(vscode.Uri.file(e.path), { preview: false });
  });

  cmd("novelpad.exportTxt", () => exportWith("txt"));
  cmd("novelpad.exportDocx", () => exportWith("docx"));

  async function exportWith(format: "txt" | "docx"): Promise<void> {
    const project = store.project;
    if (!project) return void vscode.window.showWarningMessage("请先打开一个作品");
    const profileName = project.config.exportProfile ?? vscode.workspace.getConfiguration("novelpad").get<string>("exportProfile", "default");
    const profile = resolveProfile(profileName ?? "default");
    const safe = project.config.title.replace(/[\\/:*?"<>|]/g, "_");
    const ext = format === "txt" ? "txt" : "docx";
    const defaultUri = vscode.Uri.joinPath(vscode.Uri.file(project.root), "dist", `${safe}.${ext}`);
    const picked = await vscode.window.showSaveDialog({
      defaultUri,
      filters: format === "txt" ? { "文本": ["txt"] } : { "Word": ["docx"] },
      saveLabel: `导出 ${format.toUpperCase()}`,
    });
    if (!picked) return;
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(picked, ".."));
    if (format === "txt") {
      await vscode.workspace.fs.writeFile(picked, Buffer.from("\uFEFF" + exportTxt(project, profile), "utf8"));
    } else {
      const buf = await exportDocx(project, profile);
      await vscode.workspace.fs.writeFile(picked, buf);
    }
    const action = await vscode.window.showInformationMessage(`已导出 ${picked.fsPath}`, "打开文件", "打开所在文件夹");
    if (action === "打开文件") void vscode.env.openExternal(picked);
    if (action === "打开所在文件夹") void vscode.commands.executeCommand("revealFileInOS", picked);
  }

  cmd("novelpad.check", async () => {
    const diags = await linter.run();
    const errors = diags.filter((x) => x.severity === "error").length;
    const warns = diags.filter((x) => x.severity === "warning").length;
    if (!diags.length) void vscode.window.showInformationMessage("NovelPad：全部检查通过 ✓");
    else void vscode.window.showInformationMessage(`NovelPad：${diags.length} 个问题（${errors} 错误，${warns} 警告）`, "查看问题").then((r) => {
      if (r) void vscode.commands.executeCommand("workbench.actions.view.problems");
    });
  });

  cmd("novelpad.stats", async () => {
    const project = store.project;
    if (!project) return void vscode.window.showWarningMessage("请先打开一个作品");
    const total = project.chapters.reduce((s, c) => s + c.wordCount, 0);
    const byStatus = new Map<string, number>();
    for (const c of project.chapters) {
      const s = c.frontmatter.status ?? "draft";
      byStatus.set(s, (byStatus.get(s) ?? 0) + c.wordCount);
    }
    const lines = [
      `# 《${project.config.title}》`,
      "",
      `章节 ${project.chapters.length} · 总字数 **${total.toLocaleString()}**`,
      "",
      "| 章节 | 字数 | 状态 |",
      "|---|---:|---|",
      ...project.chapters.map((c) => `| ${c.frontmatter.title} | ${c.wordCount.toLocaleString()} | ${c.frontmatter.status ?? "draft"} |`),
      "",
      [...byStatus.entries()].map(([k, v]) => `- ${k}：${v.toLocaleString()} 字`).join("\n"),
    ];
    const panel = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    panel.text = `$(book) ${total.toLocaleString()} 字`;
    panel.tooltip = "NovelPad 总字数";
    panel.show();
    d.push(panel);
    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: lines.join("\n") });
    await vscode.window.showTextDocument(doc, { preview: true });
  });

  cmd("novelpad.refresh", async () => {
    await store.refresh();
  });

  return d;
}
