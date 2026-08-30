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
const CELL_GAP_RATIO = 1;
const CELL_GAP_MIN_PT = 8;

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
    bold: isBoldFont(item.fontName),
  };
}

/** フォント名からの太字判定。 */
function isBoldFont(fontName: string): boolean {
  return /bold|black|heavy/i.test(fontName);
}

/** 文字数で重み付けした中央値。ドロップキャップや上付き文字を代表値にしない。 */
function representativeFontSize(items: TextItemBox[]): number {
  const weighted = [...items].sort((a, b) => a.fontSize - b.fontSize);
  const total = weighted.reduce(
    (sum, item) => sum + Math.max(1, item.str.trim().length),
    0,
  );
  let seen = 0;
  for (const item of weighted) {
    seen += Math.max(1, item.str.trim().length);
    if (seen >= total / 2) return item.fontSize;
  }
  return weighted.at(-1)?.fontSize ?? 10;
}

/** 行の代表ベースライン: 代表フォントサイズに近い主テキストから採用する。 */
function dominantBaseline(items: TextItemBox[]): number {
  const representative = representativeFontSize(items);
  const main = items.find((item) =>
    Math.abs(item.fontSize - representative) <= representative * 0.2
  );
  return (main ?? items[0]).y;
}

/** テキスト項目群から1行の LineBox を組み立てる(セル行は cells を保持する)。 */
function buildLineBox(items: TextItemBox[], cells?: LineBox[]): LineBox {
  let text = "";
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
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
    if (isBoldFont(it.fontName)) boldWeight++;
  }
  return {
    x0,
    y0,
    x1,
    y1,
    baselineY: dominantBaseline(items),
    text: normalizeLineText(text),
    fontSize: representativeFontSize(items),
    bold: boldWeight * 2 >= items.length && boldWeight > 0,
    cells,
  };
}

function assembleLine(items: TextItemBox[]): LineBox {
  // 行内の大きい余白(既定 1em / 8pt 以上)でセル(著者グリッド・表・数式)に分割する。
  // セルは単独ブロック扱いにし、段落統合でグリッドが崩れるのを防ぐ。
  const cells: LineBox[] = [];
  let cellStart = 0;
  const closeCell = (end: number) => {
    const cellItems = items.slice(cellStart, end);
    if (cellItems.length === 0) return;
    cells.push(buildLineBox(cellItems));
  };
  for (let i = 0; i < items.length; i++) {
    if (i === 0) continue;
    const prev = items[i - 1];
    const it = items[i];
    const gap = it.x - (prev.x + prev.width);
    if (
      gap >= Math.max(prev.fontSize * CELL_GAP_RATIO, CELL_GAP_MIN_PT) &&
      prev.str.trim() !== "" && it.str.trim() !== ""
    ) {
      closeCell(i);
      cellStart = i;
    }
  }
  closeCell(items.length);
  const line = buildLineBox(items);
  return cells.length > 1 ? { ...line, cells } : line;
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
  // ヘッダー、フッター、タイトルは段をまたぐため、全行の bbox の和集合から
  // 空白を探すと本文の細い段間まで埋まってしまう。段幅に収まる行だけを使い、
  // 各 x 座標を横切る行が少なく、左右に十分な行がある位置を段境界とする。
  const columnFragments = lines.flatMap((line) =>
    line.cells && line.cells.length > 1 ? line.cells : [line]
  );
  const candidates = columnFragments.filter((line) => {
    const width = line.x1 - line.x0;
    return width >= pageWidth * 0.08 && width <= pageWidth * 0.62;
  });
  const minSideLines = Math.max(3, Math.floor(candidates.length * 0.15));
  const maxCrossingLines = Math.max(1, Math.floor(candidates.length * 0.12));
  let best:
    | { x: number; crossing: number; imbalance: number; centerDistance: number }
    | undefined;
  const from = Math.floor(pageWidth * 0.25);
  const to = Math.ceil(pageWidth * 0.75);
  for (let x = from; x <= to; x++) {
    let left = 0;
    let right = 0;
    let crossing = 0;
    for (const line of candidates) {
      if (line.x1 <= x) left++;
      else if (line.x0 >= x) right++;
      else crossing++;
    }
    if (
      left < minSideLines || right < minSideLines ||
      crossing > maxCrossingLines
    ) continue;
    const candidate = {
      x,
      crossing,
      imbalance: Math.abs(left - right),
      centerDistance: Math.abs(x - pageWidth / 2),
    };
    if (
      !best || candidate.crossing < best.crossing ||
      (candidate.crossing === best.crossing &&
        candidate.imbalance < best.imbalance) ||
      (candidate.crossing === best.crossing &&
        candidate.imbalance === best.imbalance &&
        candidate.centerDistance < best.centerDistance)
    ) {
      best = candidate;
    }
  }
  if (!best) return [{ index: 0, x0: 0, x1: pageWidth }];
  return [
    { index: 0, x0: 0, x1: best.x },
    { index: 1, x0: best.x, x1: pageWidth },
  ];
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
    const sizeOk = Math.min(prev.fontSize, line.fontSize) / fs > 0.72;
    // 分数・数式の破片(非常に小さいフォントの短い断片)を段落に混入させない
    const prevIsDebris = prev.fontSize < line.fontSize * 0.8 &&
      prev.text.length <= 4;
    const lineIsDebris = line.fontSize < prev.fontSize * 0.8 &&
      line.text.length <= 4;
    // 通常本文の字下げ、および参考文献のぶら下げインデントを段落境界にする。
    const prevWidth = prev.x1 - prev.x0;
    const lineWidth = line.x1 - line.x0;
    const centerDelta = Math.abs(
      (prev.x0 + prev.x1) / 2 - (line.x0 + line.x1) / 2,
    );
    const centeredContinuation = centerDelta < Math.max(prevWidth, lineWidth) *
        0.05;
    const indentStartsParagraph = !centeredContinuation &&
      line.x0 - prev.x0 > fs * 0.65;
    const hangingEntryStarts = current.length >= 2 &&
      prev.x0 - line.x0 > fs * 0.65;
    const centeredHeadingBeforeBody = prevWidth < lineWidth * 0.6 &&
      line.x0 < prev.x0 - fs * 3;
    if (
      baselineDelta > 0 &&
      baselineDelta <= fs * 1.85 &&
      overlap > narrower * 0.25 &&
      sizeOk &&
      !prevIsDebris &&
      !lineIsDebris &&
      !indentStartsParagraph &&
      !hangingEntryStarts &&
      !centeredHeadingBeforeBody
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
    // 2行にまたがるドロップキャップは抽出順が「IRTUAL...」「Vin...」に
    // なり得る。大きな字形を含む次行の先頭1文字を前行へ戻す。
    if (
      line.y1 - line.y0 > line.fontSize * 2 &&
      /^[A-Z][a-z]/.test(line.text) &&
      /^[A-Z]{2,}\b/.test(text)
    ) {
      text = line.text[0] + text + " " + line.text.slice(1);
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
  const fullCount =
    group.filter((l) =>
      (l.x0 - minX0) <= width * 0.015 && (maxX1 - l.x1) <= width * 0.015
    ).length;
  if (fullCount / group.length >= 0.6) return false;
  const centers = group.map((l) => (l.x0 + l.x1) / 2);
  const mean = centers.reduce((a, b) => a + b, 0) / centers.length;
  const widths = group.map((l) => l.x1 - l.x0);
  const maxWidth = Math.max(...widths);
  return centers.every((c) => Math.abs(c - mean) < maxWidth * 0.06 + 2);
}

function makeBlock(
  group: LineBox[],
  page: ExtractedPage,
  medianFs: number,
  columnIndex: number,
  id: string,
): Block {
  const fontSize = Math.round(
    (group.reduce((a, l) => a + l.fontSize, 0) / group.length) * 10,
  ) / 10;
  return {
    id,
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
    kind: group.every((line) => line.bold) || fontSize > medianFs * 1.18
      ? "heading"
      : "body",
  };
}

export function analyzePage(page: ExtractedPage): PageLayout {
  const lines = buildLines(page.items);
  const columns = detectColumns(lines, page.width);
  const blocks: Block[] = [];
  const byColumn = new Map<number, LineBox[]>();
  const gridRows = new Map<number, LineBox[]>();
  for (const col of columns) {
    byColumn.set(col.index, []);
    gridRows.set(col.index, []);
  }
  for (const line of lines) {
    if (line.cells && line.cells.length > 1) {
      const placed = line.cells.map((cell) => {
        const mid = (cell.x0 + cell.x1) / 2;
        const region = columns.find((r) => mid >= r.x0 && mid <= r.x1) ??
          columns[columns.length - 1];
        return { cell, region };
      });
      const occupiedColumns = new Set(placed.map(({ region }) => region.index));
      if (occupiedColumns.size > 1) {
        // 同じベースラインに並んだ左右段の本文。表ではないので、それぞれの
        // 段の通常行へ戻し、前後の行と段落統合する。
        for (const { cell, region } of placed) {
          byColumn.get(region.index)?.push(cell);
        }
      } else {
        // 同一段内の著者グリッド・表などはセル単位の独立ブロックにする。
        const colIndex = placed[0].region.index;
        gridRows.get(colIndex)?.push(line);
      }
      continue;
    }
    const mid = (line.x0 + line.x1) / 2;
    const region = columns.find((r) => mid >= r.x0 && mid <= r.x1) ??
      columns[columns.length - 1];
    byColumn.get(region.index)?.push(line);
  }
  const fontSizes = lines.map((l) => l.fontSize).sort((a, b) => a - b);
  const medianFs = fontSizes[Math.floor(fontSizes.length / 2)] ?? 10;
  // ブロックIDはページ番号+連番の決定的な値にする(sidecar JSON の再現性・
  // テストの順序非依存性のため。モジュールレベルのカウンタは使わない)。
  let seq = 0;
  const nextId = () => `p${page.pageNumber}-${seq++}`;
  for (const [colIndex, columnLines] of byColumn) {
    for (const group of groupParagraphs(columnLines, colIndex)) {
      const text = mergeLineTexts(group);
      if (text === "") continue;
      blocks.push(makeBlock(group, page, medianFs, colIndex, nextId()));
    }
    // セル分割された行(著者グリッド・表など)は行内の各セルを独立ブロックにする。
    // 縦方向の段落統合を行うとグリッドが1文に連結されて崩れるため。
    for (const line of gridRows.get(colIndex) ?? []) {
      // 行全体が数式 look の場合(例: Attention(Q,K,V) = softmax(...) (1))は
      // セル単位で翻訳すると数式が崩れるため、全セルを原文保持にする。
      const formulaLine = looksLikeFormula(line.text);
      for (const cell of line.cells ?? []) {
        if (cell.text === "") continue;
        const block = makeBlock([cell], page, medianFs, colIndex, nextId());
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
