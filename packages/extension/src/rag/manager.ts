/**
 * RAG 管理：索引构建 / 增量更新 / 检索（含 rerank）
 */
import * as vscode from "vscode";
import {
  DashScopeReranker,
  OpenAICompatibleEmbedding,
  VectorIndex,
  collectChunks,
  type ChunkMeta,
  type SearchHit,
} from "@novelpad/core";
import type { ProjectStore } from "../store";

export const RAG_CFG = {
  enabled: "novelpad.rag.enabled",
  model: "novelpad.rag.embeddingModel",
  rerank: "novelpad.rag.rerank",
  rerankModel: "novelpad.rag.rerankModel",
  topK: "novelpad.rag.topK",
} as const;

export class RagManager implements vscode.Disposable {
  private index: VectorIndex | undefined;
  private embedding: OpenAICompatibleEmbedding | undefined;
  private reranker: DashScopeReranker | undefined;
  private building = false;
  private readonly status: vscode.StatusBarItem;

  constructor(private readonly store: ProjectStore) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    this.status.command = "novelpad.rag.rebuild";
  }

  /** DashScope 凭据：优先 embedding 专用 key，否则复用 copilot key */
  private dashscope(): { apiKey: string; workspaceId: string } | undefined {
    const c = vscode.workspace.getConfiguration();
    const apiKey = c.get<string>("novelpad.rag.apiKey", "") || "";
    const workspaceId = c.get<string>("novelpad.rag.workspaceId", "WORKSPACE_REDACTED");
    return { apiKey, workspaceId };
  }

  get hasApiKey(): boolean {
    return !!this.dashscope()?.apiKey;
  }

  get size(): number {
    return this.index?.size ?? 0;
  }

  get isIndexed(): boolean {
    return !!this.index && this.index.size > 0;
  }

  /** 惰性加载索引（文件存在且模型一致） */
  async ensure(): Promise<VectorIndex | undefined> {
    if (this.index) return this.index;
    const root = this.store.root;
    const ds = this.dashscope();
    if (!root || !ds?.apiKey) return undefined;
    const c = vscode.workspace.getConfiguration();
    const model = c.get<string>(RAG_CFG.model, "qwen3.7-text-embedding-flash");
    this.embedding = new OpenAICompatibleEmbedding({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: ds.apiKey, model });
    const file = vscode.Uri.joinPath(root, ".novelpad", "index", "vectors.json").fsPath;
    this.index = VectorIndex.load(file, this.embedding);
    this.updateStatus();
    return this.index;
  }

  /** 构建或增量更新索引 */
  async rebuild(opts: { silent?: boolean } = {}): Promise<{ added: number; unchanged: number; removed: number; tokens: number; chunks: number } | undefined> {
    if (this.building) return undefined;
    const project = this.store.project;
    const ds = this.dashscope();
    if (!project) {
      if (!opts.silent) void vscode.window.showWarningMessage("NovelPad：请先打开一部作品");
      return undefined;
    }
    if (!ds?.apiKey) {
      if (!opts.silent) void vscode.window.showWarningMessage("NovelPad：RAG 需要阿里云 DashScope API Key", "打开设置").then((r) => {
        if (r) void vscode.commands.executeCommand("workbench.action.openSettings", "novelpad.rag");
      });
      return undefined;
    }
    const c = vscode.workspace.getConfiguration();
    const model = c.get<string>(RAG_CFG.model, "qwen3.7-text-embedding-flash");
    const embedder = new OpenAICompatibleEmbedding({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: ds.apiKey, model });
    const file = vscode.Uri.joinPath(vscode.Uri.file(project.root), ".novelpad", "index", "vectors.json").fsPath;
    const idx = VectorIndex.load(file, embedder) ?? new VectorIndex(embedder);
    const chunks = collectChunks(project);

    this.building = true;
    this.status.text = "$(sync~spin) 索引中 0/" + chunks.length;
    this.status.show();
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "NovelPad 建立向量索引", cancellable: false },
        async (progress) => {
          return idx.sync(chunks, (done, total) => {
            const inc = Math.max(1, Math.round(total / 20));
            progress.report({ message: `${done}/${total}`, increment: inc });
            this.status.text = `$(sync~spin) 索引中 ${done}/${total}`;
          });
        },
      );
      idx.save(file);
      this.index = idx;
      this.embedding = embedder;
      this.updateStatus();
      if (!opts.silent) {
        void vscode.window.showInformationMessage(
          `NovelPad：索引完成 — ${result.chunks} 块（新增 ${result.added}，未变 ${result.unchanged}${result.removed ? `，移除 ${result.removed}` : ""}），${result.tokens.toLocaleString()} tokens`,
        );
      }
      return result;
    } catch (e) {
      void vscode.window.showErrorMessage(`NovelPad 索引失败：${(e as Error).message}`);
      return undefined;
    } finally {
      this.building = false;
      if (!this.isIndexed) this.status.hide();
    }
  }

  /** 检索（可选 rerank） */
  async search(query: string, opts: { topK?: number; filter?: (m: ChunkMeta) => boolean; rerank?: boolean } = {}): Promise<SearchHit[]> {
    const idx = await this.ensure();
    if (!idx || !idx.size) return [];
    const c = vscode.workspace.getConfiguration();
    const topK = opts.topK ?? c.get<number>(RAG_CFG.topK, 5);
    const useRerank = opts.rerank ?? c.get<boolean>(RAG_CFG.rerank, true);
    let reranker: DashScopeReranker | undefined;
    if (useRerank) {
      const ds = this.dashscope();
      if (ds?.apiKey) {
        this.reranker ??= new DashScopeReranker({ workspaceId: ds.workspaceId, apiKey: ds.apiKey, model: c.get<string>(RAG_CFG.rerankModel, "qwen3.7-text-rerank") });
        reranker = this.reranker;
      }
    }
    try {
      return await idx.search(query, { topK, filter: opts.filter, reranker, recallK: Math.max(topK * 3, 12) });
    } catch (e) {
      // rerank 失败退回纯向量
      if (reranker) return idx.search(query, { topK, filter: opts.filter });
      throw e;
    }
  }

  /** 把检索结果格式化为可注入 prompt 的文本 */
  static formatHits(hits: SearchHit[], maxChars = 2400): string {
    let out = "";
    for (const h of hits) {
      const m = h.chunk.meta;
      const where =
        m.kind === "chapter" ? `第 ${m.order} 章「${m.title}」`
        : m.kind === "entity" ? `设定「${m.entity}」${m.section ? ` / ${m.section}` : ""}`
        : m.kind === "lore" ? `世界观「${m.title}」${m.section ? ` / ${m.section}` : ""}`
        : `大纲「${m.title}」`;
      const piece = `【${where}】\n${h.chunk.text.trim()}\n\n`;
      if (out.length + piece.length > maxChars) break;
      out += piece;
    }
    return out;
  }

  private updateStatus(): void {
    if (!this.index) return;
    if (this.index.size) {
      this.status.text = `$(database) 索引 ${this.index.size}`;
      this.status.tooltip = "NovelPad 向量索引（点击重建）";
      this.status.show();
    } else this.status.hide();
  }

  dispose(): void {
    this.status.dispose();
  }
}
