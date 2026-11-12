import { PDFDocument, rgb } from "@cantoo/pdf-lib";
import * as fontkitModule from "fontkit";
import { join } from "@std/path";
import { PROJECT_ROOT } from "../settings.ts";
import type { Block, PageLayout } from "./types.ts";
import { colorsClose } from "./visibility.ts";
import type { Rgb } from "./visibility.ts";

const LATIN_FONTS = {
  regular: "NotoSans-Regular.ttf",
  bold: "NotoSans-Bold.ttf",
};
const CJK_FONTS = {
  regular: "NotoSansJP-Regular.ttf",
  bold: "NotoSansJP-Bold.ttf",
};

const FONT_DIR = join(PROJECT_ROOT, "assets", "fonts");

function hasCJK(text: string): boolean {
  return /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u3000-\u303F\uFF00-\uFFEF]/
    .test(
      text,
    );
}

async function loadFontBytes(file: string): Promise<Uint8Array> {
  const path = join(FONT_DIR, file);
  try {
    return new Uint8Array(await Deno.readFile(path));
  } catch {
    throw new Error(
      `フォント ${file} が見つかりません。deno task setup:fonts を実行してください (${path})`,
    );
  }
}

type PdfFont = Awaited<ReturnType<PDFDocument["embedFont"]>>;
type KitFont = { hasGlyphForCodePoint: (cp: number) => boolean };

interface FontEntry {
  pdf: PdfFont;
  kit: KitFont;
}

interface EmbeddedFonts {
  latin: { regular: FontEntry; bold: FontEntry };
  cjk: { regular: FontEntry; bold: FontEntry };
}

async function embedFonts(doc: PDFDocument): Promise<EmbeddedFonts> {
  const fontkit = ((fontkitModule as Record<string, unknown>).default ??
    fontkitModule) as unknown as {
      openSync: (path: string) => KitFont;
    };
  const fk = fontkit as unknown;
  doc.registerFontkit(fk as never);
  const embedOpts = { subset: true };
  const [latinRegular, latinBold, cjkRegular, cjkBold] = await Promise.all([
    doc.embedFont(await loadFontBytes(LATIN_FONTS.regular), embedOpts),
    doc.embedFont(await loadFontBytes(LATIN_FONTS.bold), embedOpts),
    doc.embedFont(await loadFontBytes(CJK_FONTS.regular), embedOpts),
    doc.embedFont(await loadFontBytes(CJK_FONTS.bold), embedOpts),
  ]);
  const kitLatinRegular = fontkit.openSync(join(FONT_DIR, LATIN_FONTS.regular));
  const kitLatinBold = fontkit.openSync(join(FONT_DIR, LATIN_FONTS.bold));
  const kitCjkRegular = fontkit.openSync(join(FONT_DIR, CJK_FONTS.regular));
  const kitCjkBold = fontkit.openSync(join(FONT_DIR, CJK_FONTS.bold));
  return {
    latin: {
      regular: { pdf: latinRegular, kit: kitLatinRegular },
      bold: { pdf: latinBold, kit: kitLatinBold },
    },
    cjk: {
      regular: { pdf: cjkRegular, kit: kitCjkRegular },
      bold: { pdf: cjkBold, kit: kitCjkBold },
    },
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace("#", "");
  const v = m.length === 3 ? m.split("").map((c) => parseInt(c + c, 16)) : [
    parseInt(m.slice(0, 2), 16),
    parseInt(m.slice(2, 4), 16),
    parseInt(m.slice(4, 6), 16),
  ];
  return {
    r: (v[0] ?? 255) / 255,
    g: (v[1] ?? 255) / 255,
    b: (v[2] ?? 255) / 255,
  };
}

/** どちらのフォントにもグリフが存在しない文字の置換表 */
const CHAR_SUBSTITUTIONS = new Map<string, string>([
  ["\u2217", "*"], // ∗ ASTERISK OPERATOR
  ["\u2215", "/"], // ∕ DIVISION SLASH
  ["\u2216", "\\"], // ∖ SET MINUS
  ["\u2225", "||"], // ∥ PARALLEL TO
  ["\u2016", "||"], // ‖ DOUBLE VERTICAL LINE
]);

function substituteChars(text: string): string {
  let out = "";
  for (const ch of text) out += CHAR_SUBSTITUTIONS.get(ch) ?? ch;
  return out;
}

export function wrapText(
  text: string,
  font: { widthOfTextAtSize(t: string, s: number): number },
  maxWidth: number,
  fontSize: number,
): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split(/\n+/)) {
    if (rawLine === "") continue;
    let current = "";
    for (
      const token of rawLine.match(/[A-Za-z0-9'’\u2010-\u2015-]+|\s+|./gsu) ??
        []
    ) {
      if (/^\s+$/.test(token)) {
        if (current !== "") current += " ";
        continue;
      }
      const candidate = current === "" ? token : current + token;
      if (
        font.widthOfTextAtSize(candidate, fontSize) <= maxWidth ||
        current === ""
      ) {
        current = candidate;
      } else if (KINSOKU_NO_START.test(token)) {
        // 行頭に来せない句読点・閉じ括弧は前の行に引き込む(桁あふれ許容)
        current += token;
      } else {
        lines.push(current.trimEnd());
        current = token;
      }
    }
    if (current !== "") lines.push(current.trimEnd());
  }
  return lines;
}

/** 原文が箇条書きなら、訳文にも同じ記号を残す(LLMが落とすことがある)。 */
const BULLET_PREFIX_RE =
  /^([\u2022\u25cf\u25cb\u25e6\u25aa\u25ab\u25b8\u25b9\u25ba\u25b6\u25c6\u25c7\u25a0\u25a1\u2605\u2606\u203b\u30fb])/;

function preserveBullet(original: string, translated: string): string {
  const match = original.trimStart().match(BULLET_PREFIX_RE);
  if (!match) return translated;
  const marker = match[1];
  if (translated.trimStart().startsWith(marker)) return translated;
  return `${marker} ${translated.trimStart()}`;
}

/** 行頭に来せたくない文字(禁則処理) */
const KINSOKU_NO_START = /[\]、。,.:;!?！？・ー…‥°%‰)）〉》】」』〕”’]/;

export interface RenderOptions {
  maskColor: string;
  minFontScale: number;
}

export async function renderTranslatedPdf(
  sourceBytes: Uint8Array,
  pages: PageLayout[],
  options: RenderOptions,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(sourceBytes, {
    ignoreEncryption: true,
  });
  const fonts = await embedFonts(doc);
  const mask = hexToRgb(options.maskColor);

  for (const layout of pages) {
    if (layout.pageNumber > doc.getPageCount()) continue;
    const page = doc.getPage(layout.pageNumber - 1);
    const bottomLimits = computeBottomLimits(layout.blocks);
    for (const block of layout.blocks) {
      if (block.status !== "translated" || !block.translation) continue;
      drawBlock(
        page,
        block,
        preserveBullet(block.originalText, block.translation),
        fonts,
        mask,
        options,
        bottomLimits.get(block.id),
      );
    }
  }
  return new Uint8Array(await doc.save());
}

function pickFont(
  text: string,
  bold: boolean,
  fonts: EmbeddedFonts,
): { primary: FontEntry; fallback: FontEntry } {
  if (hasCJK(text)) {
    return {
      primary: bold ? fonts.cjk.bold : fonts.cjk.regular,
      fallback: bold ? fonts.latin.bold : fonts.latin.regular,
    };
  }
  return {
    primary: bold ? fonts.latin.bold : fonts.latin.regular,
    fallback: bold ? fonts.cjk.bold : fonts.cjk.regular,
  };
}

function resolveCharFont(
  ch: string,
  primary: FontEntry,
  fallback: FontEntry,
): FontEntry | undefined {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return undefined;
  if (primary.kit.hasGlyphForCodePoint(cp)) return primary;
  if (fallback.kit.hasGlyphForCodePoint(cp)) return fallback;
  return undefined;
}

/** 描画用ラン: 文字ごとにグリフを持つフォントへ割り当て、連続する同フォント文字をまとめる */
function buildRuns(
  text: string,
  primary: FontEntry,
  fallback: FontEntry,
): { text: string; font: PdfFont }[] {
  const runs: { text: string; font: PdfFont }[] = [];
  let currentFont: PdfFont | undefined;
  let current = "";
  const flush = () => {
    if (currentFont && current !== "") {
      runs.push({ text: current, font: currentFont });
    }
    current = "";
  };
  for (const ch of text) {
    const replaced = CHAR_SUBSTITUTIONS.get(ch) ?? ch;
    for (const c of replaced) {
      const entry = resolveCharFont(c, primary, fallback);
      // 両フォントにグリフがない文字は描画しない(豆腐になるより欠落させる)
      if (!entry) continue;
      if (currentFont && entry.pdf !== currentFont) flush();
      currentFont = entry.pdf;
      current += c;
    }
  }
  flush();
  return runs;
}

/** 翻訳テキストの行ピッチ(フォントサイズ倍率) */
const LINE_HEIGHT_FACTOR = 1.2;
/** ベースラインの初期オフセット(ブロック上端から・フォントサイズ倍率) */
const GLYPH_ASCENT = 0.85;

/** 背景に対して読みやすい文字色を決める(元色が取得できても同色なら反転)。 */
function resolveTextColor(color: Rgb | undefined, background: Rgb): Rgb {
  const luminance = 0.2126 * background.r + 0.7152 * background.g +
    0.0722 * background.b;
  const fallback: Rgb = luminance < 0.5
    ? { r: 1, g: 1, b: 1 }
    : { r: 0, g: 0, b: 0 };
  if (!color) return fallback;
  if (colorsClose(color, background, 0.12)) return fallback;
  return color;
}

/**
 * 各ブロックの下にある「次のブロックの上端+余白」を返す。訳文が1行に収まらず
 * 縮小が必要なとき、空いている行間にだけ描画領域を広げるために使う。
 */
function computeBottomLimits(blocks: Block[]): Map<string, number> {
  const limits = new Map<string, number>();
  for (const block of blocks) {
    if (block.status !== "translated") continue;
    let limit = Number.NEGATIVE_INFINITY;
    for (const other of blocks) {
      if (other.id === block.id) continue;
      if (other.y1 > block.y0 + 1) continue; // block より上(または同一)
      const overlap = Math.min(block.x1, other.x1) -
        Math.max(block.x0, other.x0);
      const narrower = Math.min(
        block.x1 - block.x0,
        other.x1 - other.x0,
      );
      if (narrower <= 0 || overlap < narrower * 0.5) continue;
      if (other.y1 > limit) limit = other.y1;
    }
    if (Number.isFinite(limit)) limits.set(block.id, limit + 2);
  }
  return limits;
}

function drawBlock(
  page: ReturnType<PDFDocument["getPage"]>,
  block: Block,
  translation: string,
  fonts: EmbeddedFonts,
  mask: { r: number; g: number; b: number },
  options: RenderOptions,
  maxBottom?: number,
): void {
  const boxW = block.x1 - block.x0;
  const originalH = block.y1 - block.y0;
  if (boxW <= 1 || originalH <= 1) return;
  // 元テキストの背後の塗り色で塗り直す(スライドの色帯上の白文字など)。
  const background: Rgb = block.backgroundColor ?? mask;
  const textColor = resolveTextColor(block.color, background);

  const text = substituteChars(translation);
  const { primary, fallback } = pickFont(text, block.bold, fonts);

  // ページ右端を超えないよう折り返し幅を抑える(3%の逃しは残す)
  const pageWidth = page.getWidth();
  const wrapWidth = Math.max(
    10,
    Math.min(boxW * 1.03, pageWidth - block.x0 - 2),
  );
  const minSize = Math.max(3, block.fontSize * options.minFontScale);

  const layoutAt = (height: number) => {
    let fontSize = Math.max(4, block.fontSize);
    let lines: string[] = [];
    while (true) {
      lines = wrapText(text, primary.pdf, wrapWidth, fontSize);
      const totalH = lines.length * fontSize * LINE_HEIGHT_FACTOR;
      // ボックスからのはみ出しは隣接ブロックとの重複の原因になるため厳密に収める
      if (totalH <= height || fontSize <= minSize) break;
      fontSize = Math.max(minSize, fontSize * 0.92);
    }
    return { lines, fontSize };
  };

  let boxH = originalH;
  let result = layoutAt(boxH);
  // 訳文が原文より長く、大きく縮小される場合は、下の空き行間へ少し広げる。
  // 色帯(タイトルバー等)の上では背景からはみ出すため広げない。
  const expandableBackground = !block.backgroundColor ||
    (block.backgroundColor.r >= 0.98 && block.backgroundColor.g >= 0.98 &&
      block.backgroundColor.b >= 0.98);
  if (
    maxBottom !== undefined && expandableBackground &&
    result.fontSize < block.fontSize * 0.8
  ) {
    const expandedH = Math.min(block.y1 - maxBottom, originalH * 1.8);
    if (expandedH > originalH * 1.15) {
      const expanded = layoutAt(expandedH);
      if (expanded.fontSize > result.fontSize) {
        boxH = expandedH;
        result = expanded;
      }
    }
  }
  const { lines, fontSize } = result;
  const boxY0 = block.y1 - boxH;
  page.drawRectangle({
    x: block.x0 - 0.5,
    y: boxY0 - 0.5,
    width: boxW + 1,
    height: boxH + 1,
    color: rgb(background.r, background.g, background.b),
  });

  const lineHeight = fontSize * LINE_HEIGHT_FACTOR;
  const totalHeight = lines.length * lineHeight;
  // 単一行ブロックは原文のベースラインに正確に描画する(隣接ブロックとの
  // 縦位置の食い違いをなくす)。複数行になる場合はボックス内で中央揃え。
  let firstBaseline: number | undefined;
  if (lines.length === 1 && block.baselineY !== undefined) {
    firstBaseline = block.baselineY;
  } else {
    let topY = block.y1;
    if (totalHeight < boxH) {
      topY = block.y1 - (boxH - totalHeight) / 2;
    }
    firstBaseline = topY - fontSize * GLYPH_ASCENT;
  }

  let baseline = firstBaseline;
  for (const lineText of lines) {
    const runs = buildRuns(lineText, primary, fallback);
    let x = block.x0;
    if (block.centered) {
      const w = runs.reduce(
        (a, r) => a + r.font.widthOfTextAtSize(r.text, fontSize),
        0,
      );
      x = block.x0 + Math.max(0, (boxW - w) / 2);
    }
    for (const run of runs) {
      page.drawText(run.text, {
        x,
        y: baseline,
        size: fontSize,
        font: run.font,
        color: rgb(textColor.r, textColor.g, textColor.b),
      });
      x += run.font.widthOfTextAtSize(run.text, fontSize);
    }
    baseline -= lineHeight;
  }
}

export async function buildDualPdf(
  originalBytes: Uint8Array,
  translatedBytes: Uint8Array,
): Promise<Uint8Array> {
  const originalDoc = await PDFDocument.load(originalBytes, {
    ignoreEncryption: true,
  });
  const translatedDoc = await PDFDocument.load(translatedBytes, {
    ignoreEncryption: true,
  });
  const out = await PDFDocument.create();
  const count = Math.min(
    originalDoc.getPageCount(),
    translatedDoc.getPageCount(),
  );
  for (let i = 0; i < count; i++) {
    const [origPage] = await out.copyPages(originalDoc, [i]);
    out.addPage(origPage);
    const [transPage] = await out.copyPages(translatedDoc, [i]);
    out.addPage(transPage);
  }
  return new Uint8Array(await out.save());
}
