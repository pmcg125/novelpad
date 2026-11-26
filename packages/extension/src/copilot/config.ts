/**
 * Copilot 配置：baseUrl / model 走 settings，apiKey 走 SecretStorage
 */
import * as vscode from "vscode";
import { OpenAICompatibleProvider, PROVIDER_PRESETS, type LLMProvider } from "@novelpad/core";

export const CFG = {
  enabled: "novelpad.copilot.enabled",
  preset: "novelpad.copilot.provider",
  baseUrl: "novelpad.copilot.baseUrl",
  model: "novelpad.copilot.model",
  editModel: "novelpad.copilot.editModel",
  timeoutMs: "novelpad.copilot.timeoutMs",
} as const;

const SECRET_KEY = "novelpad.copilot.apiKey";

export class CopilotConfig {
  constructor(readonly secrets: vscode.SecretStorage) {}

  async getApiKey(): Promise<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  async setApiKey(key: string | undefined): Promise<void> {
    if (key) await this.secrets.store(SECRET_KEY, key);
    else await this.secrets.delete(SECRET_KEY);
  }

  /** 读取当前生效的连接参数 */
  read(): { enabled: boolean; baseUrl: string; model: string; editModel: string; timeoutMs: number; hasKey: boolean; showReasoning: boolean } {
    const c = vscode.workspace.getConfiguration();
    const preset = c.get<string>(CFG.preset, "custom");
    const presetUrl = PROVIDER_PRESETS[preset]?.baseUrl;
    return {
      enabled: c.get<boolean>(CFG.enabled, true),
      baseUrl: c.get<string>(CFG.baseUrl, "") || presetUrl || PROVIDER_PRESETS.custom!.baseUrl,
      model: c.get<string>(CFG.model, "deepseek-v4.1-flash"),
      editModel: c.get<string>(CFG.editModel, "") || c.get<string>(CFG.model, "deepseek-v4.1-flash"),
      timeoutMs: c.get<number>(CFG.timeoutMs, 90_000),
      hasKey: false,
      showReasoning: c.get<boolean>("novelpad.copilot.showReasoning", true),
    };
  }

  /** 创建 Provider（续写用 model，编辑用 editModel） */
  async provider(kind: "continue" | "edit" = "continue"): Promise<{ provider: LLMProvider; cfg: ReturnType<CopilotConfig["read"]> }> {
    const cfg = this.read();
    const apiKey = await this.getApiKey();
    const model = kind === "edit" ? cfg.editModel : cfg.model;
    const provider = new OpenAICompatibleProvider({ baseUrl: cfg.baseUrl, apiKey, model });
    return { provider, cfg: { ...cfg, hasKey: !!apiKey } };
  }

  /** 未配置 key 时引导 */
  static async promptApiKey(secrets: vscode.SecretStorage): Promise<void> {
    const key = await vscode.window.showInputBox({
      prompt: "输入 Novel Copilot 的 API Key（仅保存在本机，不会写入 settings.json）",
      password: true,
      placeHolder: "sk-…",
      ignoreFocusOut: true,
    });
    if (key === undefined) return;
    await secrets.store(SECRET_KEY, key.trim());
    void vscode.window.showInformationMessage("NovelPad：API Key 已保存");
  }
}

/* ---------- 设置项声明（在 package.json contributes.configuration 中） ---------- */
export const CONFIGURATION_PROPERTIES = {
  "novelpad.copilot.enabled": {
    type: "boolean",
    default: true,
    description: "启用 Novel Copilot（续写 / 润色 / 问答）。",
  },
  "novelpad.copilot.showReasoning": {
    type: "boolean",
    default: true,
    description: "推理模型的思考过程（以小说家口吻写的批注）：续写完成后状态栏可点击查看，改写预览顶部折叠显示。",
  },
  "novelpad.copilot.provider": {
    type: "string",
    enum: Object.keys(PROVIDER_PRESETS),
    enumDescriptions: Object.values(PROVIDER_PRESETS).map((p) => `${p.label}${p.hint ? ` — ${p.hint}` : ""}`),
    default: "custom",
    description: "服务商预设（决定默认 baseUrl，可被 novelpad.copilot.baseUrl 覆盖）。",
  },
  "novelpad.copilot.baseUrl": {
    type: "string",
    default: "",
    description: "OpenAI 兼容接口地址。留空则使用服务商预设。",
  },
  "novelpad.copilot.model": {
    type: "string",
    default: "deepseek-v4.1-flash",
    description: "续写用模型。",
  },
  "novelpad.copilot.editModel": {
    type: "string",
    default: "",
    description: "润色 / 扩写 / 问答用模型。留空则与续写相同。",
  },
  "novelpad.copilot.timeoutMs": {
    type: "number",
    default: 90000,
    description: "请求超时（毫秒）。推理模型建议 ≥ 60000。",
  },
  "novelpad.copilot.continuationKeybinding": {
    type: "string",
    default: "",
    deprecationMessage: "请在键盘快捷方式中搜索 novelpad.continueStory 设置。",
  },
};
