/**
 * Rerank Provider（阿里云 qwen3.7-text-rerank）
 * 用法：向量召回 top-N（如 20）→ rerank 精排 → 取 top-k（如 5）
 */
export interface RerankConfig {
  workspaceId: string;
  apiKey: string;
  model?: string;
  region?: "cn-beijing" | "ap-southeast-1";
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface RerankResult {
  /** 按相关性降序：原始索引 + 分数 */
  results: { index: number; relevanceScore: number }[];
  usage: { totalTokens: number };
  elapsedMs: number;
}

export interface Reranker {
  readonly id: string;
  rerank(query: string, documents: string[], opts?: { topN?: number; instruct?: string }): Promise<RerankResult>;
}

/** 任务指令：默认问答检索；设定查询更接近「找相关段落」 */
export const RERANK_INSTRUCT = {
  qa: "Given a web search query, retrieve relevant passages that answer the query.",
  similar: "Retrieve semantically similar text.",
  /** 设定检索：找描述该角色 / 设定的段落 */
  lore: "Given a query about a fictional character or setting, retrieve passages that describe the character's traits, history, relationships, or the setting's rules relevant to the query.",
} as const;

export class DashScopeReranker implements Reranker {
  readonly id: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: RerankConfig) {
    const region = cfg.region ?? "cn-beijing";
    this.id = `dashscope-rerank:${cfg.model ?? "qwen3.7-text-rerank"}`;
    this.endpoint = `https://${cfg.workspaceId}.${region}.maas.aliyuncs.com/compatible-api/v1/reranks`;
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  async rerank(query: string, documents: string[], opts: { topN?: number; instruct?: string } = {}): Promise<RerankResult> {
    if (!documents.length) return { results: [], usage: { totalTokens: 0 }, elapsedMs: 0 };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    const t0 = Date.now();
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: this.cfg.model ?? "qwen3.7-text-rerank",
          query,
          documents,
          top_n: opts.topN ?? documents.length,
          instruct: opts.instruct ?? RERANK_INSTRUCT.lore,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Rerank 请求失败 ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const json = (await res.json()) as { results?: { index: number; relevance_score: number }[]; usage?: { total_tokens?: number } };
      return {
        results: (json.results ?? []).map((r) => ({ index: r.index, relevanceScore: r.relevance_score })).sort((a, b) => b.relevanceScore - a.relevanceScore),
        usage: { totalTokens: json.usage?.total_tokens ?? 0 },
        elapsedMs: Date.now() - t0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 测试用：按关键词重叠打分 */
export class MockReranker implements Reranker {
  readonly id = "mock-rerank";
  calls: { query: string; documents: string[] }[] = [];
  async rerank(query: string, documents: string[]): Promise<RerankResult> {
    this.calls.push({ query, documents });
    const chars = [...new Set([...query].filter((c) => /[\u4e00-\u9fff]/.test(c)))];
    const results = documents
      .map((d, index) => {
        let score = 0;
        for (const c of chars) if (d.includes(c)) score += 1;
        return { index, relevanceScore: chars.length ? score / chars.length : 0 };
      })
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
    return { results, usage: { totalTokens: 0 }, elapsedMs: 0 };
  }
}
