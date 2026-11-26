/**
 * LLM Provider 抽象：一套 OpenAI 兼容协议覆盖 DeepSeek / GLM / Qwen / Ollama / OpenAI。
 * 零 vscode 依赖，可被 CLI / 扩展 / 测试复用。
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompleteRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** 0~2，惩罚重复 */
  frequencyPenalty?: number;
  /** 超时毫秒，默认 60000 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  /** 推理模型的思考过程（无则为空） */
  reasoning?: string;
  usage?: { promptTokens: number; completionTokens: number };
  finishReason?: string;
}

export interface LLMProvider {
  readonly id: string;
  complete(req: CompleteRequest): Promise<CompleteResult>;
  /** 流式：逐段 yield 文本 */
  stream(req: CompleteRequest): AsyncIterable<string>;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** 额外请求头 */
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class LLMError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "LLMError";
  }
}

/** OpenAI 兼容实现 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.id = `openai-compatible:${cfg.model}`;
    this.fetchImpl = cfg.fetch ?? fetch;
  }

  private build(req: CompleteRequest, stream: boolean): { url: string; init: RequestInit } {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages,
      stream,
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.frequencyPenalty !== undefined) body.frequency_penalty = req.frequencyPenalty;
    if (stream) body.stream_options = { include_usage: true };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(this.cfg.apiKey ? { Authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      ...(this.cfg.headers ?? {}),
    };
    return {
      url: `${this.baseUrl}/chat/completions`,
      init: { method: "POST", headers, body: JSON.stringify(body), signal: req.signal },
    };
  }

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    // 统一走流式：推理模型的 reasoning_content 只在流式 delta 里出现
    const { url, init } = this.build(req, true);
    const res = await this.fetchWithTimeout(url, init, req.timeoutMs);
    if (!res.ok || !res.body) throw new LLMError(`LLM 请求失败 ${res.status}`, res.status, await res.text());
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    let reasoning = "";
    let finish: string | undefined;
    let usage: CompleteResult["usage"];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const data = s.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as {
            choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
          };
          const c = j.choices?.[0];
          if (c?.delta?.reasoning_content) reasoning += c.delta.reasoning_content;
          if (c?.delta?.content) text += c.delta.content;
          if (c?.finish_reason) finish = c.finish_reason;
          if (j.usage) usage = { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0 };
        } catch {
          // 忽略无法解析的行
        }
      }
    }
    const result: CompleteResult = { text, reasoning: reasoning || undefined, usage, finishReason: finish };
    if (!text && !reasoning) {
      // 某些反代对 stream 请求返回非流式 JSON
      try {
        const j = JSON.parse(buf) as { choices?: { message?: { content?: string } }[] };
        result.text = j.choices?.[0]?.message?.content ?? "";
      } catch {
        /* ignore */
      }
    }
    return result;
  }

  /** 流式事件 */
  async *streamEvents(req: CompleteRequest): AsyncGenerator<{ type: "reasoning" | "content" | "done"; text: string }> {
    const { url, init } = this.build(req, true);
    const res = await this.fetchWithTimeout(url, init, req.timeoutMs);
    if (!res.ok || !res.body) throw new LLMError(`LLM 流式请求失败 ${res.status}`, res.status, await res.text());
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:")) continue;
        const data = s.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const j = JSON.parse(data) as { choices?: { delta?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string | null }[] };
          const c = j.choices?.[0];
          if (c?.delta?.reasoning_content) yield { type: "reasoning", text: c.delta.reasoning_content };
          if (c?.delta?.content) yield { type: "content", text: c.delta.content };
          if (c?.finish_reason) yield { type: "done", text: c.finish_reason };
        } catch {
          // 忽略无法解析的行
        }
      }
    }
  }

  /** 流式：只产出正文 */
  async *stream(req: CompleteRequest): AsyncIterable<string> {
    for await (const ev of this.streamEvents(req)) {
      if (ev.type === "content") yield ev.text;
    }
  }

  private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 60_000): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    init.signal?.addEventListener("abort", onAbort);
    try {
      return await this.fetchImpl(url, { ...init, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** 测试 / 离线用：固定回复或按函数生成 */
export class MockProvider implements LLMProvider {
  readonly id = "mock";
  public calls: CompleteRequest[] = [];
  constructor(private readonly responder: (req: CompleteRequest) => string) {}

  async complete(req: CompleteRequest): Promise<CompleteResult> {
    this.calls.push(req);
    const text = this.responder(req);
    return { text, usage: { promptTokens: 0, completionTokens: 0 } };
  }

  async *stream(req: CompleteRequest): AsyncIterable<string> {
    this.calls.push(req);
    const text = this.responder(req);
    for (const ch of text) yield ch;
  }
}

/** 常见服务商预设 baseUrl */
export const PROVIDER_PRESETS: Record<string, { label: string; baseUrl: string; hint?: string }> = {
  custom: { label: "自定义 / 本地反代", baseUrl: "http://127.0.0.1:8788/v1" },
  deepseek: { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  zhipu: { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  dashscope: { label: "通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  ollama: { label: "Ollama 本地", baseUrl: "http://localhost:11434/v1", hint: "本地模型，无需 apiKey" },
  openai: { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
};
