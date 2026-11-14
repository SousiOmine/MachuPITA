import type {
  Block,
  ExtractedPage,
  LineBox,
  PageLayout,
  TextItemBox,
} from "./types.ts";
import type { Rgb } from "./visibility.ts";
import { looksLikeFormula } from "./classify.ts";

const ROTATION_TOLERANCE = 0.12;

/** 項目と行でフォントサイズが大きく異なる場合(上付き・下付き・分数など) */
const MIXED_SIZE_RATIO = 1.25;
/** 混在サイズ時のベースライン一致許容(大きい側のフォントサイズ×この値) */
const MIXED_BASELINE_TOLERANCE = 0.8;
/** 同一サイズ時のベースライン一致許容(フォントサイズ×この値) */
const SAME_SIZE_TOLERANCE = 0.32;
/** bbox の上下マージン(描画フォントのアセント/ディセントを吸収する) */
const ASCENT = 0.95;
const DESCENT = 0.35;
/** 行内セル分割とみなす最小ギャップ(フォントサイズ倍率 / 絶対値pt) */
const CELL_GAP_RATIO = 1;
const CELL_GAP_MIN_PT = 8;
/** 箇条書きの行頭記号。行頭に来たら段落境界とみなす(スライドの箇条書き対策)。 */
const BULLET_RE =
  /^[\u2022\u25cf\u25cb\u25e6\u25aa\u25ab\u25b8\u25b9\u25ba\u25b6\u25c6\u25c7\u25a0\u25a1\u2605\u2606\u203b\u30fb]/;
/** CJK(かな・漢字・全角記号)。行を連結する際に空白を入れない判定に使う。 */
const CJK_CHAR_RE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;

function baselineTolerance(itemFontSize: number, lineFontSize: number): number {
  const big = Math.max(itemFontSize, lineFontSize);
  const small = Math.min(itemFontSize, lineFontSize);
  if (big / small > MIXED_SIZE_RATIO) return big * MIXED_BASELINE_TOLERANCE;
  return Math.max(1.5, itemFontSize * SAME_SIZE_TOLERANCE);
}

export function buildLines(items: TextItemBox[]): LineBox[] {
  return buildLinesDetailed(items).map((entry) => entry.line);
}

/**
 * 行を組み立て、各行に属するテキスト項目も返す(段分割のため)。
 */
export function buildLinesDetailed(
  items: TextItemBox[],
): { line: LineBox; items: TextItemBox[] }[] {
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
    if (!best) {
      // 上付き・下付きの数式片は、通常の許容差では別行になりやすい。
      // 近くの大きい行の x 範囲内にあれば、その行の一部として取り込む。
      let fallback: { line: LineBox; items: TextItemBox[] } | undefined;
      let fallbackDelta = Infinity;
      for (const entry of lines) {
        if (entry.line.fontSize < item.fontSize * 1.25) continue;
        if (item.x < entry.line.x0 - 30 || item.x > entry.line.x1 + 30) {
          continue;
        }
        const delta = Math.abs(entry.line.baselineY - item.y);
        if (delta <= entry.line.fontSize * 0.9 && delta < fallbackDelta) {
          fallback = entry;
          fallbackDelta = delta;
        }
      }
      best = fallback;
    }
    if (best) {
      best.items.push(item);
    } else {
      lines.push({ line: emptyLine(item), items: [item] });
    }
  }
  const result: { line: LineBox; items: TextItemBox[] }[] = [];
  for (const entry of lines) {
    entry.items.sort((a, b) => a.x - b.x);
    result.push({ line: assembleLine(entry.items), items: entry.items });
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
    bold: isBoldItem(item),
    color: item.color,
    backgroundColor: item.backgroundColor,
  };
}

/** テキスト項目が太字かどうか。PDF 由来のフラグを優先し、無ければフォント名で推定する。 */
function isBoldItem(item: TextItemBox): boolean {
  return item.bold ?? isBoldFont(item.fontName);
}

/**
 * フォント名からの太字判定(pdf.js の太字フラグが取れなかった場合のフォールバック)。
 * LaTeX 系の "NimbusRomNo9L-Medi" や "CMBX10"、欧文の "-Semibold" なども拾う。
 */
function isBoldFont(fontName: string): boolean {
  return /bold|black|heavy|demi|medi|cmbx|cmb\d/i.test(fontName);
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

/** 文字数で重み付けした最頻色を返す(リンク色など一部だけ違う場合に多数派を採る)。 */
function dominantColor<T>(
  items: T[],
  pick: (item: T) => Rgb | undefined,
  weightOf: (item: T) => number,
): Rgb | undefined {
  const weights = new Map<string, { color: Rgb; weight: number }>();
  for (const item of items) {
    const color = pick(item);
    if (!color) continue;
    const key = `${color.r.toFixed(3)},${color.g.toFixed(3)},${
      color.b.toFixed(3)
    }`;
    const entry = weights.get(key) ?? { color, weight: 0 };
    entry.weight += Math.max(1, weightOf(item));
    weights.set(key, entry);
  }
  let best: { color: Rgb; weight: number } | undefined;
  for (const entry of weights.values()) {
    if (!best || entry.weight > best.weight) best = entry;
  }
  return best?.color;
}

/** テキスト項目群から1行の LineBox を組み立てる(セル行は cells を保持する)。 */
function buildLineBox(items: TextItemBox[], cells?: LineBox[]): LineBox {
  let text = "";
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  let boldWeight = 0;
  let runningEnd = items.length > 0 ? items[0].x + items[0].width : 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      if (it.x - runningEnd > Math.max(1, prev.fontSize * 0.22)) {
        text += " ";
      }
    }
    runningEnd = Math.max(runningEnd, it.x + it.width);
    text += it.str;
    x0 = Math.min(x0, it.x);
    x1 = Math.max(x1, it.x + it.width);
    y0 = Math.min(y0, it.y - it.fontSize * DESCENT);
    y1 = Math.max(y1, it.y + it.fontSize * ASCENT);
    if (isBoldItem(it)) boldWeight++;
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
    color: dominantColor(items, (it) => it.color, (it) => it.str.trim().length),
    backgroundColor: dominantColor(
      items,
      (it) => it.backgroundColor,
      (it) => it.str.trim().length,
    ),
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
  // 行内の数式片(√ など)は前行のテキストと x 範囲が重なることがある。
  // 直前の項目だけでなく「ここまでで最も右の端」との差で隙間を測る。
  let runningEnd = items.length > 0 ? items[0].x + items[0].width : 0;
  const candidates: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (i === 0) continue;
    const prev = items[i - 1];
    const it = items[i];
    const gap = it.x - runningEnd;
    if (
      gap >= Math.max(prev.fontSize * CELL_GAP_RATIO, CELL_GAP_MIN_PT) &&
      prev.str.trim() !== "" && it.str.trim() !== ""
    ) {
      candidates.push(i);
    }
    runningEnd = Math.max(runningEnd, it.x + it.width);
  }
  // 1か所だけ大きな隙間がある行は、インライン数式や字下げの可能性が高い。
  // その場合は左右がどちらも短い(表のセルらしい)ときだけ分割する。
  const wordCount = (list: TextItemBox[]) =>
    list.reduce(
      (n, it) => n + (it.str.trim().match(/\S+/g)?.length ?? 0),
      0,
    );
  for (const i of candidates) {
    if (candidates.length === 1) {
      const leftWords = wordCount(items.slice(0, i));
      const rightWords = wordCount(items.slice(i));
      if (leftWords > 6 || rightWords > 6) continue;
    }
    closeCell(i);
    cellStart = i;
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

/** 同一段内の行間(ベースライン間隔)の代表値を推定する。 */
function typicalLineGap(ordered: LineBox[]): number | undefined {
  const gaps: number[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const delta = ordered[i - 1].baselineY - ordered[i].baselineY;
    const fs = Math.max(ordered[i - 1].fontSize, ordered[i].fontSize);
    // 段落間・見出し前後などの大きい間隔は行間の推定から除く
    if (delta > 0 && delta <= fs * 1.85) gaps.push(delta);
  }
  if (gaps.length === 0) return undefined;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

export function groupParagraphs(
  lines: LineBox[],
  _columnIndex: number,
): LineBox[][] {
  const ordered = [...lines].sort((a, b) =>
    b.baselineY - a.baselineY || a.x0 - b.x0
  );
  // 段落間の空きは行間より少し広いだけのことが多い(1.3〜1.5倍)。
  // 固定倍率ではなく、その段の実際の行間から閾値を決める。
  const typicalGap = typicalLineGap(ordered);
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
    const prevIsBullet = BULLET_RE.test(prev.text.trimStart());
    // 箇条書きの折り返し行は記号の分だけ右にずれる。字下げ扱いにしない。
    const indentStartsParagraph = !prevIsBullet && !centeredContinuation &&
      line.x0 - prev.x0 > fs * 0.65;
    const hangingEntryStarts = current.length >= 2 &&
      prev.x0 - line.x0 > fs * 0.65;
    const centeredHeadingBeforeBody = prevWidth < lineWidth * 0.6 &&
      line.x0 < prev.x0 - fs * 3;
    // 箇条書きの行は前の項目と融合させない(「…。• 次…」のような潰れを防ぐ)
    const bulletStartsParagraph = BULLET_RE.test(line.text.trimStart());
    const maxMergeGap = Math.min(
      fs * 1.85,
      Math.max(fs * 1.15, (typicalGap ?? fs * 1.2) * 1.3),
    );
    if (
      baselineDelta > 0 &&
      baselineDelta <= maxMergeGap &&
      overlap > narrower * 0.25 &&
      sizeOk &&
      !prevIsDebris &&
      !lineIsDebris &&
      !indentStartsParagraph &&
      !hangingEntryStarts &&
      !bulletStartsParagraph &&
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
    const prevChar = text.slice(-1);
    const nextChar = line.text.charAt(0);
    // 日本語などのCJKは行末で単語が切れても空白を入れない
    const cjkJoin = CJK_CHAR_RE.test(prevChar) || CJK_CHAR_RE.test(nextChar);
    if (prevEndsWithHyphen && nextStartsLower) {
      text = text.replace(/[\u2010-\u2015-]$/, "") + line.text;
    } else if (cjkJoin) {
      text += line.text;
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
    color: dominantColor(
      group,
      (l) => l.color,
      (l) => l.text.trim().length,
    ),
    backgroundColor: dominantColor(
      group,
      (l) => l.backgroundColor,
      (l) => l.text.trim().length,
    ),
    centered: isCentered(group),
    kind: group.every((line) => line.bold) || fontSize > medianFs * 1.18
      ? "heading"
      : "body",
  };
}

/** 段間の谷とみなす最小の空き幅(フォントサイズ倍率 / 絶対値pt)。 */
const GUTTER_GAP_RATIO = 0.6;
const GUTTER_GAP_MIN_PT = 6;

/** ベースラインが同じテキスト項目をまとめる(段の谷を探すための下ごしらえ)。 */
function rowsByBaseline(items: TextItemBox[]): TextItemBox[][] {
  const rows: TextItemBox[][] = [];
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  for (const item of sorted) {
    const row = rows.find((r) =>
      Math.abs(r[0].y - item.y) <= Math.max(1.5, item.fontSize * 0.3)
    );
    if (row) row.push(item);
    else rows.push([item]);
  }
  return rows;
}

/**
 * ページ縦方向に走る段間の谷(gutter)の x 座標を推定する。
 *
 * 2段組の論文では左右の段の行が同じベースラインに載ることがあり、行の組み立てで
 * 左右が1行に融合してしまう(本文が全幅に流れて重なる)。ここでは生のテキスト
 * 項目をベースラインごとに見て、同じ行の左右に「語間より広い空き」を挟んで
 * 内容がある行が多数を占める x を谷とみなす。段をまたぐ見出し・要旨の行は
 * 谷を横切るため、横切る行が少ないことを条件にして誤検出を防ぐ。
 */
export function detectColumnGutter(
  items: TextItemBox[],
  pageWidth: number,
): number | undefined {
  const usable = items.filter((it) =>
    it.rotation < ROTATION_TOLERANCE && it.str.trim() !== ""
  );
  if (usable.length < 20) return undefined;
  const rows = rowsByBaseline(usable);
  if (rows.length < 6) return undefined;
  for (const row of rows) row.sort((a, b) => a.x - b.x);

  const from = Math.floor(pageWidth * 0.3);
  const to = Math.ceil(pageWidth * 0.7);
  let best:
    | {
      x: number;
      split: number;
      crossing: number;
      leftOnly: number;
      rightOnly: number;
    }
    | undefined;
  for (let x = from; x <= to; x++) {
    let split = 0;
    let crossing = 0;
    let leftOnly = 0;
    let rightOnly = 0;
    for (const row of rows) {
      let covered = false;
      let leftEnd = -Infinity;
      let rightStart = Infinity;
      for (const it of row) {
        const end = it.x + it.width;
        if (it.x < x - 0.5 && end > x + 0.5) covered = true;
        if (end <= x) leftEnd = Math.max(leftEnd, end);
        else if (it.x >= x) rightStart = Math.min(rightStart, it.x);
      }
      if (covered) {
        crossing++;
        continue;
      }
      if (leftEnd !== -Infinity && rightStart === Infinity) leftOnly++;
      else if (leftEnd === -Infinity && rightStart !== Infinity) rightOnly++;
      if (leftEnd === -Infinity || rightStart === Infinity) continue;
      const gap = rightStart - leftEnd;
      const fs = row[0].fontSize;
      if (gap >= Math.max(fs * GUTTER_GAP_RATIO, GUTTER_GAP_MIN_PT)) split++;
    }
    // 谷を挟んで左右に内容がある行が十分にあること。1段組のページでは語間
    // (0.2〜0.35em 程度)しか空かず、この条件を満たす行がほとんど無い。
    if (split < 5) continue;
    if (split + leftOnly + rightOnly < rows.length * 0.5) continue;
    const candidate = { x, split, crossing, leftOnly, rightOnly };
    if (
      !best || candidate.split > best.split ||
      (candidate.split === best.split && candidate.crossing < best.crossing)
    ) {
      best = candidate;
    }
  }
  if (!best) return undefined;
  // 段をまたぐ行(タイトル・要旨・全幅の表)が多すぎるページは2段組とみなさない。
  if (best.crossing > rows.length * 0.6) return undefined;
  return best.x;
}

/**
 * 段間の谷より左/右で行を分割し、左右を別々の行として組み直す。
 * 谷を横切る行(全幅の見出しなど)はそのまま残す。
 */
function splitLinesAtGutter(
  detailed: { line: LineBox; items: TextItemBox[] }[],
  gutter: number,
): LineBox[] {
  const lines: LineBox[] = [];
  for (const entry of detailed) {
    const left: TextItemBox[] = [];
    const right: TextItemBox[] = [];
    let covered = false;
    for (const it of entry.items) {
      const end = it.x + it.width;
      if (it.x < gutter - 0.5 && end > gutter + 0.5) covered = true;
    }
    if (covered) {
      lines.push(entry.line);
      continue;
    }
    for (const it of entry.items) {
      if (it.x + it.width <= gutter) left.push(it);
      else right.push(it);
    }
    if (left.length === 0 || right.length === 0) {
      lines.push(entry.line);
      continue;
    }
    // 谷の位置に「語間より広い空き」がある行だけを分割する。1段組のページで
    // たまたま単語の切れ目が谷の x に重なった行を割らないため。
    const leftEnd = Math.max(...left.map((it) => it.x + it.width));
    const rightStart = Math.min(...right.map((it) => it.x));
    const fs = entry.line.fontSize;
    if (
      rightStart - leftEnd < Math.max(fs * GUTTER_GAP_RATIO, GUTTER_GAP_MIN_PT)
    ) {
      lines.push(entry.line);
      continue;
    }
    lines.push(assembleLine(left), assembleLine(right));
  }
  return lines;
}

export function analyzePage(page: ExtractedPage): PageLayout {
  const detailed = buildLinesDetailed(page.items);
  let lines = detailed.map((entry) => entry.line);
  const gutter = detectColumnGutter(page.items, page.width);
  // 段間の谷がページ中央付近にあるときだけ2段組とみなす。片側に寄った谷は
  // 表や字下げの偶然なので、1段組のページを割らないよう無視する。
  const ratio = gutter === undefined ? 0 : gutter / page.width;
  let columns: ReturnType<typeof detectColumns>;
  if (gutter !== undefined && ratio >= 0.4 && ratio <= 0.6) {
    // 左右の段の行が同じベースラインに載り、1行に融合している行を分ける。
    lines = splitLinesAtGutter(detailed, gutter);
    // 検出した谷をそのまま段境界にする。全幅の要旨・見出しがあると
    // detectColumns は「段を横切る行」が多いとして2段を諦めてしまうため。
    columns = [
      { index: 0, x0: 0, x1: gutter },
      { index: 1, x0: gutter, x1: page.width },
    ];
  } else {
    columns = detectColumns(lines, page.width);
  }
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
