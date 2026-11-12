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
  extractGlossary,
  formatGlossary,
  type GlossaryCall,
  type GlossaryEntry,
} from "./glossary.ts";

/** 翻訳実行の指定。段落は 1 リクエスト = 1 段落で送る。 */
export interface TranslateJobOptions {
  /** 同時に投げるリクエスト数 */
  concurrency: number;
  /** 翻訳先の言語(原文のまま返された応答の検出に使う) */
  targetLanguage?: string;
  /** 段落ごとの文脈(論文タイトル・節見出し)。訳語の一貫性に使う。 */
  contextFor?: (block: Block) => string | undefined;
}

export interface Translator {
  /** 1 段落を翻訳して訳文を返す。失敗時は例外を投げる。 */
  translate(
    text: string,
    signal: AbortSignal,
    context?: string,
  ): Promise<string>;
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

/**
 * システムプロンプトは翻訳者の役割定義だけに留める。
 * 翻訳対象・出力形式・用語集の指示は user ロール
 * (buildTranslationUserPrompt) 側で与える。
 */
export function buildSystemPrompt(): string {
  return "You are a professional translator of academic papers.";
}

/** 日本語ターゲット時のみ user プロンプトへ付与する文体ルール。 */
const JAPANESE_STYLE_RULES = [
  "Japanese style (MANDATORY):",
  "1. Write in 常体 (だ・である調): sentence-final predicates must be である / だ / する / した / される / された, etc.",
  "2. Never use 敬体 (です / ます / でした / ました), even mid-sentence.",
  "3. Keep the same style in every paragraph so the whole document is consistent.",
];

/** 用語集セクション。用語集がなければ空配列を返す。 */
function buildGlossarySection(entries: GlossaryEntry[]): string[] {
  if (entries.length === 0) return [];
  return [
    "Glossary (MANDATORY). These terms appear throughout the document:",
    'GL1. If a term appears in the glossary below, you MUST render it exactly as its "target" everywhere it appears.',
    "GL2. If a term's target equals its source (an English string), keep it in English; never translate it.",
    "",
    formatGlossary(entries),
    "",
  ];
}

/**
 * 1 段落分の翻訳を依頼する user プロンプトを組み立てる。
 * 原文は <target> タグ、訳文は <translated> タグに格納する形式で指示する。
 */
export function buildTranslationUserPrompt(
  text: string,
  targetLanguage: string,
  glossary: GlossaryEntry[] = [],
  context?: string,
): string {
  return [
    `Translate the text extracted from a PDF academic paper into ${targetLanguage}.`,
    "Write the translated text inside <translated></translated> tags and output nothing else.",
    "",
    "Output rules (MANDATORY):",
    "1. Do not add or omit content: no notes, greetings, or punctuation that is not in the source.",
    "2. Return a single plain-text string without line breaks.",
    "3. Preserve placeholders such as [[M0]] exactly as they appear; never translate, reorder, or drop them.",
    "4. Keep numbers, units, and proper nouns accurate.",
    "5. Use a formal academic register appropriate for scholarly publications.",
    "6. Render the same source term identically throughout the document; never give one term different translations in different passages.",
    "7. Coined terms, method names, product names, and proper nouns without an established translation must stay in English; never invent a translation for them.",
    "8. On the first occurrence of such a kept English term, you may append the English in parentheses after the translation, like 訳語 (Original Term); afterwards use the translation alone.",
    "9. Bibliographic entries (a reference list): translate the title of the work, but keep author names, journal/conference names, publisher names, page numbers, and years exactly as written in the source.",
    "10. Translate every sentence. Never return the source text unchanged just because it names people, organizations, or publications.",
    "",
    ...(isJapaneseTarget(targetLanguage) ? [...JAPANESE_STYLE_RULES, ""] : []),
    ...(context
      ? [
        "Document context (use only to disambiguate; do not translate or repeat it):",
        context,
        "",
      ]
      : []),
    ...buildGlossarySection(glossary),
    "The text to translate is stored inside the <target> tags below.",
    "",
    "<target>",
    text,
    "</target>",
  ].join("\n");
}

/** 応答中の <translated> ブロック。属性や閉じタグ前後の空白は許容する。 */
const TRANSLATED_BLOCK = /<translated\b[^>]*>([\s\S]*?)<\/translated\s*>/gi;

/**
 * 応答テキストから訳文を取り出す。
 * 前置きやマークダウン fences が混在していても最初の非空 <translated> ブロックを採用し、
 * ブロックがなければ例外を投げる(呼び出し側がリトライする)。
 */
export function parseTranslationResponse(raw: string): string {
  for (const match of raw.matchAll(TRANSLATED_BLOCK)) {
    const translation = match[1].trim();
    if (translation.length > 0) return translation;
  }
  throw new Error("response has no <translated> block");
}

export class PiTranslator implements Translator, GlossaryCapable {
  #models: Models;
  #model: Model<Api>;
  #targetLanguage: string;
  #glossary: GlossaryEntry[];
  #totals: TokenUsageTotals = {
    input: 0,
    output: 0,
    total: 0,
    costTotal: 0,
  };

  constructor(
    models: Models,
    model: Model<Api>,
    targetLanguage = "",
    glossary: GlossaryEntry[] = [],
  ) {
    this.#models = models;
    this.#model = model;
    this.#targetLanguage = targetLanguage;
    this.#glossary = glossary;
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

  async translate(
    text: string,
    signal: AbortSignal,
    context?: string,
  ): Promise<string> {
    const message = await this.#models.completeSimple(
      this.#model,
      {
        systemPrompt: buildSystemPrompt(),
        messages: [
          {
            role: "user",
            content: buildTranslationUserPrompt(
              text,
              this.#targetLanguage,
              this.#glossary,
              context,
            ),
            timestamp: Date.now(),
          },
        ],
      },
      {
        temperature: 0.2,
        maxTokens: Math.max(2048, text.length * 3),
        signal,
      },
    );
    this.#recordMessage(message);
    return parseTranslationResponse(this.#textOf(message));
  }

  /** 単発の補助リクエスト(用語集抽出など)を投げて本文テキストを返す。 */
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
      this.#targetLanguage,
      signal,
    );
  }

  withGlossary(entries: GlossaryEntry[]): Translator {
    return new PiTranslator(
      this.#models,
      this.#model,
      this.#targetLanguage,
      entries,
    );
  }
}

export class FauxEchoTranslator implements Translator {
  #totals: TokenUsageTotals = { input: 0, output: 0, total: 0, costTotal: 0 };

  async translate(
    text: string,
    _signal: AbortSignal,
    _context?: string,
  ): Promise<string> {
    await new Promise((r) => setTimeout(r, 30));
    this.#totals.input += Math.ceil(text.length / 4);
    this.#totals.output += Math.ceil(text.length / 5);
    this.#totals.total += Math.ceil(text.length / 4) +
      Math.ceil(text.length / 5);
    return `FAUX:${text}`;
  }

  usage(): TokenUsageTotals {
    return this.#totals;
  }
}

export interface TranslateProgress {
  onBlockDone?: (blockId: string, ok: boolean) => void;
  onUsage?: (usage: TokenUsageTotals) => void;
}

/** 1 段落あたりの最大試行回数。初回 1 回 + 最大 3 回リトライ。 */
export const TRANSLATE_MAX_ATTEMPTS = 4;
/** リトライ前に待機するミリ秒。 */
export const TRANSLATE_RETRY_DELAY_MS = 3000;

/**
 * 認証・権限エラー (HTTP 401/403) かどうか。
 * キーが拒否されている間は全段落が同じ理由で失敗するため、
 * リトライせずジョブ全体を止める判断に使う。
 */
export function isAuthError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 401 || status === 403) return true;
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /invalid[ _]api[ _]key|incorrect api key|unauthorized|authentication fail/i
    .test(message) ||
    /^\s*(401|403)\b/.test(message);
}

/** 認証エラーを利用者向けのメッセージに整える。元の詳細は括弧内に残す。 */
export function authErrorMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `APIキーが拒否されました。設定を確認してください (${detail})`;
}

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

/** 日本語らしい文字(かな・漢字)の数。 */
function countJapanese(text: string): number {
  return text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g)?.length ??
    0;
}

/**
 * 訳文が原文のまま返されている疑いがあるか(日本語ターゲットのみ)。
 * 英単語が十分にある段落なのに日本語がほとんど無い応答は、翻訳漏れとして
 * リトライさせる。見出し・固有名詞だけの短い段落は対象外。
 */
export function looksUntranslated(
  source: string,
  translation: string,
  targetLanguage?: string,
): boolean {
  if (!targetLanguage || !isJapaneseTarget(targetLanguage)) return false;
  // メールアドレス・数式・コード片は「原文のまま」が正しいので対象外
  if (/@/.test(source) || /[=<>≤≥≈≠√]/.test(source)) return false;
  const sourceJapanese = countJapanese(source);
  if (sourceJapanese / Math.max(1, source.length) > 0.2) return false;
  const words = source.match(/[A-Za-z]{3,}/g)?.length ?? 0;
  if (words < 4) return false;
  return countJapanese(translation) < 4;
}

/**
 * 翻訳対象ブロックを 1 段落 1 リクエストで翻訳する。
 * プレースホルダ欠落・空応答・例外はリトライし、最終的に失敗した段落は
 * 原文を保持して警告を残す(プレースホルダ欠落時は文末補完で情報落ちを防ぐ)。
 */
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

  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= pending.length) return;
      await translateBlock(
        pending[index],
        translator,
        signal,
        progress,
        maxAttempts,
        retryDelayMs,
        options,
      );
      progress.onUsage?.(translator.usage());
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(options.concurrency, pending.length)) },
    () => worker(),
  );
  await Promise.all(workers);
}

async function translateBlock(
  block: Block,
  translator: Translator,
  signal: AbortSignal,
  progress: TranslateProgress,
  maxAttempts: number,
  retryDelayMs: number,
  options: TranslateJobOptions,
): Promise<void> {
  const tokens = block.protectedTokens ?? [];
  const context = options.contextFor?.(block);
  // プレースホルダが欠落した訳文は、全試行後も回復しなければ文末補完して採用する。
  let partial: { text: string; missing: string[] } | undefined;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      const raw = await translator.translate(block.text, signal, context);
      const restored = restorePlaceholders(raw, tokens);
      if (restored.missingTokens.length === 0) {
        // 見出し・固有名詞は英語のまま残すことがあるため、本文だけを対象にする
        const echoed = block.kind === "body" &&
          looksUntranslated(block.text, restored.text, options.targetLanguage);
        if (echoed && attempt < maxAttempts) {
          lastError = new Error("untranslated response (source echoed)");
        } else {
          block.translation = restored.text;
          block.status = "translated";
          if (echoed) {
            block.warnings = [
              "原文のまま返されたため、そのまま出力しました(翻訳漏れの可能性)",
            ];
          }
          progress.onBlockDone?.(block.id, true);
          return;
        }
      } else {
        partial = { text: restored.text, missing: restored.missingTokens };
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") throw err;
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      // 認証エラーはリトライしても回復しない。全段落が同じ理由で失敗する前に
      // ジョブを止め、原因をそのまま利用者に見せる。
      if (isAuthError(err)) throw new Error(authErrorMessage(err));
      lastError = err;
    }
    if (attempt < maxAttempts) {
      await sleepWithAbort(retryDelayMs, signal);
    }
  }

  if (partial) {
    block.translation = `${partial.text} ${partial.missing.join(" ")}`.trim();
    block.status = "translated";
    block.warnings = [
      `プレースホルダが欠落したため文末に補完: ${partial.missing.join(", ")}`,
    ];
    progress.onBlockDone?.(block.id, true);
    return;
  }
  const reason = lastError instanceof Error ? lastError.message : "";
  block.status = "failed";
  block.warnings = [
    reason
      ? `翻訳に失敗したため原文を保持しました: ${reason}`
      : "翻訳に失敗したため原文を保持しました",
  ];
  progress.onBlockDone?.(block.id, false);
}
