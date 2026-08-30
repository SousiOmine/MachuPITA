import type { Block } from "./types.ts";

const LETTER_RE =
  /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

export function isTranslatable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
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

export function classifyBlocks(blocks: Block[]): void {
  for (const block of blocks) {
    if (!isTranslatable(block.originalText)) {
      block.status = "skipped";
      block.kind = "nontranslatable";
    }
  }
}
