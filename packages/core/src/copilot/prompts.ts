/**
 * 提示词模板：续写 / 润色 / 扩写 / 缩写 / 换视角 / 问答 / 角色卡生成
 */
import type { ChatMessage, LLMProvider, CompleteRequest } from "../llm/provider.js";
import type { AssembledContext, CharacterContext } from "./context.js";

export type CopilotAction = "polish" | "expand" | "condense" | "switch-pov" | "colloquial";

export const ACTION_LABEL: Record<CopilotAction, string> = {
  polish: "润色",
  expand: "扩写",
  condense: "缩写",
  "switch-pov": "换视角",
  colloquial: "口语化",
};

/* ============================================================
 * System prompt
 * ============================================================ */

const ANTI_AI_STYLE = `避免「AI 腔」：
- 不要用「不禁」「一丝」「仿佛整个世界都」「某种意义上」「不禁让人」
- 不要在段尾总结感悟或升华
- 不要堆砌形容词，动作和细节优先于形容
- 对话要像人说话，不要书面腔`;

/**
 * 思考方式指令：让推理模型用「小说家的思维」而不是「任务执行者的思维」推理。
 * 放在 system prompt 最前面（模型对开头的指令遵循度最高），并用身份框架代替规则清单。
 */
const THINKING_STYLE = `你的推理过程（思考）比正文更重要，请这样思考：
你是一位正在写这本书的小说家，现在坐在书桌前，手里是第 {order} 章的草稿。你的思考就是你写在草稿纸边角的批注——用中文，用小说家的口气，像「她刚才那句话说得太硬了，得让她的手先动一下」「这里不能让沈默先开口，读者会等着看他怎么接」这样。批注是短的、零碎的、想法层面的，几十到两百字就够——不要在思考里把正文预写一遍，正文留给正文。
思考时不要出现「用户」「需求」「要求」「字数」「输出」「任务」「AI」「避免」这类词，也不要复述任何规则——你不是在执行要求，你是在写小说。规则你已经内化了：人物按设定走，伏笔该埋就埋，句子用动作和细节不用形容词。
批注的顺序：先进入场景（谁在、什么光、刚才发生了什么），再推人物（他此刻想要什么、怕什么、会怎么做），再定这段要推进到哪里停。`;

function renderCharacter(c: CharacterContext): string {
  const lines = [`- ${c.name}${c.aliases?.length ? `（又称${c.aliases.join("、")}）` : ""}`];
  if (c.role) lines.push(`  定位：${roleLabel(c.role)}`);
  if (c.summary) lines.push(`  简介：${c.summary}`);
  if (c.attrs) {
    const entries = Object.entries(c.attrs).slice(0, 8);
    if (entries.length) lines.push(`  ${entries.map(([k, v]) => `${k}=${v}`).join("；")}`);
  }
  if (c.state) {
    const parts: string[] = [];
    if (c.state.emotion) parts.push(`情绪：${c.state.emotion}`);
    if (c.state.location) parts.push(`位置：${c.state.location}`);
    if (c.state.knows?.length) parts.push(`已知晓：${c.state.knows.join("、")}`);
    if (parts.length) lines.push(`  当前状态：${parts.join("，")}`);
  }
  if (c.relationsWithPresent.length) {
    lines.push(`  与本章人物：${c.relationsWithPresent.map((r) => `${r.target}（${r.type}）`).join("，")}`);
  }
  return lines.join("\n");
}

function roleLabel(r: string): string {
  return { protagonist: "主角", antagonist: "对手", supporting: "次要", minor: "路人" }[r] ?? r;
}

export function buildSystemPrompt(ctx: AssembledContext): string {
  const parts: string[] = [];
  parts.push(THINKING_STYLE.replace("{order}", String(ctx.chapter.order)));
  parts.push("");
  parts.push(`你是小说《${ctx.title}》的作者之一，正在和另一位作者合作写第 ${ctx.chapter.order} 章「${ctx.chapter.title}」。`);
  if (ctx.chapter.volume) parts.push(`所属卷：${ctx.chapter.volume}。`);
  parts.push("");
  if (ctx.characters.length) {
    parts.push("本章出场人物设定（必须严格遵守，不得矛盾）：");
    parts.push(ctx.characters.map(renderCharacter).join("\n"));
    parts.push("");
  }
  if (ctx.locations.length) parts.push(`场景地点：${ctx.locations.join("、")}`);
  if (ctx.foreshadows.length) {
    const open = ctx.foreshadows.filter((f) => f.status === "open").map((f) => f.id);
    const due = ctx.foreshadows.filter((f) => f.status !== "open").map((f) => `${f.id}（${f.status === "overdue" ? "已逾期" : "即将到期"}，${f.note ?? ""}）`);
    if (due.length) parts.push(`伏笔提醒：${due.join("；")} — 本章可以考虑回收，但不要生硬。`);
    if (open.length) parts.push(`已埋伏笔：${open.join("、")}`);
  }
  if (ctx.constraints.length) parts.push(`约束：\n${ctx.constraints.map((c) => `- ${c}`).join("\n")}`);
  parts.push("");
  parts.push(ANTI_AI_STYLE);
  parts.push("正文用简体中文，Markdown 段落，不加标题。");
  return parts.join("\n");
}

/* ============================================================
 * 任务
 * ============================================================ */

export interface ContinuationRequest {
  ctx: AssembledContext;
  /** 用户额外的指示，如「让沈默进门」 */
  hint?: string;
  maxTokens?: number;
  /** RAG 检索到的相关设定 / 相似场景（已格式化文本） */
  retrieved?: string;
  /** 决策模型给出的续写约束（如情绪 / 节奏） */
  preConstraints?: string[];
  /** 决策判断的各角色情绪 */
  preEmotions?: Record<string, { choice: string; confidence: number }>;
}

/** 续写请求 */
export function buildContinuationMessages(req: ContinuationRequest): ChatMessage[] {
  const { ctx } = req;
  const user: string[] = [];
  if (ctx.prevChapterTail) user.push(`【上一章结尾】\n${ctx.prevChapterTail}\n`);
  if (ctx.styleSamples.length) user.push(`【你之前写的文字（保持这个手感）】\n${ctx.styleSamples.join("\n……\n")}\n`);
  if (req.retrieved) user.push(`【你翻了一下设定本和旧稿，找到这些相关段落】\n${req.retrieved}`);
  user.push(`【当前章草稿（写到这里停笔）】\n${ctx.recentText}\n`);
  user.push("从这里接着往下写一小段（两三百字），到一个可以停笔的地方收。不要重复已有内容，不要解释，只给正文。");
  if (req.preEmotions && Object.keys(req.preEmotions).length) {
    const e = Object.entries(req.preEmotions).filter(([, v]) => v.confidence > 0.5).map(([k, v]) => `${k}：${v.choice}`);
    if (e.length) user.push(`（你心里清楚此刻的人物状态：${e.join("，")}）`);
  }
  if (req.preConstraints?.length) user.push(`（写作时注意：${req.preConstraints.join("；")}）`);
  if (req.hint) user.push(`另一位作者的批注：${req.hint}`);
  return [
    { role: "system", content: buildSystemPrompt(ctx) },
    { role: "user", content: user.join("\n") },
  ];
}

/** 编辑请求（选中文字 → 改写） */
export function buildEditMessages(action: CopilotAction, selection: string, ctx: AssembledContext, povName?: string): ChatMessage[] {
  const rules: Record<CopilotAction, string> = {
    polish: "润色这段文字：保持原意、人称、节奏和所有情节，只改表达。让句子更精准、更有画面感，删掉冗余的形容词。",
    expand: "扩写这段文字：保持原意和视角，增加动作、感官细节和环境描写，长度约为原文的 1.5~2 倍。不要新增情节转折，不要新增人物。",
    condense: "缩写这段文字：保留所有关键情节和信息，删掉冗余，长度约为原文的 60%。",
    "switch-pov": `把这段文字改为${povName ? `「${povName}」` : "另一人物"}的视角：情节不变，只改变叙述者的感知和内心。如果原文是第三人称有限视角，改为新人物的第三人称有限视角。`,
    colloquial: "把这段文字的叙述改得更口语化、更轻快，对话部分保持原样。",
  };
  return [
    { role: "system", content: buildSystemPrompt(ctx) },
    {
      role: "user",
      content: `${rules[action]}\n\n严格按以下 JSON 格式输出，不要输出其他内容：\n{"rewritten": "改写后的文字", "changes": ["改动点1", "改动点2"]}\n\n【原文】\n${selection}`,
    },
  ];
}

export interface EditResult {
  rewritten: string;
  changes: string[];
}

/** 解析编辑结果（容错：模型可能裹 ```json） */
export function parseEditResult(text: string): EditResult {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const j = JSON.parse(stripped) as Partial<EditResult>;
    if (typeof j.rewritten === "string") {
      return { rewritten: j.rewritten, changes: Array.isArray(j.changes) ? j.changes.filter((c): c is string => typeof c === "string") : [] };
    }
  } catch {
    /* fallthrough */
  }
  // 不是 JSON：整段当作改写结果
  return { rewritten: stripped, changes: [] };
}

/** 后处理续写：去掉重复的前缀、Markdown 标题、多余空行 */
export function cleanContinuation(raw: string, recentText: string): string {
  let s = raw.trim();
  s = s.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "");
  s = s.replace(/^#+\s*.+\n+/, ""); // 去标题
  s = s.replace(/^(续写|以下|接着)[:：]\s*/u, "");
  // 去掉与前文末尾重复的片段
  const tail = recentText.replace(/\s+/g, "").slice(-12);
  if (tail.length >= 4) {
    const ns = s.replace(/\s+/g, "");
    let overlap = 0;
    for (let n = Math.min(tail.length, 12); n >= 4; n--) {
      if (ns.startsWith(tail.slice(-n))) {
        overlap = n;
        break;
      }
    }
    if (overlap) {
      // 按原文（含空白）位置裁掉
      let removed = 0;
      let i = 0;
      while (i < s.length && removed < overlap) {
        if (!/\s/.test(s[i]!)) removed++;
        i++;
      }
      s = s.slice(i);
    }
  }
  return s.trim();
}

/* ============================================================
 * 问答
 * ============================================================ */

export interface QuestionContext {
  title: string;
  chapterOrder?: number;
  /** 相关事实（由工具检索得到） */
  facts: string[];
}

export function buildQuestionMessages(q: string, ctx: QuestionContext): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        `你是小说《${ctx.title}》的设定助手。只根据下面提供的「设定事实」回答，不要编造。`,
        `如果事实不足以回答，明确说「设定里没有提到」。`,
        ctx.chapterOrder ? `作者正在写第 ${ctx.chapterOrder} 章。` : "",
        ctx.facts.length ? `【设定事实】\n${ctx.facts.map((f) => `- ${f}`).join("\n")}` : "【设定事实】（无）",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    { role: "user", content: q },
  ];
}

/* ============================================================
 * 便捷调用
 * ============================================================ */

export interface CopilotOutput<T> {
  result: T;
  /** 推理模型的思考过程 */
  reasoning?: string;
  /** 耗时（毫秒） */
  elapsedMs: number;
}

export async function continueStory(provider: LLMProvider, req: ContinuationRequest): Promise<CopilotOutput<string>> {
  const messages = buildContinuationMessages(req);
  // 推理模型会先消耗 token 思考，maxTokens 要给足余量
  const base: CompleteRequest = { messages, maxTokens: req.maxTokens ?? 2500, temperature: 0.85, frequencyPenalty: 0.3 };
  const t0 = Date.now();
  const r = await provider.complete(base);
  return { result: cleanContinuation(r.text, req.ctx.recentText), reasoning: r.reasoning, elapsedMs: Date.now() - t0 };
}

export async function editText(provider: LLMProvider, action: CopilotAction, selection: string, ctx: AssembledContext, povName?: string): Promise<CopilotOutput<EditResult>> {
  const t0 = Date.now();
  const r = await provider.complete({ messages: buildEditMessages(action, selection, ctx, povName), maxTokens: 2500, temperature: 0.5 });
  return { result: parseEditResult(r.text), reasoning: r.reasoning, elapsedMs: Date.now() - t0 };
}

export async function askQuestion(provider: LLMProvider, q: string, ctx: QuestionContext): Promise<CopilotOutput<string>> {
  const t0 = Date.now();
  const r = await provider.complete({ messages: buildQuestionMessages(q, ctx), maxTokens: 2000, temperature: 0.3 });
  return { result: r.text.trim(), reasoning: r.reasoning, elapsedMs: Date.now() - t0 };
}

/** 生成角色卡草稿（从正文推断） */
export async function draftCharacterCard(provider: LLMProvider, name: string, evidence: string[], title: string): Promise<CopilotOutput<string>> {
  const t0 = Date.now();
  const r = await provider.complete({
    messages: [
      {
        role: "system",
        content: `你是小说《${title}》的设定编辑。根据正文片段为角色「${name}」生成一张 YAML 角色卡草稿。只输出 YAML，字段：name, aliases[], role(protagonist|antagonist|supporting|minor), tags[], summary, attrs{}, relations[]。无法从证据确定的字段留空，不要编造。思考时用中文，像编辑整理人物档案一样逐条核对证据。`,
      },
      { role: "user", content: evidence.map((e, i) => `片段${i + 1}：${e}`).join("\n\n") },
    ],
    maxTokens: 2000,
    temperature: 0.3,
  });
  return {
    result: r.text.replace(/^```(?:yaml)?\s*/i, "").replace(/\s*```$/, "").trim(),
    reasoning: r.reasoning,
    elapsedMs: Date.now() - t0,
  };
}
