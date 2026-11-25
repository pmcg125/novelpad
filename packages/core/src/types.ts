/**
 * NovelPad 核心类型定义
 * 对应 docs/PLAN.md 第 5 节「数据模型：文件即数据」
 */

/* ============================================================
 * 章节
 * ============================================================ */

/** 稿件状态 */
export type ChapterStatus = "draft" | "revision" | "final";

/** 伏笔声明 */
export interface Foreshadow {
  /** 伏笔 ID，如 fs-umbrella */
  id: string;
  /** 应在第几章之前回收 */
  due?: number;
  /** 已回收的章节（order） */
  resolvedAt?: number;
  /** 备注 */
  note?: string;
}

/** 章节 frontmatter（chapters/NNN.md 的 YAML 头） */
export interface ChapterFrontmatter {
  title: string;
  /** 章节序号，决定合并顺序 */
  order: number;
  /** 所属卷 */
  volume?: string;
  /** 视角人物 */
  pov?: string;
  status?: ChapterStatus;
  /** 出场角色 */
  characters?: string[];
  /** 出现场景地点 */
  locations?: string[];
  /** 本章埋下的伏笔 */
  foreshadows?: Foreshadow[];
  /** 本章回收的伏笔 ID */
  resolves?: string[];
  /** 本章目标字数 */
  targetWords?: number;
  /** 自由扩展字段 */
  [key: string]: unknown;
}

/** 解析后的章节 */
export interface Chapter {
  /** 文件绝对路径 */
  path: string;
  /** 相对作品根目录的路径，如 chapters/001.md */
  relativePath: string;
  frontmatter: ChapterFrontmatter;
  /** 正文（去掉 frontmatter 后的 Markdown） */
  content: string;
  /** 正文汉字/字符计数（不含空白） */
  wordCount: number;
}

/* ============================================================
 * 设定：角色 / 地点 / 势力 / 物品 / 世界观
 * ============================================================ */

export type EntityKind = "character" | "location" | "faction" | "item" | "lore";

/** 实体类型 → 文件目录名 */
export const ENTITY_DIR: Record<EntityKind, string> = {
  character: "characters",
  location: "world/locations",
  faction: "world/factions",
  item: "world/items",
  lore: "world",
};

/** 关系类型分类（用于图谱着色） */
export type RelationCategory = "ally" | "enemy" | "family" | "neutral" | "causal";

/** 角色定位 */
export type CharacterRole = "protagonist" | "antagonist" | "supporting" | "minor";

/** 关系声明 */
export interface Relation {
  /** 对方实体 ID（通常为文件名去扩展名） */
  target: string;
  /** 关系描述，如「敌对 · 对峙」 */
  type: string;
  /** 用于图谱着色的分类 */
  category?: RelationCategory;
  /** 备注 */
  note?: string;
  /** 来源：设定卡显式声明 / AI 抽取 */
  source: "card" | "ai";
  /** AI 抽取时的证据章节 */
  evidenceChapter?: number;
  /** AI 抽取是否已人工确认 */
  confirmed?: boolean;
}

/** 随章节变化的状态 */
export interface EntityState {
  /** 情绪 */
  emotion?: string;
  /** 位置 */
  location?: string;
  /** 该状态下知晓的信息 */
  knows?: string[];
  /** 状态生效章节 */
  since?: number;
}

/** 设定实体通用字段 */
export interface EntityBase {
  kind: EntityKind;
  /** ID = 文件名去扩展名，如 lin-wan */
  id: string;
  /** 显示名 */
  name: string;
  aliases?: string[];
  tags?: string[];
  summary?: string;
  description?: string;
  /** 自定义属性，可被 lint 规则引用 */
  attrs?: Record<string, string | number | boolean>;
  /** 关系 */
  relations?: Relation[];
  /** 来源文件 */
  path: string;
  relativePath: string;
}

export interface Character extends EntityBase {
  kind: "character";
  role?: CharacterRole;
  state?: EntityState;
}

export interface Location extends EntityBase {
  kind: "location";
}

export interface Faction extends EntityBase {
  kind: "faction";
}

export interface Item extends EntityBase {
  kind: "item";
  /** 持有者 */
  holder?: string;
}

/** 世界观条目（纯 Markdown，frontmatter 只有元数据） */
export interface Lore extends EntityBase {
  kind: "lore";
  /** Markdown 正文 */
  content: string;
}

export type Entity = Character | Location | Faction | Item | Lore;

/* ============================================================
 * 作品
 * ============================================================ */

/** 作品根配置（.novelpad/config.json） */
export interface ProjectConfig {
  /** 作品名 */
  title: string;
  /** 作者 */
  author?: string;
  /** 默认导出 profile */
  exportProfile?: string;
  /** 正文目录，默认 chapters */
  chaptersDir?: string;
  /** 大纲目录，默认 outline */
  outlineDir?: string;
  /** 自定义 lint 规则开关 */
  rules?: Record<string, boolean | "error" | "warning" | "info">;
}

/** 扫描后的完整作品 */
export interface Project {
  /** 作品根目录绝对路径 */
  root: string;
  config: ProjectConfig;
  /** 按 order 升序 */
  chapters: Chapter[];
  entities: Entity[];
}

/* ============================================================
 * 诊断（lint 输出，映射到 VS Code Diagnostic）
 * ============================================================ */

export type DiagnosticSeverity = "error" | "warning" | "info";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** 规则 ID，如 novelpad/foreshadow-overdue */
  rule: string;
  message: string;
  /** 相对作品根的文件路径 */
  file: string;
  /** 1-based 行号 */
  line: number;
  /** 1-based 列号 */
  column?: number;
  /** 相关实体 / 伏笔 ID，便于跳转 */
  relatedId?: string;
}
