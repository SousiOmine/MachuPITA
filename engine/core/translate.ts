import type {
  Api,
  AssistantMessage,
  Model,
  Models,
  TextContent,
} from "@earendil-works/pi-ai";
import type { Block, TokenUsageTotals } from "./types.ts";
import { protectPlaceholders, restorePlaceholders } from "./classify.ts";
import {
  appendGlossary,
  buildGlossarySystemPrompt,
  extractGlossary,
  type GlossaryCall,
  type GlossaryEntry,
} from "./glossary.ts";
import { extractJsonArray } from "./json.ts";

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
}

/**
 * 用語集抽出に対応する Translator の拡張インターフェース。
 * 未対応の実装(FauxEchoTranslator など)は持たない(インターフェース分離)。
 */
export interface GlossaryCapable {
  extractGlossary(
    texts: string[],
    signal: AbortSignal,
  ): Promise<GlossaryEntry[]>;
  withGlossary(entries: GlossaryEntry[]): Translator;
}

/** Translator が用語集抽出に対応しているかを型ガードで判定する。 */
export function isGlossaryCapable(
  translator: Translator,
): translator is Translator & GlossaryCapable {
  return (
    typeof (translator as Partial<GlossaryCapable>).extractGlossary ===
      "function" &&
    typeof (translator as Partial<GlossaryCapable>).withGlossary === "function"
  );
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

export class PiTranslator implements Translator, GlossaryCapable {
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

  /** 応答の usage 集計と中止・エラー停止の検出を共通処理する。 */
  #recordMessage(message: AssistantMessage): void {
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
  }

  /** 応答からテキストコンテンツを連結して返す。 */
  #textOf(message: AssistantMessage): string {
    return message.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("");
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
    this.#recordMessage(message);
    return parseBatchResponse(this.#textOf(message), items);
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
      this.#recordMessage(message);
      return this.#textOf(message);
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

/** バッチIDの揺れ(前後空白・大文字・_/-・ダッシュ種・文中空白)を吸収する。 */
export function normalizeBatchId(id: string): string {
  return id.trim().toLowerCase().replace(/_/g, "-").replace(
    /[–—−‐ｰ―]/g,
    "-",
  ).replace(/\s+/g, "");
}

/** 応答配列から期待IDに対応する項目を探す。ID正規化で照合し、重複は先勝ち。 */
function findResultForId(
  results: BatchResult[],
  expectedId: string,
): BatchResult | undefined {
  const want = normalizeBatchId(expectedId);
  return results.find((r) => normalizeBatchId(r.id) === want);
}

export function parseBatchResponse(
  raw: string,
  expected: BatchItem[],
): BatchResult[] {
  const parsed = extractJsonArray(raw);
  const byNorm = new Map(expected.map((e) => [normalizeBatchId(e.id), e.id]));
  const results: BatchResult[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (
      entry && typeof entry === "object" && "id" in entry &&
      "translation" in entry
    ) {
      const rawId = String((entry as Record<string, unknown>).id);
      const canonical = byNorm.get(normalizeBatchId(rawId));
      if (canonical && !seen.has(canonical)) {
        seen.add(canonical);
        results.push({
          id: canonical,
          translation: String(
            (entry as Record<string, unknown>).translation ?? "",
          ),
        });
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

/** 翻訳バッチの最大試行回数。初回1回 + 最大3回リトライ。 */
export const TRANSLATE_MAX_ATTEMPTS = 4;
/** 翻訳リトライ前に待機するミリ秒。 */
export const TRANSLATE_RETRY_DELAY_MS = 3000;

/** 中止を検知できる待機。待機中に中止されたら AbortError を投げる。 */
function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal.aborted) {
    return Promise.reject(new DOMException("aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function translateBlocks(
  blocks: Block[],
  translator: Translator,
  options: TranslateJobOptions,
  signal: AbortSignal,
  progress: TranslateProgress = {},
  maxAttempts = TRANSLATE_MAX_ATTEMPTS,
  retryDelayMs = TRANSLATE_RETRY_DELAY_MS,
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
        retryDelayMs,
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
  retryDelayMs: number,
): Promise<void> {
  // 初回はバッチ全体、2回目以降は未完項目を1件ずつ再要求する。項目欠落・
  // プレースホルダ欠落・空訳は例外と同様に再試行対象とし、全試行後も残った
  // 欠落プレースホルダは文末補完で情報落ちを防ぐ。
  let remaining: BatchItem[] = [...batch];
  const lastPartial = new Map<string, { text: string; missing: string[] }>();
  const failureKind = new Map<string, "missing" | "error">();
  let lastError: unknown = null;

  const succeed = (itemId: string, text: string): void => {
    const block = byId.get(itemId);
    if (!block) return;
    block.translation = text;
    block.status = "translated";
    progress.onBlockDone?.(itemId, true);
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (remaining.length === 0) break;
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      if (attempt === 1) {
        const results = await translator.translateBatch(remaining, signal);
        const next: BatchItem[] = [];
        for (const item of remaining) {
          const block = byId.get(item.id);
          if (!block) continue;
          const result = findResultForId(results, item.id);
          if (!result || result.translation.trim() === "") {
            failureKind.set(item.id, "missing");
            next.push(item);
            continue;
          }
          const restored = restorePlaceholders(
            result.translation,
            block.protectedTokens ?? [],
          );
          if (restored.missingTokens.length > 0) {
            lastPartial.set(item.id, {
              text: restored.text,
              missing: restored.missingTokens,
            });
            next.push(item);
            continue;
          }
          lastPartial.delete(item.id);
          failureKind.delete(item.id);
          succeed(item.id, restored.text);
        }
        remaining = next;
        if (remaining.length === 0) {
          progress.onUsage?.(translator.usage());
          return;
        }
        if (attempt < maxAttempts) {
          await sleepWithAbort(retryDelayMs, signal);
        }
      } else {
        const next: BatchItem[] = [];
        for (const item of remaining) {
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
          try {
            const single = await translator.translateBatch([item], signal);
            const block = byId.get(item.id);
            if (!block) continue;
            const result = findResultForId(single, item.id);
            if (!result || result.translation.trim() === "") {
              failureKind.set(item.id, "missing");
              next.push(item);
              continue;
            }
            const restored = restorePlaceholders(
              result.translation,
              block.protectedTokens ?? [],
            );
            if (restored.missingTokens.length > 0) {
              lastPartial.set(item.id, {
                text: restored.text,
                missing: restored.missingTokens,
              });
              next.push(item);
              continue;
            }
            lastPartial.delete(item.id);
            failureKind.delete(item.id);
            succeed(item.id, restored.text);
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            lastError = err;
            failureKind.set(item.id, "error");
            next.push(item);
          }
        }
        remaining = next;
        if (remaining.length === 0) {
          progress.onUsage?.(translator.usage());
          return;
        }
        if (attempt < maxAttempts) {
          await sleepWithAbort(retryDelayMs, signal);
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      if (signal.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      lastError = err;
      for (const item of remaining) {
        if (!lastPartial.has(item.id)) failureKind.set(item.id, "error");
      }
      if (attempt < maxAttempts) {
        await sleepWithAbort(retryDelayMs, signal);
      }
    }
  }
  void lastError;
  for (const item of remaining) {
    const block = byId.get(item.id);
    if (!block) continue;
    const partial = lastPartial.get(item.id);
    if (partial) {
      block.translation = partial.missing.length > 0
        ? `${partial.text} ${partial.missing.join(" ")}`.trim()
        : partial.text;
      block.status = "translated";
      block.warnings = [
        `プレースホルダが欠落したため文末に補完: ${partial.missing.join(", ")}`,
      ];
      progress.onBlockDone?.(item.id, true);
      continue;
    }
    block.status = "failed";
    block.warnings = [
      failureKind.get(item.id) === "error"
        ? "翻訳に失敗したため原文を保持しました"
        : "翻訳応答に項目が含まれず原文を保持しました",
    ];
    progress.onBlockDone?.(item.id, false);
  }
  progress.onUsage?.(translator.usage());
}
