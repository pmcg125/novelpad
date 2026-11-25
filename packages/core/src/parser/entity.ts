/**
 * 设定实体解析：characters 目录下的 YAML、world 目录下的 Markdown
 */
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import matter from "gray-matter";
import {
  ENTITY_DIR,
  type Character,
  type Entity,
  type EntityBase,
  type EntityKind,
  type Faction,
  type Item,
  type Location,
  type Lore,
  type Relation,
} from "../types.js";

/** 从文件名生成 ID：去扩展名 */
export function idFromFilename(fileName: string): string {
  return path.basename(fileName, path.extname(fileName));
}

/** 实体文件路径 → 实体类型 */
export function kindFromPath(relativePath: string): EntityKind | undefined {
  const dir = path.posix.dirname(relativePath);
  if (dir === ENTITY_DIR.character) return "character";
  if (dir === ENTITY_DIR.location) return "location";
  if (dir === ENTITY_DIR.faction) return "faction";
  if (dir === ENTITY_DIR.item) return "item";
  // world/*.md 顶层 → 世界观条目
  if (dir === "world") return "lore";
  return undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string");
  return arr.length ? arr : undefined;
}

function asAttrs(v: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      out[k] = val;
    } else if (val !== null && val !== undefined) {
      out[k] = String(val);
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function asRelations(v: unknown): Relation[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Relation[] = [];
  for (const r of v) {
    if (typeof r === "string") {
      out.push({ target: r, type: "关联", source: "card" });
      continue;
    }
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    const target = typeof o.target === "string" ? o.target : typeof o.with === "string" ? o.with : undefined;
    if (!target) continue;
    out.push({
      target,
      type: typeof o.type === "string" ? o.type : "关联",
      category: typeof o.category === "string" ? (o.category as Relation["category"]) : undefined,
      note: typeof o.note === "string" ? o.note : undefined,
      source: o.source === "ai" ? "ai" : "card",
      evidenceChapter: typeof o.evidenceChapter === "number" ? o.evidenceChapter : undefined,
      confirmed: typeof o.confirmed === "boolean" ? o.confirmed : undefined,
    });
  }
  return out.length ? out : undefined;
}

function base(
  kind: EntityKind,
  id: string,
  o: Record<string, unknown>,
  filePath: string,
  relativePath: string,
): EntityBase {
  return {
    kind,
    id,
    name: typeof o.name === "string" && o.name ? o.name : id,
    aliases: asStringArray(o.aliases ?? o.alias),
    tags: asStringArray(o.tags),
    summary: typeof o.summary === "string" ? o.summary : undefined,
    description: typeof o.description === "string" ? o.description : undefined,
    attrs: asAttrs(o.attrs ?? o.attributes),
    relations: asRelations(o.relations),
    path: filePath,
    relativePath,
  };
}

/** 解析角色卡 YAML */
export function parseCharacterYaml(text: string, filePath: string, relativePath: string): Character {
  const o = (parseYaml(text) ?? {}) as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : idFromFilename(filePath);
  const role = ["protagonist", "antagonist", "supporting", "minor"].includes(o.role as string)
    ? (o.role as Character["role"])
    : undefined;
  const state =
    typeof o.state === "object" && o.state !== null
      ? {
          emotion: typeof (o.state as Record<string, unknown>).emotion === "string" ? (o.state as Record<string, unknown>).emotion as string : undefined,
          location: typeof (o.state as Record<string, unknown>).location === "string" ? (o.state as Record<string, unknown>).location as string : undefined,
          knows: asStringArray((o.state as Record<string, unknown>).knows),
          since: typeof (o.state as Record<string, unknown>).since === "number" ? (o.state as Record<string, unknown>).since as number : undefined,
        }
      : undefined;
  return {
    ...base("character", id, o, filePath, relativePath),
    kind: "character",
    role,
    state,
  };
}

/** 解析地点 / 势力 / 物品的 Markdown（frontmatter 即结构化数据，正文为描述） */
export function parseEntityMarkdown(
  kind: "location" | "faction" | "item",
  text: string,
  filePath: string,
  relativePath: string,
): Location | Faction | Item {
  const { data, content } = matter(text);
  const o = data as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : idFromFilename(filePath);
  const b = base(kind, id, o, filePath, relativePath);
  if (!b.description && content.trim()) b.description = content.trim();
  if (kind === "item") {
    const holder = typeof o.holder === "string" ? o.holder : undefined;
    return { ...b, kind: "item", holder };
  }
  return { ...b, kind } as Location | Faction;
}

/** 解析世界观条目 Markdown */
export function parseLoreMarkdown(text: string, filePath: string, relativePath: string): Lore {
  const { data, content } = matter(text);
  const o = data as Record<string, unknown>;
  const id = typeof o.id === "string" ? o.id : idFromFilename(filePath);
  return {
    ...base("lore", id, o, filePath, relativePath),
    kind: "lore",
    content,
  };
}

/** 根据相对路径自动分派解析器 */
export function parseEntityFile(filePath: string, projectRoot: string): Entity | undefined {
  const relativePath = path.relative(projectRoot, filePath).split(path.sep).join("/");
  const kind = kindFromPath(relativePath);
  if (!kind) return undefined;
  const text = fs.readFileSync(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();
  switch (kind) {
    case "character":
      if (ext !== ".yaml" && ext !== ".yml") return undefined;
      return parseCharacterYaml(text, filePath, relativePath);
    case "lore":
      if (ext !== ".md") return undefined;
      return parseLoreMarkdown(text, filePath, relativePath);
    default:
      if (ext !== ".md" && ext !== ".yaml" && ext !== ".yml") return undefined;
      return parseEntityMarkdown(kind, text, filePath, relativePath);
  }
}
