import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { envApiKeyAuth, createProvider } from "@earendil-works/pi-ai";
import type {
  Model,
  OpenAICompletionsCompat,
} from "@earendil-works/pi-ai";

const BASE_URL = "https://api.deepinfra.com/v1/openai";

// DeepInfra は OpenAI 互換の chat/completions を提供する。
// 未知ホストに対する自動検出は max_completion_tokens を使うため、
// DeepInfra が受け付ける max_tokens を明示する。
const COMPAT = {
  supportsStore: false,
  maxTokensField: "max_tokens",
} satisfies OpenAICompletionsCompat;

// モデルカタログは 2026-08-30 時点の api.deepinfra.com/models/{author}/{name}
// から取得。更新時は各モデルの max_tokens / pricing を確認すること。
interface DeepInfraModelSpec {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  /** USD per 1M input tokens */
  inputCost: number;
  /** USD per 1M output tokens */
  outputCost: number;
}

const MODEL_SPECS: DeepInfraModelSpec[] = [
  // DeepSeek
  {
    id: "deepseek-ai/DeepSeek-V3",
    name: "DeepSeek V3",
    reasoning: false,
    contextWindow: 163840,
    inputCost: 0.32,
    outputCost: 0.89,
  },
  {
    id: "deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    contextWindow: 163840,
    inputCost: 0.26,
    outputCost: 0.38,
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash",
    reasoning: true,
    contextWindow: 1048576,
    inputCost: 0.09,
    outputCost: 0.18,
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Flash-0731",
    name: "DeepSeek V4 Flash (0731)",
    reasoning: true,
    contextWindow: 1048576,
    inputCost: 0.08,
    outputCost: 0.18,
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    reasoning: false,
    contextWindow: 1048576,
    inputCost: 1.3,
    outputCost: 2.6,
  },
  {
    id: "deepseek-ai/DeepSeek-V4-Pro-0813",
    name: "DeepSeek V4 Pro (0813)",
    reasoning: false,
    contextWindow: 1048576,
    inputCost: 1.3,
    outputCost: 2.6,
  },
  // Qwen
  {
    id: "Qwen/Qwen3-Max",
    name: "Qwen3 Max",
    reasoning: false,
    contextWindow: 256000,
    inputCost: 1.2,
    outputCost: 6,
  },
  {
    id: "Qwen/Qwen3-Max-Thinking",
    name: "Qwen3 Max Thinking",
    reasoning: false,
    contextWindow: 256000,
    inputCost: 1.2,
    outputCost: 6,
  },
  {
    id: "Qwen/Qwen3.5-397B-A17B",
    name: "Qwen3.5 397B A17B",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.45,
    outputCost: 3,
  },
  {
    id: "Qwen/Qwen3.6-35B-A3B",
    name: "Qwen3.6 35B A3B",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.1,
    outputCost: 0.95,
  },
  {
    id: "Qwen/Qwen3.8-2.4T-A95B",
    name: "Qwen3.8 2.4T A95B",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 2,
    outputCost: 6,
  },
  // Google
  {
    id: "google/gemma-4-26B-A4B-it",
    name: "Gemma 4 26B A4B it",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.07,
    outputCost: 0.34,
  },
  {
    id: "google/gemma-4-31B-it",
    name: "Gemma 4 31B it",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.13,
    outputCost: 0.38,
  },
  // Kimi
  {
    id: "moonshotai/Kimi-K2.5",
    name: "Kimi K2.5",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.45,
    outputCost: 2.25,
  },
  {
    id: "moonshotai/Kimi-K2.6",
    name: "Kimi K2.6",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.75,
    outputCost: 3.5,
  },
  {
    id: "moonshotai/Kimi-K2.7-Code",
    name: "Kimi K2.7 Code",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.68,
    outputCost: 3.4,
  },
  {
    id: "moonshotai/Kimi-K3",
    name: "Kimi K3",
    reasoning: false,
    contextWindow: 1048576,
    inputCost: 2.85,
    outputCost: 14.25,
  },
  // NVIDIA
  {
    id: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B",
    name: "NVIDIA Nemotron 3 Super 120B A12B",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.085,
    outputCost: 0.4,
  },
  {
    id: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B",
    name: "NVIDIA Nemotron 3 Ultra 550B A55B",
    reasoning: true,
    contextWindow: 262144,
    inputCost: 0.5,
    outputCost: 2.2,
  },
  // Z.ai (GLM)
  {
    id: "zai-org/GLM-4.7-Flash",
    name: "GLM 4.7 Flash",
    reasoning: true,
    contextWindow: 202752,
    inputCost: 0.06,
    outputCost: 0.4,
  },
  {
    id: "zai-org/GLM-5",
    name: "GLM 5",
    reasoning: true,
    contextWindow: 202752,
    inputCost: 0.6,
    outputCost: 2.08,
  },
  {
    id: "zai-org/GLM-5.1",
    name: "GLM 5.1",
    reasoning: true,
    contextWindow: 202752,
    inputCost: 1.05,
    outputCost: 3.5,
  },
  {
    id: "zai-org/GLM-5.2",
    name: "GLM 5.2",
    reasoning: true,
    contextWindow: 1048576,
    inputCost: 0.75,
    outputCost: 2.4,
  },
  {
    id: "zai-org/GLM-5.3",
    name: "GLM 5.3",
    reasoning: true,
    contextWindow: 1048576,
    inputCost: 1.2,
    outputCost: 4,
  },
  {
    id: "zai-org/GLM-5.3-Flash",
    name: "GLM 5.3 Flash",
    reasoning: true,
    contextWindow: 1048576,
    inputCost: 0.15,
    outputCost: 0.5,
  },
];

// DeepInfra の出力上限は全モデル共通で 16384 トークン
// (docs.deepinfra.com/chat/overview)
const MAX_OUTPUT_TOKENS = 16384;

const MODELS: Model<"openai-completions">[] = MODEL_SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  api: "openai-completions",
  provider: "deepinfra",
  baseUrl: BASE_URL,
  reasoning: spec.reasoning,
  input: ["text"],
  cost: {
    input: spec.inputCost,
    output: spec.outputCost,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: spec.contextWindow,
  maxTokens: MAX_OUTPUT_TOKENS,
  compat: COMPAT,
}));

/** DeepInfra: OpenAI 互換チャット API を提供する推論クラウド。 */
export function deepinfraProvider() {
  return createProvider({
    id: "deepinfra",
    name: "DeepInfra",
    baseUrl: BASE_URL,
    auth: {
      apiKey: envApiKeyAuth("DeepInfra API key", ["DEEPINFRA_API_KEY"]),
    },
    models: MODELS,
    api: openAICompletionsApi(),
  });
}
