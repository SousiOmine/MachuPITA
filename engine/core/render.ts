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

let FONT_DIR = join(PROJECT_ROOT, "assets", "fonts");

export function setFontDir(dir: string): void {
  FONT_DIR = dir;
}

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

interface EmbeddedFonts {
  latinRegular: Awaited<ReturnType<PDFDocument["embedFont"]>>;
  latinBold: Awaited<ReturnType<PDFDocument["embedFont"]>>;
  cjkRegular: Awaited<ReturnType<PDFDocument["embedFont"]>>;
  cjkBold: Awaited<ReturnType<PDFDocument["embedFont"]>>;
}

async function embedFonts(doc: PDFDocument): Promise<EmbeddedFonts> {
  const fontkit = ((fontkitModule as Record<string, unknown>).default ??
    fontkitModule) as unknown;
  doc.registerFontkit(fontkit as never);
  const embedOpts = { subset: true };
  const [latinRegular, latinBold, cjkRegular, cjkBold] = await Promise.all([
    doc.embedFont(await loadFontBytes(LATIN_FONTS.regular), embedOpts),
    doc.embedFont(await loadFontBytes(LATIN_FONTS.bold), embedOpts),
    doc.embedFont(await loadFontBytes(CJK_FONTS.regular), embedOpts),
    doc.embedFont(await loadFontBytes(CJK_FONTS.bold), embedOpts),
  ]);
  return { latinRegular, latinBold, cjkRegular, cjkBold };
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
      } else {
        lines.push(current.trimEnd());
        current = token;
      }
    }
    if (current !== "") lines.push(current.trimEnd());
  }
  return lines;
}

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
) {
  if (hasCJK(text)) return bold ? fonts.cjkBold : fonts.cjkRegular;
  return bold ? fonts.latinBold : fonts.latinRegular;
}

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

  let fontSize = Math.max(4, block.fontSize);
  const minSize = Math.max(3, block.fontSize * options.minFontScale);
  const lineHeightFactor = 1.22;
  let lines: string[] = [];
  const chosenFont = pickFont(translation, block.bold, fonts);
  while (true) {
    lines = wrapText(translation, chosenFont, boxW, fontSize);
    const totalH = lines.length * fontSize * lineHeightFactor;
    if (totalH <= boxH * 1.12 || fontSize <= minSize) break;
    fontSize = Math.max(minSize, fontSize * 0.92);
  }

  const lineHeight = fontSize * lineHeightFactor;
  const totalHeight = lines.length * lineHeight;
  let topY = block.y1;
  if (totalHeight < boxH) {
    topY = block.y1 - (boxH - totalHeight) / 2;
  }
  const baselineFirst = topY - fontSize;

  const textLines = lines.join("\n");
  const common = {
    x: block.x0,
    y: baselineFirst,
    size: fontSize,
    font: chosenFont,
    lineHeight,
    color: rgb(0, 0, 0),
  };
  if (block.centered) {
    let y = baselineFirst;
    for (const line of lines) {
      const w = chosenFont.widthOfTextAtSize(line, fontSize);
      page.drawText(line, { ...common, y, x: block.x0 + (boxW - w) / 2 });
      y -= lineHeight;
    }
  } else {
    page.drawText(textLines, common);
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
