import { PDFDocument, rgb } from "@cantoo/pdf-lib";
import * as fontkitModule from "fontkit";
import { join } from "@std/path";
import { PROJECT_ROOT } from "../settings.ts";
import type { Block, PageLayout } from "./types.ts";

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
    for (const block of layout.blocks) {
      if (block.status !== "translated" || !block.translation) continue;
      drawBlock(page, block, block.translation, fonts, mask, options);
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

function drawBlock(
  page: ReturnType<PDFDocument["getPage"]>,
  block: Block,
  translation: string,
  fonts: EmbeddedFonts,
  mask: { r: number; g: number; b: number },
  options: RenderOptions,
): void {
  const boxW = block.x1 - block.x0;
  const boxH = block.y1 - block.y0;
  if (boxW <= 1 || boxH <= 1) return;
  page.drawRectangle({
    x: block.x0 - 0.5,
    y: block.y0 - 0.5,
    width: boxW + 1,
    height: boxH + 1,
    color: rgb(mask.r, mask.g, mask.b),
  });

  const text = substituteChars(translation);
  const { primary, fallback } = pickFont(text, block.bold, fonts);

  let fontSize = Math.max(4, block.fontSize);
  const minSize = Math.max(3, block.fontSize * options.minFontScale);
  let lines: string[] = [];
  // 幅に少し逃しを作り、1文字だけ折れる(例: タイトル末尾の「ド」)のを防ぐ
  const wrapWidth = boxW * 1.03;
  while (true) {
    lines = wrapText(text, primary.pdf, wrapWidth, fontSize);
    const totalH = lines.length * fontSize * LINE_HEIGHT_FACTOR;
    // ボックスからのはみ出しは隣接ブロックとの重複の原因になるため厳密に収める
    if (totalH <= boxH || fontSize <= minSize) break;
    fontSize = Math.max(minSize, fontSize * 0.92);
  }

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
        color: rgb(0, 0, 0),
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
