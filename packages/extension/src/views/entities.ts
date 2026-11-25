/**
 * 设定树：按类型分组（角色 / 地点 / 势力 / 物品 / 世界观）
 */
import * as vscode from "vscode";
import type { Entity, EntityKind } from "@novelpad/core";
import type { ProjectStore } from "../store";

const GROUPS: { kind: EntityKind; label: string; icon: string }[] = [
  { kind: "character", label: "角色", icon: "organization" },
  { kind: "location", label: "地点", icon: "location" },
  { kind: "faction", label: "势力", icon: "group-by-ref-type" },
  { kind: "item", label: "物品", icon: "symbol-property" },
  { kind: "lore", label: "世界观", icon: "book" },
];

const ROLE_LABEL: Record<string, string> = {
  protagonist: "主角",
  antagonist: "对手",
  supporting: "次要",
  minor: "路人",
};

export class EntitiesProvider implements vscode.TreeDataProvider<Node> {
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
      return GROUPS.filter((g) => project.entities.some((e) => e.kind === g.kind)).map<Node>((g) => {
        const item = new vscode.TreeItem(g.label, vscode.TreeItemCollapsibleState.Expanded) as Node;
        item.id = `kind:${g.kind}`;
        item.iconPath = new vscode.ThemeIcon(g.icon);
        item.contextValue = "kind";
        item.children = project.entities
          .filter((e) => e.kind === g.kind)
          .sort((a, b) => a.name.localeCompare(b.name, "zh"))
          .map((e) => this.entityItem(e));
        return item;
      });
    }
    return node.children ?? [];
  }

  private entityItem(e: Entity): Node {
    const item = new vscode.TreeItem(e.name, vscode.TreeItemCollapsibleState.None) as Node;
    item.id = `ent:${e.relativePath}`;
    item.resourceUri = vscode.Uri.file(e.path);
    item.command = { command: "novelpad.openEntity", title: "打开设定", arguments: [e] };
    const parts: string[] = [];
    if (e.kind === "character" && e.role) parts.push(ROLE_LABEL[e.role] ?? e.role);
    const unconfirmed = e.relations?.filter((r) => r.source === "ai" && !r.confirmed).length ?? 0;
    if (unconfirmed) parts.push(`${unconfirmed} 待确认`);
    item.description = parts.join(" · ");
    item.tooltip = this.tooltip(e);
    item.contextValue = "entity";
    return item;
  }

  private tooltip(e: Entity): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${e.name}**`);
    if (e.aliases?.length) md.appendMarkdown(` · 别称 ${e.aliases.join("、")}`);
    md.appendMarkdown("\n\n");
    if (e.summary) md.appendMarkdown(`${e.summary}\n\n`);
    if (e.tags?.length) md.appendMarkdown(e.tags.map((t) => `\`${t}\``).join(" ") + "\n\n");
    if (e.relations?.length) md.appendMarkdown(`关系 ${e.relations.length} 条\n\n`);
    md.appendMarkdown(`_${e.relativePath}_`);
    return md;
  }
}

export type Node = vscode.TreeItem & { children?: Node[] };
