import type {
  Block,
  ExtractedPage,
  LineBox,
  PageLayout,
  TextItemBox,
} from "./types.ts";
import { looksLikeFormula } from "./classify.ts";

const ROTATION_TOLERANCE = 0.12;

/** 項目と行でフォントサイズが大きく異なる場合(上付き・下付き・分数など) */
const MIXED_SIZE_RATIO = 1.25;
/** 混在サイズ時のベースライン一致許容(大きい側のフォントサイズ×この値) */
const MIXED_BASELINE_TOLERANCE = 0.6;
/** 同一サイズ時のベースライン一致許容(フォントサイズ×この値) */
const SAME_SIZE_TOLERANCE = 0.32;
/** bbox の上下マージン(描画フォントのアセント/ディセントを吸収する) */
const ASCENT = 0.95;
const DESCENT = 0.35;
/** 行内セル分割とみなす最小ギャップ(フォントサイズ倍率 / 絶対値pt) */
const CELL_GAP_RATIO = 1.2;
const CELL_GAP_MIN_PT = 6;

function baselineTolerance(itemFontSize: number, lineFontSize: number): number {
  const big = Math.max(itemFontSize, lineFontSize);
  const small = Math.min(itemFontSize, lineFontSize);
  if (big / small > MIXED_SIZE_RATIO) return big * MIXED_BASELINE_TOLERANCE;
  return Math.max(1.5, itemFontSize * SAME_SIZE_TOLERANCE);
}

export function buildLines(items: TextItemBox[]): LineBox[] {
  const usable = items.filter((it) => it.rotation < ROTATION_TOLERANCE);
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { line: LineBox; items: TextItemBox[] }[] = [];
  for (const item of sorted) {
    let best: { line: LineBox; items: TextItemBox[] } | undefined;
    let bestDelta = Infinity;
    for (const entry of lines) {
      const delta = Math.abs(entry.line.baselineY - item.y);
      if (delta > baselineTolerance(item.fontSize, entry.line.fontSize)) {
        continue;
      }
      if (delta < bestDelta) {
        best = entry;
        bestDelta = delta;
      }
    }
    if (best) {
      best.items.push(item);
    } else {
      lines.push({ line: emptyLine(item), items: [item] });
    }
  }
  const result: LineBox[] = [];
  for (const entry of lines) {
    entry.items.sort((a, b) => a.x - b.x);
    result.push(assembleLine(entry.items));
  }
  return result;
}

function emptyLine(item: TextItemBox): LineBox {
  return {
    x0: item.x,
    y0: item.y - item.fontSize * DESCENT,
    x1: item.x + item.width,
    y1: item.y + item.fontSize * ASCENT,
    baselineY: item.y,
    text: "",
    fontSize: item.fontSize,
    bold: /bold|black|heavy/i.test(item.fontName),
  };
}

/** 行の代表ベースライン: 最大フォントサイズの項目(主テキスト)の baseline を採用する */
function dominantBaseline(items: TextItemBox[]): number {
  const maxFs = Math.max(...items.map((i) => i.fontSize));
  const main = items.find((i) => i.fontSize >= maxFs * 0.8);
  return (main ?? items[0]).y;
}

function assembleLine(items: TextItemBox[]): LineBox {
  let text = "";
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let maxFs = 0;
  let boldWeight = 0;
  const cells: LineBox[] = [];
  let cellStart = 0;
  const closeCell = (end: number) => {
    const cellItems = items.slice(cellStart, end);
    if (cellItems.length === 0) return;
    cells.push(makeCell(cellItems));
  };
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      const gap = it.x - (prev.x + prev.width);
      if (gap > Math.max(1, prev.fontSize * 0.22)) text += " ";
      if (
        gap >= Math.max(prev.fontSize * CELL_GAP_RATIO, CELL_GAP_MIN_PT) &&
        prev.str.trim() !== "" && it.str.trim() !== ""
      ) {
        text += " ";
        closeCell(i);
        cellStart = i;
      }
    }
    text += it.str;
    x0 = Math.min(x0, it.x);
    x1 = Math.max(x1, it.x + it.width);
    y0 = Math.min(y0, it.y - it.fontSize * DESCENT);
    y1 = Math.max(y1, it.y + it.fontSize * ASCENT);
    maxFs = Math.max(maxFs, it.fontSize);
    if (/bold|black|heavy/i.test(it.fontName)) boldWeight++;
  }
  closeCell(items.length);
  const baselineY = dominantBaseline(items);
  return {
    x0,
    y0,
    x1,
    y1,
    baselineY,
    text: normalizeLineText(text),
    fontSize: maxFs,
    bold: boldWeight * 2 >= items.length && boldWeight > 0,
    cells: cells.length > 1 ? cells : undefined,
  };
}

function makeCell(items: TextItemBox[]): LineBox {
  let text = "";
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let maxFs = 0;
  let boldWeight = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      if (it.x - (prev.x + prev.width) > Math.max(1, prev.fontSize * 0.22)) {
        text += " ";
      }
    }
    text += it.str;
    x0 = Math.min(x0, it.x);
    x1 = Math.max(x1, it.x + it.width);
    y0 = Math.min(y0, it.y - it.fontSize * DESCENT);
    y1 = Math.max(y1, it.y + it.fontSize * ASCENT);
    maxFs = Math.max(maxFs, it.fontSize);
    if (/bold|black|heavy/i.test(it.fontName)) boldWeight++;
  }
  return {
    x0,
    y0,
    x1,
    y1,
    baselineY: dominantBaseline(items),
    text: normalizeLineText(text),
    fontSize: maxFs,
    bold: boldWeight * 2 >= items.length && boldWeight > 0,
  };
}

function normalizeLineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface ColumnRegion {
  index: number;
  x0: number;
  x1: number;
}

export function detectColumns(
  lines: LineBox[],
  pageWidth: number,
): ColumnRegion[] {
  if (lines.length < 6) return [{ index: 0, x0: 0, x1: pageWidth }];
  const bins = new Uint8Array(Math.ceil(pageWidth) + 2);
  for (const l of lines) {
    const from = Math.max(0, Math.floor(l.x0));
    const to = Math.min(bins.length - 1, Math.ceil(l.x1));
    for (let i = from; i <= to; i++) bins[i] = 1;
  }
  const gapMin = Math.max(14, pageWidth * 0.04);
  const gaps: { start: number; end: number }[] = [];
  let runStart = -1;
  for (let i = 0; i < bins.length; i++) {
    if (!bins[i]) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0) {
        if (i - runStart >= gapMin) gaps.push({ start: runStart, end: i });
        runStart = -1;
      }
    }
  }
  if (gaps.length === 0) return [{ index: 0, x0: 0, x1: pageWidth }];
  const minLinesPerColumn = Math.max(3, Math.floor(lines.length * 0.15));
  const regions: ColumnRegion[] = [];
  let cursor = 0;
  for (const g of gaps) {
    regions.push({
      index: regions.length,
      x0: cursor,
      x1: (g.start + g.end) / 2,
    });
    cursor = (g.start + g.end) / 2;
  }
  regions.push({ index: regions.length, x0: cursor, x1: pageWidth });
  const counts = new Array(regions.length).fill(0);
  for (const l of lines) {
    const mid = (l.x0 + l.x1) / 2;
    const region = regions.find((r) => mid >= r.x0 && mid <= r.x1) ??
      regions[regions.length - 1];
    counts[region.index]++;
  }
  const valid = regions.filter((_, i) => counts[i] >= minLinesPerColumn);
  return valid.length >= 2
    ? valid.map((r, i) => ({ ...r, index: i }))
    : [{ index: 0, x0: 0, x1: pageWidth }];
}

export function groupParagraphs(
  lines: LineBox[],
  _columnIndex: number,
): LineBox[][] {
  const ordered = [...lines].sort((a, b) =>
    b.baselineY - a.baselineY || a.x0 - b.x0
  );
  const groups: LineBox[][] = [];
  let current: LineBox[] = [];
  for (const line of ordered) {
    if (current.length === 0) {
      current = [line];
      continue;
    }
    const prev = current[current.length - 1];
    const fs = Math.max(prev.fontSize, line.fontSize);
    const baselineDelta = prev.baselineY - line.baselineY;
    const overlap = horizontalOverlap(prev, line);
    const narrower = Math.min(prev.x1 - prev.x0, line.x1 - line.x0);
    const sizeOk = line.fontSize / fs > 0.72 && fs / line.fontSize > 0.72;
    // 分数・数式の破片(非常に小さいフォントの短い断片)を段落に混入させない
    const prevIsDebris =
      prev.fontSize < line.fontSize * 0.8 && prev.text.length <= 4;
    const lineIsDebris =
      line.fontSize < prev.fontSize * 0.8 && line.text.length <= 4;
    if (
      baselineDelta > 0 &&
      baselineDelta <= fs * 1.85 &&
      overlap > narrower * 0.25 &&
      sizeOk &&
      !prevIsDebris &&
      !lineIsDebris
    ) {
      current.push(line);
    } else {
      groups.push(current);
      current = [line];
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

function horizontalOverlap(a: LineBox, b: LineBox): number {
  return Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
}

function mergeLineTexts(group: LineBox[]): string {
  let text = "";
  for (let i = 0; i < group.length; i++) {
    const line = group[i];
    if (i === 0) {
      text = line.text;
      continue;
    }
    const prevEndsWithHyphen = /[\u2010-\u2015-]$/.test(text);
    const nextStartsLower = /^[a-z]/.test(line.text);
    if (prevEndsWithHyphen && nextStartsLower) {
      text = text.replace(/[\u2010-\u2015-]$/, "") + line.text;
    } else {
      text += " " + line.text;
    }
  }
  return text.trim();
}

function isCentered(group: LineBox[]): boolean {
  if (group.length < 2) return false;
  // 両端揃え(ほとんどの行が左右両端に接する)の段落は中央揃えではない
  const minX0 = Math.min(...group.map((l) => l.x0));
  const maxX1 = Math.max(...group.map((l) => l.x1));
  const width = maxX1 - minX0;
  const fullCount = group.filter((l) =>
    (l.x0 - minX0) <= width * 0.015 && (maxX1 - l.x1) <= width * 0.015
  ).length;
  if (fullCount / group.length >= 0.6) return false;
  const centers = group.map((l) => (l.x0 + l.x1) / 2);
  const mean = centers.reduce((a, b) => a + b, 0) / centers.length;
  const widths = group.map((l) => l.x1 - l.x0);
  const maxWidth = Math.max(...widths);
  return centers.every((c) => Math.abs(c - mean) < maxWidth * 0.06 + 2);
}

let blockCounter = 0;

function makeBlock(
  group: LineBox[],
  page: ExtractedPage,
  medianFs: number,
  columnIndex: number,
): Block {
  blockCounter++;
  const fontSize = Math.round(
    (group.reduce((a, l) => a + l.fontSize, 0) / group.length) * 10,
  ) / 10;
  return {
    id: `b${blockCounter}`,
    page: page.pageNumber,
    columnIndex,
    x0: Math.min(...group.map((l) => l.x0)),
    y0: Math.min(...group.map((l) => l.y0)),
    x1: Math.max(...group.map((l) => l.x1)),
    y1: Math.max(...group.map((l) => l.y1)),
    baselineY: Math.max(...group.map((l) => l.baselineY)),
    // 数式分割で生じる ". " / " ." のような孤立句読点の破片を落とす
    originalText: mergeLineTexts(group)
      .replace(/^[.,;:]\s+/, "")
      .replace(/\s+[.,;:]$/, "")
      .trim(),
    text: "",
    status: "pending",
    fontSize,
    bold: group.every((l) => l.bold),
    centered: isCentered(group),
    kind: group.length === 1 &&
        (group[0].bold || group[0].fontSize > medianFs * 1.18)
      ? "heading"
      : "body",
  };
}

export function analyzePage(page: ExtractedPage): PageLayout {
  const lines = buildLines(page.items);
  const columns = detectColumns(lines, page.width);
  const blocks: Block[] = [];
  const byColumn = new Map<number, LineBox[]>();
  for (const col of columns) {
    byColumn.set(col.index, []);
  }
  for (const line of lines) {
    const mid = (line.x0 + line.x1) / 2;
    const region = columns.find((r) => mid >= r.x0 && mid <= r.x1) ??
      columns[columns.length - 1];
    byColumn.get(region.index)?.push(line);
  }
  const fontSizes = lines.map((l) => l.fontSize).sort((a, b) => a - b);
  const medianFs = fontSizes[Math.floor(fontSizes.length / 2)] ?? 10;
  for (const [colIndex, columnLines] of byColumn) {
    const plainLines = columnLines.filter(
      (l) => !l.cells || l.cells.length <= 1,
    );
    for (const group of groupParagraphs(plainLines, colIndex)) {
      const text = mergeLineTexts(group);
      if (text === "") continue;
      blocks.push(makeBlock(group, page, medianFs, colIndex));
    }
    // セル分割された行(著者グリッド・表など)は行内の各セルを独立ブロックにする。
    // 縦方向の段落統合を行うとグリッドが1文に連結されて崩れるため。
    for (const line of columnLines) {
      if (!line.cells || line.cells.length <= 1) continue;
      // 行全体が数式 look の場合(例: Attention(Q,K,V) = softmax(...) (1))は
      // セル単位で翻訳すると数式が崩れるため、全セルを原文保持にする。
      const formulaLine = looksLikeFormula(line.text);
      for (const cell of line.cells) {
        if (cell.text === "") continue;
        const block = makeBlock([cell], page, medianFs, colIndex);
        block.centered = false;
        if (formulaLine) {
          block.status = "skipped";
          block.kind = "nontranslatable";
        }
        blocks.push(block);
      }
    }
  }
  return {
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    blocks,
  };
}
