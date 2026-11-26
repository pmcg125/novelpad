/**
 * 决策模型 Provider（阿里云百炼 decision-model）
 *
 * 与 LLM 的本质区别：不生成文本，一次前向返回多个结构化判断 + 概率分布。
 * 延迟与输出无关（~150ms），适合高频 / 实时判断。
 *
 * 接口：POST https://{workspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone
 */

export type QuestionType = "choice" | "noul" | "score";

export interface ChoiceQuestion {
  type: "choice";
  instructions?: string;
  /** 选项名 → 描述（1~255 项，建议补 other 兜底） */
  criteria: Record<string, string>;
}

export interface NoulQuestion {
  type: "noul";
  instructions?: string;
  /** 可选：{"true": …, "false": …} 描述 */
  criteria?: { true?: string; false?: string };
}

export interface ScoreQuestion {
  type: "score";
  instructions?: string;
  /** 从低到高的等级描述（2~255 级，建议 3~7 级） */
  criteria: string[];
}

export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  /** P(yes)，0 = 否 1 = 是 */
  noul: number;
}

export interface ScoreAnswer {
  type: "score";
  /** 等级索引的概率加权期望，可落在两级之间 */
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;
export type Answers<Q extends Questions = Questions> = { [K in keyof Q]: Answer };

export interface DecisionRequest<Q extends Questions = Questions> {
  /** 待决策的业务状态：文本 / 结构化对象 / 数组 */
  state: string | Record<string, unknown> | unknown[];
  /** 最多 16 个问题 */
  questions: Q;
  /** 单图 url 或 data URL */
  image?: { url: string };
  images?: { url: string }[];
  model?: "decision-model" | "decision-model-preview";
  signal?: AbortSignal;
}

export interface DecisionResult<Q extends Questions = Questions> {
  model: string;
  requestId: string;
  answers: Answers<Q>;
  usage: { inputTokens: number };
  latencyMs: number;
  /** 客户端总耗时 */
  elapsedMs: number;
}

/** 决策能力接口：真实 Provider 与 Mock 都实现它 */
export interface Decider {
  decide<Q extends Questions>(req: DecisionRequest<Q>): Promise<DecisionResult<Q>>;
}

export interface DecisionConfig {
  /** 百炼业务空间 ID，如 llm-xxxxxxxx */
  workspaceId: string;
  apiKey: string;
  region?: "cn-beijing" | "ap-southeast-1";
  model?: "decision-model" | "decision-model-preview";
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class DecisionError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = "DecisionError";
  }
}

export class DecisionProvider implements Decider {
  readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: DecisionConfig) {
    const region = cfg.region ?? "cn-beijing";
    this.endpoint = `https://${cfg.workspaceId}.${region}.maas.aliyuncs.com/compatible-mode/v1/systemone`;
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  async decide<Q extends Questions>(req: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    if (Object.keys(req.questions).length > 16) {
      throw new DecisionError("问题数超过 16 个上限");
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    req.signal?.addEventListener("abort", () => ctrl.abort());
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: req.model ?? this.cfg.model ?? "decision-model",
          state: req.state,
          questions: req.questions,
          ...(req.image ? { image: req.image } : {}),
          ...(req.images ? { images: req.images } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new DecisionError(`决策请求失败 ${res.status}`, res.status, await res.text());
      const json = (await res.json()) as {
        model: string;
        request_id: string;
        answers: Answers<Q>;
        usage: { input_tokens: number };
        latency_ms: number;
      };
      return {
        model: json.model,
        requestId: json.request_id,
        answers: json.answers,
        usage: { inputTokens: json.usage?.input_tokens ?? 0 },
        latencyMs: json.latency_ms,
        elapsedMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ============================================================
 * 测试用：可编程的 mock
 * ============================================================ */

export class MockDecisionProvider implements Decider {
  calls: DecisionRequest[] = [];
  constructor(private readonly responder: (req: DecisionRequest) => Answers<Questions>) {}

  async decide<Q extends Questions>(req: DecisionRequest<Q>): Promise<DecisionResult<Q>> {
    this.calls.push(req as DecisionRequest);
    return {
      model: "mock-decision",
      requestId: "mock",
      answers: this.responder(req as DecisionRequest) as Answers<Q>,
      usage: { inputTokens: JSON.stringify(req.state).length },
      latencyMs: 1,
      elapsedMs: 1,
    };
  }
}

/** 便捷构造 */
export const q = {
  choice: (criteria: Record<string, string>, instructions?: string): ChoiceQuestion => ({ type: "choice", criteria, ...(instructions ? { instructions } : {}) }),
  noul: (instructions: string, criteria?: { true?: string; false?: string }): NoulQuestion => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) }),
  score: (criteria: string[], instructions?: string): ScoreQuestion => ({ type: "score", criteria, ...(instructions ? { instructions } : {}) }),
};
