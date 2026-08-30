import type { Api, Model, Models, TextContent } from "@earendil-works/pi-ai";
import type { Block, TokenUsageTotals } from "./types.ts";
import { protectPlaceholders, restorePlaceholders } from "./classify.ts";
import {
  appendGlossary,
  buildGlossarySystemPrompt,
  extractGlossary,
  type GlossaryCall,
  type GlossaryEntry,
} from "./glossary.ts";

export interface TranslateJobOptions {
  targetLanguage: string;
  batchSizeChars: number;
  concurrency: number;
}

export interface BatchItem {
  id: string;
  text: string;
}

export interface BatchResult {
  id: string;
  translation: string;
}

export interface Translator {
  translateBatch(
    items: BatchItem[],
    signal: AbortSignal,
  ): Promise<BatchResult[]>;
  usage(): TokenUsageTotals;
  /** 文書全体の用語集を抽出する(対応する実装のみ)。 */
  extractGlossary?(
    texts: string[],
    signal: AbortSignal,
  ): Promise<GlossaryEntry[]>;
  /** 用語集を反映した新しい Translator を返す(対応する実装のみ)。 */
  withGlossary?(entries: GlossaryEntry[]): Translator;
}
/** ターゲット言語が日本語かどうか。ラベル("日本語"等)またはコード("ja")で判定する。 */
export function isJapaneseTarget(targetLanguage: string): boolean {
  const t = targetLanguage.trim().toLowerCase();
  return t === "ja" || t.includes("日本") || t.includes("japanese");
}

export function buildSystemPrompt(targetLanguage: string): string {
  const styleRules = isJapaneseTarget(targetLanguage)
    ? [
      "Japanese style (MANDATORY):",
      "1. Write in 常体 (だ・である調): sentence-final predicates must be である / だ / する / した / される / された, etc.",
      "2. Never use 敬体 (です / ます / でした / ました), even mid-sentence.",
      "3. Keep the same style in every item so the whole document is consistent.",
    ]
    : [];
  return [
    `You are a professional translator of academic papers. Translate the "text" field of every item into ${targetLanguage}.`,
    "Use a formal academic register appropriate for scholarly publications.",
    ...styleRules,
    "Hard rules:",
    '1. Reply with ONLY a JSON array of objects shaped {"id": string, "translation": string}. No markdown fences, no commentary.',
    "2. Preserve placeholders such as [[M0]] exactly as they appear; never translate, reorder, or drop them.",
    "3. Do not add explanations, notes, greetings, or trailing punctuation that is not in the source.",
    "4. Keep numbers, units, and proper nouns accurate. Keep line breaks out; return a single string per item.",
    "5. Every input id must appear exactly once in the output array.",
    "6. Keep the same English term rendered identically everywhere in the document. Never give the same source term different translations in different items.",
    "7. Coined terms, method names, product names, and proper nouns without an established translation must stay in English; never invent a translation for them.",
    "8. On the first occurrence of such a kept English term in an item, you may append the English in parentheses after the translation, like 訳語 (Original Term); afterwards use the translation alone.",
    "9. A glossary may be appended to this prompt. Glossary entries override rules 6-8 and are binding.",
  ].join("\n");
}

export class PiTranslator implements Translator {
  #models: Models;
  #model: Model<Api>;
  #systemPrompt: string;
  #totals: TokenUsageTotals = {
    input: 0,
    output: 0,
    total: 0,
    costTotal: 0,
  };

  #targetLanguage: string;

  constructor(
    models: Models,
    model: Model<Api>,
    systemPrompt: string,
    targetLanguage = "",
  ) {
    this.#models = models;
    this.#model = model;
    this.#systemPrompt = systemPrompt;
    this.#targetLanguage = targetLanguage;
  }

  usage(): TokenUsageTotals {
    return this.#totals;
  }

  async translateBatch(
    items: BatchItem[],
    signal: AbortSignal,
  ): Promise<BatchResult[]> {
    const payload = JSON.stringify(
      items.map((i) => ({ id: i.id, text: i.text })),
    );
    const message = await this.#models.completeSimple(
      this.#model,
      {
        systemPrompt: this.#systemPrompt,
        messages: [
          { role: "user", content: payload, timestamp: Date.now() },
        ],
      },
      {
        temperature: 0.2,
        maxTokens: Math.max(
          2048,
          items.reduce((a, i) => a + i.text.length, 0) * 3,
        ),
        signal,
      },
    );
    const u = message.usage;
    if (u) {
      this.#totals.input += u.input ?? 0;
      this.#totals.output += u.output ?? 0;
      this.#totals.total += u.totalTokens ?? 0;
      this.#totals.costTotal += u.cost?.total ?? 0;
    }
    if (message.stopReason === "aborted") {
      throw new DOMException("aborted", "AbortError");
    }
    if (message.stopReason === "error") {
      throw new Error(message.errorMessage ?? "LLM request failed");
    }
    const text = message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("");
    return parseBatchResponse(text, items);
  }

  #complete(
    systemPrompt: string,
    userText: string,
    signal: AbortSignal,
  ): Promise<string> {
    return this.#models.completeSimple(
      this.#model,
      {
        systemPrompt,
        messages: [
          { role: "user", content: userText, timestamp: Date.now() },
        ],
      },
      {
        temperature: 0,
        maxTokens: Math.max(2048, userText.length * 2),
        signal,
      },
    ).then((message) => {
      const u = message.usage;
      if (u) {
        this.#totals.input += u.input ?? 0;
        this.#totals.output += u.output ?? 0;
        this.#totals.total += u.totalTokens ?? 0;
        this.#totals.costTotal += u.cost?.total ?? 0;
      }
      if (message.stopReason === "aborted") {
        throw new DOMException("aborted", "AbortError");
      }
      if (message.stopReason === "error") {
        throw new Error(message.errorMessage ?? "LLM request failed");
      }
      return message.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("");
    });
  }

  extractGlossary(
    texts: string[],
    signal: AbortSignal,
  ): Promise<GlossaryEntry[]> {
    const call: GlossaryCall = (system, user, sig) =>
      this.#complete(system, user, sig);
    return extractGlossary(
      call,
      texts,
      buildGlossarySystemPrompt(this.#targetLanguage),
      signal,
    );
  }

  withGlossary(entries: GlossaryEntry[]): Translator {
    return new PiTranslator(
      this.#models,
      this.#model,
      appendGlossary(this.#systemPrompt, entries),
      this.#targetLanguage,
    );
  }
}

export function parseBatchResponse(
  raw: string,
  expected: BatchItem[],
): BatchResult[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error("response is not a JSON array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`invalid JSON in response: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("response is not a JSON array");
  const results: BatchResult[] = [];
  for (const entry of parsed) {
    if (
      entry && typeof entry === "object" && "id" in entry &&
      "translation" in entry
    ) {
      const id = String((entry as Record<string, unknown>).id);
      const translation = String(
        (entry as Record<string, unknown>).translation ?? "",
      );
      if (expected.some((e) => e.id === id)) {
        results.push({ id, translation });
      }
    }
  }
  if (results.length === 0) throw new Error("no valid entries in response");
  return results;
}

export class FauxEchoTranslator implements Translator {
  #totals: TokenUsageTotals = { input: 0, output: 0, total: 0, costTotal: 0 };

  async translateBatch(
    items: BatchItem[],
    _signal: AbortSignal,
  ): Promise<BatchResult[]> {
    await new Promise((r) => setTimeout(r, 30));
    let inputChars = 0;
    const results = items.map((i) => {
      inputChars += i.text.length;
      return { id: i.id, translation: `FAUX:${i.text}` };
    });
    this.#totals.input += Math.ceil(inputChars / 4);
    this.#totals.output += Math.ceil(inputChars / 5);
    this.#totals.total += Math.ceil(inputChars / 4) + Math.ceil(inputChars / 5);
    return results;
  }

  usage(): TokenUsageTotals {
    return this.#totals;
  }
}

export interface TranslateProgress {
  onBlockDone?: (blockId: string, ok: boolean) => void;
  onUsage?: (usage: TokenUsageTotals) => void;
}

export async function translateBlocks(
  blocks: Block[],
  translator: Translator,
  options: TranslateJobOptions,
  signal: AbortSignal,
  progress: TranslateProgress = {},
  maxAttempts = 3,
): Promise<void> {
  const pending = blocks.filter((b) => b.status === "pending");
  for (const block of pending) {
    const p = protectPlaceholders(block.originalText);
    block.text = p.text;
    block.protectedTokens = p.tokens;
  }
  const batches: BatchItem[][] = [];
  let current: BatchItem[] = [];
  let currentChars = 0;
  for (const block of pending) {
    const item: BatchItem = { id: block.id, text: block.text };
    if (
      current.length > 0 &&
      currentChars + item.text.length > options.batchSizeChars
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += item.text.length;
  }
  if (current.length) batches.push(current);

  const byId = new Map(pending.map((b) => [b.id, b]));
  let nextBatch = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextBatch++;
      if (index >= batches.length) return;
      const batch = batches[index];
      await runBatchWithRetry(
        batch,
        byId,
        translator,
        signal,
        progress,
        maxAttempts,
      );
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency, batches.length)) },
    () => worker(),
  );
  await Promise.all(workers);
}

async function runBatchWithRetry(
  batch: BatchItem[],
  byId: Map<string, Block>,
  translator: Translator,
  signal: AbortSignal,
  progress: TranslateProgress,
  maxAttempts: number,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const results = await translator.translateBatch(batch, signal);
      for (const item of batch) {
        const block = byId.get(item.id);
        if (!block) continue;
        const result = results.find((r) => r.id === item.id);
        if (!result) {
          block.status = "failed";
          block.warnings = ["翻訳応答に項目が含まれず原文を保持しました"];
          progress.onBlockDone?.(item.id, false);
          continue;
        }
        const restored = restorePlaceholders(
          result.translation,
          block.protectedTokens ?? [],
        );
        if (restored.missingTokens.length > 0) {
          block.warnings = [
            `プレースホルダが欠落: ${restored.missingTokens.join(", ")}`,
          ];
        }
        block.translation = restored.text;
        block.status = "translated";
        progress.onBlockDone?.(item.id, true);
      }
      progress.onUsage?.(translator.usage());
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      lastError = err;
    }
  }
  void lastError;
  for (const item of batch) {
    const block = byId.get(item.id);
    if (!block) continue;
    block.status = "failed";
    block.warnings = ["翻訳に失敗したため原文を保持しました"];
    progress.onBlockDone?.(item.id, false);
  }
  progress.onUsage?.(translator.usage());
}
