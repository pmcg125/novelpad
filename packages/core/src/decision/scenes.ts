/**
 * 决策场景：把 decision-model 用在小说创作的具体判断上。
 *
 * 原则：决策模型只做「判断」，不做「生成」。它输出概率，我们据此分级 / 路由 / 注入约束。
 */
import type { Chapter, Entity } from "../types.js";
import type { Decider, DecisionResult, Questions, ScoreAnswer, ChoiceAnswer, NoulAnswer } from "./provider.js";
import { q } from "./provider.js";

/* ============================================================
 * 1. 正文审查：一次请求对一段正文做多项判断
 * ============================================================ */

export interface ReviewTarget {
  /** 被审查的正文段落 */
  text: string;
  /** 本章出场角色（名称 + 角色卡摘要 + 状态） */
  characters: { name: string; summary?: string; attrs?: Record<string, unknown>; state?: { emotion?: string; location?: string; knows?: string[] } }[];
  /** 视角人物 */
  pov?: string;
  /** 相关世界观条目摘要 */
  lore?: string[];
}

export interface ReviewVerdict {
  /** 是否与角色设定一致（P(yes)） */
  inCharacter: NoulAnswer;
  /** 是否写入了视角人物不可能知道的信息（P(yes) = 有问题） */
  povViolation: NoulAnswer;
  /** 是否与已知设定矛盾（P(yes) = 有问题） */
  loreConflict: NoulAnswer;
  /** AI 腔程度 0~3 */
  aiStyle: ScoreAnswer;
  /** 紧张程度 0~3 */
  tension: ScoreAnswer;
  /** 文本主导情绪 */
  mood: ChoiceAnswer;
  /** 原始结果 */
  raw: DecisionResult;
}

export const AI_STYLE_LEVELS = ["完全像人写的", "有一两处略显套路", "明显套路化", "非常 AI"];
export const TENSION_LEVELS = ["日常平静", "隐约不安", "明显戒备", "一触即发"];
export const MOOD_OPTIONS = {
  suspense: "悬疑、悬念",
  grief: "悲伤、失落",
  warmth: "温暖、亲密",
  anger: "愤怒、冲突",
  fear: "恐惧、压迫",
  calm: "平静、日常",
  hope: "希望、释然",
  other: "其他",
};

export async function reviewText(decider: Decider, target: ReviewTarget): Promise<ReviewVerdict> {
  const state = {
    视角人物: target.pov ?? "未指定",
    出场人物设定: target.characters.map((c) => ({
      姓名: c.name,
      简介: c.summary,
      属性: c.attrs,
      当前状态: c.state,
    })),
    世界观: target.lore ?? [],
    待审查正文: target.text,
  };
  const questions = {
    inCharacter: q.noul("正文里每个人物的言行是否符合上面给出的人物设定（没有 OOC）？", { true: "全部符合设定", false: "有人物言行明显不符合设定" }),
    povViolation: q.noul(`正文是否写入了视角人物「${target.pov ?? "视角人物"}」不可能知道的信息（如他人内心、未在场事件）？`, { true: "存在视角越界", false: "视角一致" }),
    loreConflict: q.noul("正文是否与上面给出的世界观 / 设定矛盾？", { true: "存在矛盾", false: "没有矛盾" }),
    aiStyle: q.score(AI_STYLE_LEVELS, "这段文字的「AI 腔」程度（堆砌形容词、套路化感悟、书面腔对话）"),
    tension: q.score(TENSION_LEVELS, "这段文字的紧张程度"),
    mood: q.choice(MOOD_OPTIONS, "这段文字的主导情绪"),
  };
  const raw = await decider.decide({ state, questions });
  return {
    inCharacter: raw.answers.inCharacter as NoulAnswer,
    povViolation: raw.answers.povViolation as NoulAnswer,
    loreConflict: raw.answers.loreConflict as NoulAnswer,
    aiStyle: raw.answers.aiStyle as ScoreAnswer,
    tension: raw.answers.tension as ScoreAnswer,
    mood: raw.answers.mood as ChoiceAnswer,
    raw,
  };
}

/** 把审查结果转成可读的诊断（severity 由概率决定） */
export function reviewToDiagnostics(v: ReviewVerdict): { severity: "error" | "warning" | "info"; rule: string; message: string; confidence: number }[] {
  const out: { severity: "error" | "warning" | "info"; rule: string; message: string; confidence: number }[] = [];
  const p = (x: NoulAnswer) => x.noul;

  if (p(v.povViolation) > 0.7) out.push({ severity: p(v.povViolation) > 0.9 ? "error" : "warning", rule: "novelpad/decision-pov", message: `疑似视角越界（P=${p(v.povViolation).toFixed(2)}）：写入了视角人物不可能知道的信息`, confidence: p(v.povViolation) });
  if (p(v.loreConflict) > 0.7) out.push({ severity: p(v.loreConflict) > 0.9 ? "error" : "warning", rule: "novelpad/decision-lore", message: `疑似与设定矛盾（P=${p(v.loreConflict).toFixed(2)}）`, confidence: p(v.loreConflict) });
  if (p(v.inCharacter) < 0.5) out.push({ severity: p(v.inCharacter) < 0.3 ? "error" : "warning", rule: "novelpad/decision-ooc", message: `疑似人物 OOC（符合度 P=${p(v.inCharacter).toFixed(2)}）`, confidence: 1 - p(v.inCharacter) });
  if (v.aiStyle.score >= 2) out.push({ severity: "info", rule: "novelpad/decision-ai-style", message: `AI 腔程度 ${v.aiStyle.score.toFixed(2)}/3（${AI_STYLE_LEVELS[Math.round(v.aiStyle.score)]}）`, confidence: v.aiStyle.confidence });
  return out;
}

/* ============================================================
 * 2. 续写前判断：决定生成模型该遵守什么
 * ============================================================ */

export interface PreContinuationFacts {
  chapter: Chapter;
  characters: Entity[];
  /** 光标前最近正文 */
  recentText: string;
}

export interface PreContinuationVerdict {
  /** 每个在场人物此刻的情绪（choice） */
  emotions: Record<string, ChoiceAnswer>;
  /** 场景地点是否与角色卡状态一致（P(yes) = 一致） */
  locationConsistent: NoulAnswer;
  /** 当前节奏：应加速 / 保持 / 放慢 */
  pacing: ChoiceAnswer;
  /** 是否适合在此处回收一个伏笔 */
  shouldResolveForeshadow: NoulAnswer;
  raw: DecisionResult;
}

export const EMOTION_OPTIONS = {
  calm: "平静",
  tense: "紧张、戒备",
  angry: "愤怒",
  sad: "悲伤、失落",
  warm: "温暖、亲近",
  afraid: "恐惧",
  confused: "困惑、犹豫",
  other: "其他",
};
export const PACING_OPTIONS = {
  speed_up: "加速，推进情节",
  keep: "保持当前节奏",
  slow_down: "放慢，加细节 / 对话",
  scene_break: "切换场景",
};

/** 续写前一次请求，得出应注入生成模型的约束 */
export async function preContinuation(decider: Decider, facts: PreContinuationFacts): Promise<{ verdict: PreContinuationVerdict; constraints: string[] }> {
  const chars = facts.characters.filter((e) => e.kind === "character");
  const questions: Questions = {
    locationConsistent: q.noul("正文里的场景地点是否与人物「当前状态」里记录的位置一致？", { true: "一致或已交代移动", false: "不一致且未交代" }),
    shouldResolveForeshadow: q.noul("在这个位置回收一个伏笔是否自然（不生硬）？", { true: "适合", false: "不适合" }),
    pacing: q.choice(PACING_OPTIONS, "从叙事节奏看，接下来应该"),
    ...Object.fromEntries(chars.slice(0, 8).map((c) => [`emotion:${c.name}`, q.choice(EMOTION_OPTIONS, `${c.name} 此刻的情绪`)])),
  };
  const state = {
    章节: facts.chapter.frontmatter.title,
    视角: facts.chapter.frontmatter.pov,
    场景地点: facts.chapter.frontmatter.locations,
    人物设定: chars.map((c) => ({ 姓名: c.name, 简介: c.summary, 状态: c.kind === "character" ? c.state : undefined, 关系: c.relations?.map((r) => `${r.target}（${r.type}）`) })),
    正文到此为止: facts.recentText,
  };
  const raw = await decider.decide({ state, questions });
  const emotions: Record<string, ChoiceAnswer> = {};
  const constraints: string[] = [];
  for (const c of chars.slice(0, 8)) {
    const a = raw.answers[`emotion:${c.name}`] as ChoiceAnswer | undefined;
    if (a) emotions[c.name] = a;
  }
  for (const [name, a] of Object.entries(emotions)) {
    if (a.choice !== "other" && a.choice !== "calm" && a.confidence > 0.6) constraints.push(`${name}此刻情绪应为「${EMOTION_OPTIONS[a.choice as keyof typeof EMOTION_OPTIONS]}」，言行要带出这个情绪`);
  }
  const lc = raw.answers.locationConsistent as NoulAnswer;
  if (lc.noul < 0.5) constraints.push("人物位置与设定不一致，续写中要交代人物如何到达当前位置");
  if ((raw.answers.pacing as ChoiceAnswer).choice === "scene_break") constraints.push("节奏上适合切换场景（可用 *** 分隔）");
  else if ((raw.answers.pacing as ChoiceAnswer).choice === "slow_down") constraints.push("放慢节奏，多用动作、感官细节和对话");
  else if ((raw.answers.pacing as ChoiceAnswer).choice === "speed_up") constraints.push("加快节奏，推进情节，减少环境描写");
  return {
    verdict: {
      emotions,
      locationConsistent: lc,
      pacing: raw.answers.pacing as ChoiceAnswer,
      shouldResolveForeshadow: raw.answers.shouldResolveForeshadow as NoulAnswer,
      raw,
    },
    constraints,
  };
}

/* ============================================================
 * 3. 冲突裁决：同一属性多版本 → 判定采用哪个 / 是否需人工
 * ============================================================ */

export interface AttributeConflict {
  entity: string;
  attr: string;
  versions: { value: string; source: string; note?: string; rank?: "user" | "assistant" | "unknown"; when?: string }[];
  /** 裁决规则说明 */
  policy?: string;
}

export interface ConflictVerdict {
  /** 建议采用的版本索引 */
  adopt: ChoiceAnswer;
  /** 是否可直接定稿（P(yes)），否则需人工 */
  autoResolve: NoulAnswer;
  /** 各版本可信度 0~3 */
  reliability: ScoreAnswer;
  raw: DecisionResult;
}

export async function resolveAttrConflict(decider: Decider, c: AttributeConflict): Promise<ConflictVerdict> {
  const criteria: Record<string, string> = {};
  c.versions.forEach((v, i) => {
    criteria[`v${i + 1}`] = `「${v.value}」来源：${v.source}${v.rank ? `（${v.rank === "user" ? "用户原话" : v.rank === "assistant" ? "助手资料" : "未知"}）` : ""}${v.note ? `，${v.note}` : ""}`;
  });
  criteria.other = "以上都不合适，需要重新确认";
  const questions = {
    adopt: q.choice(criteria, `${c.entity} 的「${c.attr}」应采用哪个版本？${c.policy ? `裁决规则：${c.policy}` : "裁决规则：用户原话优先于助手资料，新版本优先于旧版本。"}`),
    autoResolve: q.noul("根据规则能否直接定稿，不需要人工再确认？", { true: "可以自动定稿", false: "需人工判断" }),
    reliability: q.score(["很不确定", "有争议", "基本可信", "证据充分"], "被采用版本的可信度"),
  };
  const state = {
    实体: c.entity,
    属性: c.attr,
    候选版本: c.versions.map((v, i) => ({ 编号: `v${i + 1}`, 值: v.value, 来源: v.source, 性质: v.rank, 时间: v.when, 备注: v.note })),
  };
  const raw = await decider.decide({ state, questions });
  return {
    adopt: raw.answers.adopt as ChoiceAnswer,
    autoResolve: raw.answers.autoResolve as NoulAnswer,
    reliability: raw.answers.reliability as ScoreAnswer,
    raw,
  };
}

/* ============================================================
 * 4. 新素材归类：一条设定该归到哪个实体 / 是否与现有冲突
 * ============================================================ */

export interface IngestItem {
  /** 新素材文本 */
  text: string;
  /** 候选实体 */
  entities: { name: string; kind: Entity["kind"]; summary?: string }[];
}

export interface IngestVerdict {
  /** 归到哪个实体 */
  target: ChoiceAnswer;
  /** 是否与现有设定冲突 */
  conflicts: NoulAnswer;
  /** 证据等级：用户原话 / 用户推演 / 助手延伸 / 无法判断 */
  evidenceLevel: ChoiceAnswer;
  raw: DecisionResult;
}

export const EVIDENCE_LEVELS = {
  user_statement: "用户直接陈述，可作正史",
  user_inference: "用户以「也许 / 没准」提出的推演，方向可用细节未定",
  assistant_extension: "助手补的阐释，用户未确认，仅作候选",
  unclear: "无法判断",
};

export async function classifyIngest(decider: Decider, item: IngestItem): Promise<IngestVerdict> {
  const criteria: Record<string, string> = {};
  item.entities.forEach((e, i) => (criteria[`e${i + 1}`] = `${e.name}（${{ character: "角色", location: "地点", faction: "势力", item: "物品", lore: "世界观" }[e.kind]}）${e.summary ? `：${e.summary}` : ""}`));
  criteria.new = "新实体，现有设定里没有";
  const raw = await decider.decide({
    state: { 候选实体: item.entities.map((e) => e.name), 新素材: item.text },
    questions: {
      target: q.choice(criteria, "这条新设定描述的是哪个实体？"),
      conflicts: q.noul("这条新设定是否与候选实体的现有简介矛盾？", { true: "有矛盾", false: "不矛盾或是新增" }),
      evidenceLevel: q.choice(EVIDENCE_LEVELS, "这条素材的证据等级"),
    },
  });
  return {
    target: raw.answers.target as ChoiceAnswer,
    conflicts: raw.answers.conflicts as NoulAnswer,
    evidenceLevel: raw.answers.evidenceLevel as ChoiceAnswer,
    raw,
  };
}
