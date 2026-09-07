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

/** 全角数字1文字を ASCII 数字に変換する。数字以外は null を返す。 */
function toAsciiDigit(ch: string): string | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if (cp >= 0xFF10 && cp <= 0xFF19) {
    return String.fromCharCode(cp - 0xFF10 + 0x30);
  }
  if (ch >= "0" && ch <= "9") return ch;
  return null;
}

/** プレースホルダ番号文字列(全角・先行ゼロ許容)を数値化する。 */
function parsePlaceholderNumber(raw: string): number | null {
  let ascii = "";
  for (const ch of raw) {
    const d = toAsciiDigit(ch);
    if (d === null) return null;
    ascii += d;
  }
  if (ascii === "") return null;
  const n = Number.parseInt(ascii, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function restorePlaceholders(
  text: string,
  tokens: string[],
): RestoreResult {
  let out = text;
  const used = new Set<number>();
  // LLM が崩しがちな表記([[M0]] → [M0] / 全角 / 前後の引用符・バッククォート等)を
  // 許容する。二重括弧を先に処理し、残った単括弧を拾う。
  const doubleRe =
    /(?:[`'"*_~]+\s*)?(?:\[\s*\[|\uFF3B\s*\uFF3B|【)\s*[Mm\uFF2D\uFF4D]\s*([0-9\uFF10-\uFF19]+)\s*(?:\]\s*\]|\uFF3D\s*\uFF3D|】)(?:\s*[`'"*_~]+)?/g;
  out = out.replace(doubleRe, (_m, numStr: string) => {
    const n = parsePlaceholderNumber(numStr);
    if (n !== null && n >= 0 && n < tokens.length && !used.has(n)) {
      used.add(n);
      return tokens[n];
    }
    return "";
  });
  const singleRe =
    /(?:[`'"*_~]+\s*)?(?:\[|\uFF3B|【)\s*[Mm\uFF2D\uFF4D]\s*([0-9\uFF10-\uFF19]+)\s*(?:\]|\uFF3D|】)(?:\s*[`'"*_~]+)?/g;
  out = out.replace(singleRe, (_m, numStr: string) => {
    const n = parsePlaceholderNumber(numStr);
    if (n !== null && n >= 0 && n < tokens.length && !used.has(n)) {
      used.add(n);
      return tokens[n];
    }
    return "";
  });
  const missing: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!used.has(i)) missing.push(tokens[i]);
  }
  return { text: out.replace(/\s+/g, " ").trim(), missingTokens: missing };
}

const MATH_OPERATOR_RE = /[=≈≡≪≫≤≥≠∈∉∋⊂⊃⊆⊇∪∩∑∏∫√∂∇←→↔⇐⇒∝∀∃∅ℝℕℤ±∓×÷⊙⊕]/;

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
