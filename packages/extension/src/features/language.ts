/**
 * 语言特性：补全（[[ 触发）、悬浮（实体名 → 角色卡摘要）、定义跳转（双链 → 设定文件）
 */
import * as vscode from "vscode";
import type { Entity } from "@novelpad/core";
import type { ProjectStore } from "../store";

const MD = { language: "markdown", scheme: "file" } as const;

export function registerLanguageFeatures(store: ProjectStore): vscode.Disposable[] {
  const disposables: vscode.Disposable[] = [];

  /* ---------- 补全 ---------- */
  disposables.push(
    vscode.languages.registerCompletionItemProvider(
      MD,
      {
        provideCompletionItems(document, position) {
          const linePrefix = document.lineAt(position).text.slice(0, position.character);
          // 只在 [[ 之后触发
          if (!/\[\[[^\]]*$/.test(linePrefix)) return undefined;
          const items: vscode.CompletionItem[] = [];
          for (const [name, e] of store.entityIndex) {
            const base = store.entityIndex.get(name);
            if (!base) continue;
            const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Reference);
            item.detail = kindLabel(e);
            item.documentation = new vscode.MarkdownString(`${e.summary ?? ""}\n\n_${e.relativePath}_`);
            // 输入 [[ 后补全名字 + ]]，替换已输入的部分
            const typed = linePrefix.match(/\[\[([^\]|]*)$/)?.[1] ?? "";
            item.range = new vscode.Range(position.translate(0, -typed.length), position);
            items.push(item);
          }
          return new vscode.CompletionList(items, false);
        },
      },
      "[",
    ),
  );

  /* ---------- 悬浮 ---------- */
  disposables.push(
    vscode.languages.registerHoverProvider(MD, {
      provideHover(document, position) {
        const line = document.lineAt(position).text;
        const range = entityRangeAt(line, position, store);
        if (!range) return undefined;
        const e = range.entity;
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${e.name}**`);
        if (e.aliases?.length) md.appendMarkdown(` · ${e.aliases.join("、")}`);
        md.appendMarkdown(`  \n_${kindLabel(e)}_`);
        md.appendMarkdown("\n\n");
        if (e.summary) md.appendMarkdown(`${e.summary}\n\n`);
        if (e.attrs) {
          const entries = Object.entries(e.attrs).slice(0, 4);
          md.appendMarkdown(entries.map(([k, v]) => `\`${k}\` ${v}`).join("　") + "\n\n");
        }
        if (e.relations?.length) {
          md.appendMarkdown("关系：" + e.relations.slice(0, 4).map((r) => `${r.target}（${r.type}）`).join("，") + "\n\n");
        }
        md.appendMarkdown(`[打开设定](command:novelpad.openEntity?${encodeURIComponent(JSON.stringify(e))})`);
        md.isTrusted = true;
        return new vscode.Hover(md, range.range);
      },
    }),
  );

  /* ---------- 定义跳转 ---------- */
  disposables.push(
    vscode.languages.registerDefinitionProvider(MD, {
      provideDefinition(document, position) {
        const line = document.lineAt(position).text;
        const hit = entityRangeAt(line, position, store);
        if (!hit) return undefined;
        return new vscode.Location(vscode.Uri.file(hit.entity.path), new vscode.Range(0, 0, 0, 0));
      },
    }),
  );

  /* ---------- 文档链接：[[名]] 可点击 ---------- */
  disposables.push(
    vscode.languages.registerDocumentLinkProvider(MD, {
      provideDocumentLinks(document) {
        const links: vscode.DocumentLink[] = [];
        const text = document.getText();
        for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
          const name = m[1];
          const e = store.entityIndex.get(name);
          if (!e) continue;
          const start = document.positionAt(m.index ?? 0);
          const end = document.positionAt((m.index ?? 0) + m[0].length);
          const link = new vscode.DocumentLink(new vscode.Range(start, end));
          link.target = vscode.Uri.file(e.path);
          links.push(link);
        }
        return links;
      },
    }),
  );

  return disposables;
}

function kindLabel(e: Entity): string {
  return { character: "角色", location: "地点", faction: "势力", item: "物品", lore: "世界观" }[e.kind];
}

/** 找出光标所在的实体名（名称或别称） */
function entityRangeAt(line: string, position: vscode.Position, store: ProjectStore): { entity: Entity; range: vscode.Range } | undefined {
  const col = position.character;
  // 长名优先，避免「林」匹配到「林晚」的前缀
  const names = [...store.entityIndex.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    let idx = line.indexOf(name);
    while (idx !== -1) {
      if (col >= idx && col < idx + name.length) {
        const e = store.entityIndex.get(name)!;
        return { entity: e, range: new vscode.Range(position.line, idx, position.line, idx + name.length) };
      }
      idx = line.indexOf(name, idx + 1);
    }
  }
  return undefined;
}
