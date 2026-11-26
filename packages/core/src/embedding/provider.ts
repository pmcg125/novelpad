/**
 * Embedding Provider 抽象
 * - OpenAICompatibleEmbedding：阿里云 DashScope 兼容模式 / OpenAI / 本地反代
 * - 本地 ONNX（Transformers.js）留作后续选项
 */

export interface EmbeddingConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 单次请求最多多少条（DashScope 限制 25） */
  batchSize?: number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface EmbeddingResult {
  /** 与输入顺序一致 */
  vectors: number[][];
  model: string;
  promptTokens: number;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly dims: number | undefined;
  embed(texts: string[]): Promise<EmbeddingResult>;
}

export class EmbeddingError extends Error {
  constructor(message: string, public readonly status?: number, public readonly body?: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export class OpenAICompatibleEmbedding implements EmbeddingProvider {
  readonly id: string;
  dims: number | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly batchSize: number;

  constructor(private readonly cfg: EmbeddingConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.id = `openai-compatible:${cfg.model}`;
    this.fetchImpl = cfg.fetch ?? fetch;
    this.batchSize = Math.min(cfg.batchSize ?? 10, 25);
  }

  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (!texts.length) return { vectors: [], model: this.cfg.model, promptTokens: 0 };
    const vectors: number[][] = [];
    let promptTokens = 0;
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const r = await this.embedBatch(batch);
      vectors.push(...r.vectors);
      promptTokens += r.promptTokens;
      if (this.dims === undefined && r.vectors[0]) this.dims = r.vectors[0].length;
    }
    return { vectors, model: this.cfg.model, promptTokens };
  }

  private async embedBatch(input: string[]): Promise<{ vectors: number[][]; promptTokens: number }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 30_000);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.cfg.model, input, dimensions: undefined }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new EmbeddingError(`Embedding 请求失败 ${res.status}`, res.status, await res.text());
      const json = (await res.json()) as {
        data?: { embedding?: number[]; index?: number }[];
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };
      const items = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      const vectors = items.map((d) => d.embedding ?? []);
      if (vectors.length !== input.length) {
        throw new EmbeddingError(`Embedding 返回数量不匹配：期望 ${input.length}，实际 ${vectors.length}`);
      }
      return { vectors, promptTokens: json.usage?.prompt_tokens ?? json.usage?.total_tokens ?? 0 };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 测试用：确定性伪向量（按字符 hash 生成），保证相同文本 → 相同向量 */
export class MockEmbedding implements EmbeddingProvider {
  readonly id = "mock-embedding";
  readonly dims: number;
  constructor(dims = 16) {
    this.dims = dims;
  }
  async embed(texts: string[]): Promise<EmbeddingResult> {
    const vectors = texts.map((t) => {
      const v = new Array<number>(this.dims).fill(0);
      for (let i = 0; i < t.length; i++) {
        const c = t.charCodeAt(i);
        v[i % this.dims] += Math.sin(c * (i + 1)) * 0.5 + 0.5;
      }
      // 归一化
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, model: "mock", promptTokens: texts.reduce((s, t) => s + t.length, 0) };
  }
}

export const EMBEDDING_PRESETS: Record<string, { label: string; baseUrl: string; model: string; dims: number; hint?: string }> = {
  dashscope: {
    label: "阿里云 DashScope（通义）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen3.7-text-embedding-flash",
    dims: 1024,
    hint: "需 DashScope API Key",
  },
  custom: { label: "自定义 / 本地反代", baseUrl: "http://127.0.0.1:8788/v1", model: "qwen3.7-text-embedding-flash", dims: 1024 },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "text-embedding-3-small", dims: 1536 },
};
