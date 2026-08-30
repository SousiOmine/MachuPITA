import type { Block } from "./types.ts";

const LETTER_RE =
  /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

export function isTranslatable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  if (!LETTER_RE.test(trimmed)) return false;
  const compact = trimmed.replace(/\s+/g, "");
  let letters = 0;
  for (const ch of compact) {
    if (LETTER_RE.test(ch)) letters++;
  }
  if (letters / compact.length < 0.35) return false;
  if (
    /^(https?:\/\/|www\.)\S+$|^[\w.+-]+@[\w-]+\.[\w.]+$|^10\.\d{4}\//i.test(
      trimmed,
    )
  ) {
    return false;
  }
  return true;
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)"']+/gi,
  /\bwww\.[^\s)"']+/gi,
  /\b10\.\d{4,9}\/\S+/g,
  /[\w.+-]+@[\w-]+\.[\w.]+/g,
  /\[\d+(?:[,\s\u2013\u2014-]+\d+)*\]/g,
  /\(\s*[A-Z][\w'\u2019-]+(?:\s+(?:et al\.?|and|&)\s+[A-Z]?[\w'\u2019-]*)*,?\s*\d{4}[a-z]?\s*(?:;\s*[A-Z][\w'\u2019-]+,?\s*\d{4}[a-z]?\s*)*\)/g,
  /\$[^$\n]{1,120}\$/g,
  /\\\((?:[^\\]|\\.){1,160}?\\\)/g,
];

export interface ProtectionResult {
  text: string;
  tokens: string[];
}

export function protectPlaceholders(text: string): ProtectionResult {
  const found: string[] = [];
  let out = text;
  for (const pattern of PLACEHOLDER_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const id = `[[M${found.length}]]`;
      found.push(match);
      return ` ${id} `;
    });
  }
  return { text: out.replace(/\s+/g, " ").trim(), tokens: found };
}

export interface RestoreResult {
  text: string;
  missingTokens: string[];
}

export function restorePlaceholders(
  text: string,
  tokens: string[],
): RestoreResult {
  let out = text;
  const missing: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const re = new RegExp(`\\[\\[\\s*M${i}\\s*\\]\\]`);
    if (re.test(out)) {
      out = out.replace(re, tokens[i]);
    } else {
      missing.push(tokens[i]);
    }
  }
  const stray = out.match(/\[\[\s*M\d+\s*\]\]/g);
  for (const s of stray ?? []) {
    out = out.replace(s, "");
  }
  return { text: out.replace(/\s+/g, " ").trim(), missingTokens: missing };
}

const MATH_OPERATOR_RE =
  /[=≈≡≪≫≤≥≠∈∉∋⊂⊃⊆⊇∪∩∑∏∫√∂∇←→↔⇐⇒∝∀∃∅ℝℕℤ±∓×÷⊙⊕]/;

/**
 * 数式とみなせるかどうか。
 * 数学演算子を含み、文としての終止符(ピリオド・句点など)を伴わない短いテキスト
 * (例: "Attention(Q, K, V) = softmax(QK^T / √dk) V (1)")は翻訳せず原文を保持する。
 */
export function looksLikeFormula(text: string): boolean {
  const t = text.trim();
  // 分数・数式の断片(例: "QKT dk", "1 dk"): 母音を含まない短い記号片は数式とみなす
  if (
    t.length <= 8 && /^[A-Za-z0-9\s^_]+$/.test(t) &&
    !/[aeiouAEIOU]/.test(t)
  ) return true;
  if (!MATH_OPERATOR_RE.test(t)) return false;
  if (t.length > 300) return false;
  // 文末の終止符、文中の文境界(「. + 大文字」)、CJKの句読点があれば本文とみなす
  if (/[.!?。！？]["'」』）)]*\s*$/.test(t)) return false;
  if (/[。！？]/.test(t)) return false;
  if (/\.\s+[A-Z\u00C0-\u024F]/.test(t)) return false;
  return true;
}

export function classifyBlocks(blocks: Block[]): void {
  for (const block of blocks) {
    if (
      !isTranslatable(block.originalText) ||
      looksLikeFormula(block.originalText)
    ) {
      block.status = "skipped";
      block.kind = "nontranslatable";
    }
  }
}
