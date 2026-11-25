/**
 * 章节树：按卷分组，显示状态点与字数
 */
import * as vscode from "vscode";
import type { Chapter } from "@novelpad/core";
import type { ProjectStore } from "../store";

export class ChaptersProvider implements vscode.TreeDataProvider<Node> {
  private readonly _emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this._emitter.event;

  constructor(private readonly store: ProjectStore) {}

  refresh(): void {
    this._emitter.fire(undefined);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  getChildren(node?: Node): Node[] {
    const project = this.store.project;
    if (!project) return [];
    if (!node) {
      // 顶层：按卷分组；无卷章节直接列出
      const groups = new Map<string | undefined, Chapter[]>();
      for (const ch of project.chapters) {
        const v = ch.frontmatter.volume;
        if (!groups.has(v)) groups.set(v, []);
        groups.get(v)!.push(ch);
      }
      const out: Node[] = [];
      for (const [vol, chs] of groups) {
        if (vol === undefined) out.push(...chs.map((c) => this.chapterItem(c)));
        else {
          const total = chs.reduce((s, c) => s + c.wordCount, 0);
          const item = new vscode.TreeItem(vol, vscode.TreeItemCollapsibleState.Expanded) as Node;
          item.id = `vol:${vol}`;
          item.iconPath = new vscode.ThemeIcon("library");
          item.description = `${chs.length} 章 · ${total} 字`;
          item.contextValue = "volume";
          item.children = chs.map((c) => this.chapterItem(c));
          out.push(item);
        }
      }
      return out;
    }
    return node.children ?? [];
  }

  private chapterItem(ch: Chapter): Node {
    const status = ch.frontmatter.status ?? "draft";
    const item = new vscode.TreeItem(ch.frontmatter.title, vscode.TreeItemCollapsibleState.None) as Node;
    item.id = `ch:${ch.relativePath}`;
    item.resourceUri = vscode.Uri.file(ch.path);
    item.command = {
      command: "novelpad.openChapter",
      title: "打开章节",
      arguments: [ch],
    };
    item.tooltip = this.tooltip(ch);
    item.description = `${ch.wordCount} 字`;
    item.iconPath = new vscode.ThemeIcon(
      status === "final" ? "pass-filled" : status === "revision" ? "edit" : "circle-large-outline",
    );
    item.contextValue = "chapter";
    return item;
  }

  private tooltip(ch: Chapter): vscode.MarkdownString {
    const fm = ch.frontmatter;
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${fm.title}**\n\n`);
    md.appendMarkdown(`序号 ${fm.order} · 状态 ${fm.status ?? "draft"} · ${ch.wordCount} 字\n\n`);
    if (fm.pov) md.appendMarkdown(`视角：${fm.pov}\n\n`);
    if (fm.characters?.length) md.appendMarkdown(`出场：${fm.characters.join("、")}\n\n`);
    if (fm.foreshadows?.length) {
      md.appendMarkdown("伏笔：" + fm.foreshadows.map((f) => `\`${f.id}\`${f.due ? `(第 ${f.due} 章前)` : ""}`).join("，") + "\n\n");
    }
    return md;
  }
}

export type Node = vscode.TreeItem & { children?: Node[] };
