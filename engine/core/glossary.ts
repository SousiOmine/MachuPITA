import type { Block } from "./types.ts";

/** 用語集の1エントリ。target === source は「英語のまま保持」を意味する。 */
export interface GlossaryEntry {
  source: string;
  target: string;
}

/** 用語抽出1リクエストに渡す原文の文字数予算。 */
export const GLOSSARY_CHUNK_CHARS = 12000;
/** 用語抽出に使う原文の合計上限。超過時は文書全体から間引いて採す。 */
export const GLOSSARY_TOTAL_CHARS = 48000;

export function buildGlossarySystemPrompt(targetLanguage: string): string {
  return [
    `You are building a translation glossary for an academic paper that will be translated into ${targetLanguage}.`,
    "The user message contains a JSON array of text segments sampled from the paper.",
    "Hard rules:",
    '1. Reply with ONLY a JSON array of objects shaped {"source": string, "target": string}. No markdown fences, no commentary.',
    "2. Extract domain-specific technical terms, method names, coined terms, and named entities that appear in the text and need a consistent rendering.",
    "3. Common words, general vocabulary, and citations must not appear in the list.",
    `4. "target" is the canonical rendering in ${targetLanguage}. If no established translation exists (coined term, product name, proper noun), set "target" to the exact original English string to keep it untranslated.`,
    "5. Do not invent translations. Prefer keeping the English string over guessing.",
    "6. Merge duplicate terms into one entry. Maximum 120 entries.",
  ].join("\n");
}

export function parseGlossaryResponse(raw: string): GlossaryEntry[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    throw new Error("glossary response is not a JSON array");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    throw new Error(`invalid JSON in glossary response: ${String(err)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("glossary response is not a JSON array");
  }
  const entries: GlossaryEntry[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const source = String((entry as Record<string, unknown>).source ?? "").trim();
    const target = String((entry as Record<string, unknown>).target ?? "").trim();
    if (source.length < 2 || target.length < 1) continue;
    entries.push({ source, target });
  }
  return entries;
}

/** エントリを source の大文字小文字を無視して統合する(後勝ち)。 */
export function mergeGlossary(parts: GlossaryEntry[][]): GlossaryEntry[] {
  const byKey = new Map<string, GlossaryEntry>();
  for (const part of parts) {
    for (const entry of part) {
      byKey.set(entry.source.toLowerCase(), entry);
    }
  }
  return [...byKey.values()];
}

export function formatGlossary(entries: GlossaryEntry[]): string {
  return entries.map((e) => `- ${e.source} => ${e.target}`).join("\n");
}

/** 用語集をシステムプロンプト末尾に追加する。空なら元のまま。 */
export function appendGlossary(
  basePrompt: string,
  entries: GlossaryEntry[],
): string {
  if (entries.length === 0) return basePrompt;
  return [
    basePrompt,
    "",
    "Glossary (MANDATORY). These terms appear throughout the document:",
    "GL1. If a term appears in the glossary below, you MUST render it exactly as its \"target\" everywhere it appears, in every item.",
    "GL2. If a term's target equals its source (an English string), keep it in English; never translate it.",
    "",
    formatGlossary(entries),
  ].join("\n");
}

export interface GlossaryCall {
  (system: string, user: string, signal: AbortSignal): Promise<string>;
}

/** 原文群をチャンク化してLLMに用語抽出を依頼し、結果を統合する。 */
export async function extractGlossary(
  call: GlossaryCall,
  texts: string[],
  system: string,
  signal: AbortSignal,
): Promise<GlossaryEntry[]> {
  const sampled = sampleTexts(texts, GLOSSARY_TOTAL_CHARS);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const text of sampled) {
    if (
      current.length > 0 &&
      currentChars + text.length > GLOSSARY_CHUNK_CHARS
    ) {
      chunks.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += text.length;
  }
  if (current.length) chunks.push(current);

  const parts: GlossaryEntry[][] = [];
  for (const chunk of chunks) {
    const payload = JSON.stringify(chunk);
    const raw = await call(system, payload, signal);
    parts.push(parseGlossaryResponse(raw));
  }
  return mergeGlossary(parts);
}

/** 合計文字数が上限を超える場合、文書全体から均等に間引いて採す。 */
export function sampleTexts(texts: string[], maxTotalChars: number): string[] {
  const total = texts.reduce((a, t) => a + t.length, 0);
  if (total <= maxTotalChars) return texts;
  const stride = Math.ceil(total / maxTotalChars);
  const out: string[] = [];
  let kept = 0;
  for (let i = 0; i < texts.length; i++) {
    if (i % stride !== 0) continue;
    if (kept + texts[i].length > maxTotalChars) break;
    out.push(texts[i]);
    kept += texts[i].length;
  }
  return out.length > 0 ? out : [texts[0].slice(0, maxTotalChars)];
}

/** 用語抽出に渡す原文を翻訳対象ブロックから集める。 */
export function collectGlossaryTexts(blocks: Block[]): string[] {
  return blocks
    .map((b) => b.originalText)
    .filter((t) => t.trim().length >= 8);
}
