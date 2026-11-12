import { getResolvedPDFJS } from "unpdf";

/**
 * PDF のオペレータリストを軽量解釈し、「実際には可視化されないテキスト」
 * (クリップ領域の外・後の塗りで覆われた・背景と同色・非表示レンダリング
 * モード)のページ座標上の原点を収集する。あわせて可視テキストの文字色と
 * その背後の塗り色を記録する(再描画時に元の見た目を保つため)。
 *
 * pdf.js の getTextContent はクリッピングや描画順を無視するため、図の中に
 * 埋め込まれた不可視ラベルや、スライドの背景矩形に覆われた元テキストまで
 * 抽出されてしまう。それらを描画前に除外するために使う。
 */

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

function mul(m: Matrix, n: Matrix): Matrix {
  return {
    a: m.a * n.a + m.b * n.c,
    b: m.a * n.b + m.b * n.d,
    c: m.c * n.a + m.d * n.c,
    d: m.c * n.b + m.d * n.d,
    e: m.e * n.a + m.f * n.c + n.e,
    f: m.e * n.b + m.f * n.d + n.f,
  };
}

function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function intersectRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  return {
    x0: Math.max(a.x0, b.x0),
    y0: Math.max(a.y0, b.y0),
    x1: Math.min(a.x1, b.x1),
    y1: Math.min(a.y1, b.y1),
  };
}

function containsPoint(r: Rect | null, x: number, y: number, tol = 1): boolean {
  if (!r) return true;
  return x >= r.x0 - tol && x <= r.x1 + tol && y >= r.y0 - tol &&
    y <= r.y1 + tol;
}

/** 0..1 の RGB 色。 */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const WHITE: Rgb = { r: 1, g: 1, b: 1 };
const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 2色がほぼ同じかどうか(背景と同色テキストの判定に使う)。 */
export function colorsClose(a: Rgb, b: Rgb, tolerance = 0.08): boolean {
  return Math.abs(a.r - b.r) <= tolerance &&
    Math.abs(a.g - b.g) <= tolerance &&
    Math.abs(a.b - b.b) <= tolerance;
}

/** 指定座標の背後の塗り色を返す(塗りの描画順を考慮し、最後に塗られたもの)。 */
function backgroundAt(
  painted: { rect: Rect; color: Rgb }[],
  x: number,
  y: number,
): Rgb {
  for (let i = painted.length - 1; i >= 0; i--) {
    if (containsPoint(painted[i].rect, x, y, 0.5)) return painted[i].color;
  }
  return WHITE;
}

/** 可視テキスト1回分の描画スタイル。 */
export interface TextStyleRecord {
  /** テキスト原点(ページ座標)。 */
  x: number;
  y: number;
  /** テキストの推定終端 x。同じ showText から生じた複数項目の照合に使う。 */
  endX: number;
  textColor: Rgb;
  backgroundColor: Rgb;
}

export interface PagePaintAnalysis {
  invisibleOrigins: { x: number; y: number }[];
  styles: TextStyleRecord[];
}

/** 行列をフラット形式・ラップ形式([matrixObj])の両方から解釈する */
function parseMatrixFlexible(args: unknown): Matrix | null {
  const tryMatrix = (src: unknown): Matrix | null => {
    const a = argAt(src, 0), d = argAt(src, 3);
    if (a === undefined || d === undefined) return null;
    return {
      a,
      b: argAt(src, 1) ?? 0,
      c: argAt(src, 2) ?? 0,
      d,
      e: argAt(src, 4) ?? 0,
      f: argAt(src, 5) ?? 0,
    };
  };
  const direct = tryMatrix(args);
  if (direct) return direct;
  if (Array.isArray(args)) {
    for (const el of args) {
      const m = tryMatrix(el);
      if (m) return m;
    }
  }
  return null;
}

/** pdf.js の引数は配列または数値キーのオブジェクト({"0":...})で来ることがある */
function argAt(args: unknown, i: number): number | undefined {
  if (Array.isArray(args)) {
    const v = args[i];
    return typeof v === "number" ? v : undefined;
  }
  if (args && typeof args === "object") {
    const v = (args as Record<string, unknown>)[String(i)];
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

function rgbFromHex(hex: string): Rgb | null {
  const m = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(m) && !/^[0-9a-fA-F]{3}$/.test(m)) return null;
  const parts = m.length === 3
    ? m.split("").map((c) => parseInt(c + c, 16))
    : [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
  return {
    r: clamp01(parts[0] / 255),
    g: clamp01(parts[1] / 255),
    b: clamp01(parts[2] / 255),
  };
}

function rgbFromArray(values: number[]): Rgb | null {
  if (values.length === 1 && Number.isFinite(values[0])) {
    const g = clamp01(values[0]);
    return { r: g, g, b: g };
  }
  if (values.length === 3 && values.every((v) => Number.isFinite(v))) {
    return {
      r: clamp01(values[0]),
      g: clamp01(values[1]),
      b: clamp01(values[2]),
    };
  }
  if (values.length === 4 && values.every((v) => Number.isFinite(v))) {
    const [c, m, y, k] = values.map(clamp01);
    return { r: (1 - c) * (1 - k), g: (1 - m) * (1 - k), b: (1 - y) * (1 - k) };
  }
  return null;
}

/**
 * 現在の非ストローク色を解釈する。対応するのは DeviceRGB / DeviceGray /
 * DeviceCMYK(および "#rrggbb" 形式)のみ。パターン・ICC ベースは null。
 */
function parseFillColor(
  fn: number,
  args: unknown[],
  OPS: Record<string, number>,
): Rgb | null {
  if (
    fn !== OPS.setFillRGBColor && fn !== OPS.setFillGray &&
    fn !== OPS.setFillCMYKColor && fn !== OPS.setFillColor
  ) {
    return null;
  }
  const raw = args[0];
  if (typeof raw === "string") return rgbFromHex(raw);
  if (Array.isArray(raw)) return rgbFromArray(raw.map((v) => Number(v)));
  if (typeof raw === "number") return rgbFromArray([raw]);
  // setFillColor は [name, ...] のことがある
  if (Array.isArray(args) && typeof args[0] === "string") {
    return rgbFromHex(args[0]);
  }
  return null;
}

/** showText 系オペレータの送り幅をページ座標で推定する。 */
function showTextAdvance(
  args: unknown[],
  pageFontSize: number,
): number {
  const glyphs = args[0];
  if (!Array.isArray(glyphs)) {
    const s = typeof glyphs === "string" ? glyphs : "";
    return s.length * pageFontSize * 0.5;
  }
  let units = 0;
  let chars = 0;
  for (const g of glyphs) {
    if (typeof g === "number") {
      // TJ のカーニング値(1/1000 em)。負値は字間を詰める。
      units -= g;
      continue;
    }
    if (g && typeof g === "object") {
      const width = (g as { width?: unknown }).width;
      if (typeof width === "number") units += width;
      chars++;
    }
  }
  if (chars === 0) return 0;
  return (units / 1000) * pageFontSize;
}

/**
 * 指定ページの描画解析を行う。失敗した場合は空の結果を返し(除外なしで
 * 継続し、色は既定値を使う)、描画を妨げない。
 */
export async function analyzePagePaint(
  page: {
    getOperatorList: () => Promise<{
      fnArray: number[];
      argsArray: unknown[][];
    }>;
  },
): Promise<PagePaintAnalysis> {
  const empty: PagePaintAnalysis = { invisibleOrigins: [], styles: [] };
  try {
    const pdfjs = await getResolvedPDFJS();
    const OPS = pdfjs.OPS as unknown as Record<string, number>;
    const { fnArray, argsArray } = await page.getOperatorList();

    const origins: { x: number; y: number }[] = [];
    const styles: TextStyleRecord[] = [];
    const painted: { rect: Rect; color: Rgb }[] = [];
    const ctmStack: Matrix[] = [];
    const clipStack: (Rect | null)[] = [];
    // グラフィックス状態(レンダリングモード・塗り色・不透明度)も save/restore の対象
    const stateStack: {
      renderMode: number;
      fillColor: Rgb;
      fillAlpha: number;
      leading: number;
    }[] = [];
    let ctm = IDENTITY;
    let clip: Rect | null = null;
    // pdf.js のオペレータリストは "clip" の直後に対応する constructPath
    // (minMax 付き)を出力する順序になるため、先に clip を検知してから
    // 続く constructPath の bbox を適用する。
    let pendingClipRule = false;
    let textMatrix = IDENTITY;
    let lineMatrix = IDENTITY;
    let renderMode = 0;
    let fillColor: Rgb = BLACK;
    let fillAlpha = 1;
    const alphaStack: number[] = [];
    // テキスト行送り(TL)。BT で行行列が初期化されても引き継がれる。
    let leading = 0;

    const rectFromMinMax = (args: unknown[]): Rect | null => {
      const minX = argAt(args[2], 0), minY = argAt(args[2], 1);
      const maxX = argAt(args[2], 2), maxY = argAt(args[2], 3);
      if (
        minX === undefined || maxX === undefined || minY === undefined ||
        maxY === undefined
      ) return null;
      const p0 = apply(ctm, minX, minY);
      const p1 = apply(ctm, maxX, maxY);
      return {
        x0: Math.min(p0.x, p1.x),
        y0: Math.min(p0.y, p1.y),
        x1: Math.max(p0.x, p1.x),
        y1: Math.max(p0.y, p1.y),
      };
    };

    /** 後から塗られた不透明な領域で覆われた可視テキストを不可視にする。 */
    const coverTexts = (rect: Rect) => {
      for (let i = styles.length - 1; i >= 0; i--) {
        const s = styles[i];
        if (s.x < rect.x0 - 0.5 || s.x > rect.x1 + 0.5) continue;
        if (s.y < rect.y0 - 0.5 || s.y > rect.y1 + 0.5) continue;
        origins.push({ x: s.x, y: s.y });
        styles.splice(i, 1);
      }
    };

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i] ?? [];
      if (fn === OPS.save) {
        ctmStack.push(ctm);
        clipStack.push(clip);
        stateStack.push({ renderMode, fillColor, fillAlpha, leading });
        alphaStack.push(fillAlpha);
      } else if (fn === OPS.restore) {
        ctm = ctmStack.pop() ?? IDENTITY;
        clip = clipStack.pop() ?? null;
        const st = stateStack.pop();
        if (st) {
          renderMode = st.renderMode;
          fillColor = st.fillColor;
          fillAlpha = st.fillAlpha;
          leading = st.leading;
        }
        alphaStack.pop();
      } else if (fn === OPS.transform) {
        ctm = mul(parseMatrixFlexible(args) ?? IDENTITY, ctm);
      } else if (fn === OPS.clip || fn === OPS.eoClip) {
        pendingClipRule = true;
      } else if (fn === OPS.constructPath) {
        // pdf.js 6 の constructPath は args = [描画op, パス座標, minMax]。
        // 描画op が fill 系なら塗り、clip 系ならクリップとして扱う。
        const rect = rectFromMinMax(args);
        const paintOp = argAt(args, 0);
        const isFill = paintOp === OPS.fill || paintOp === OPS.eoFill ||
          paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke ||
          paintOp === OPS.closeFillStroke ||
          paintOp === OPS.closeEOFillStroke;
        if (pendingClipRule) {
          pendingClipRule = false;
          if (rect) clip = intersectRect(clip, rect);
        } else if (paintOp === OPS.clip || paintOp === OPS.eoClip) {
          if (rect) clip = intersectRect(clip, rect);
        } else if (isFill) {
          if (rect && rect.x1 > rect.x0 && rect.y1 > rect.y0) {
            if (fillAlpha >= 0.99) {
              coverTexts(rect);
              painted.push({ rect, color: fillColor });
            }
          }
        }
      } else if (fn === OPS.paintFormXObjectBegin) {
        // フォームの BBox もレンダリング時にはクリップとして働く。
        ctmStack.push(ctm);
        clipStack.push(clip);
        stateStack.push({ renderMode, fillColor, fillAlpha, leading });
        const m = parseMatrixFlexible(args[0]);
        if (m) {
          ctm = mul(m, ctm);
        }
        const bbox = args[1];
        const minX = argAt(bbox, 0), minY = argAt(bbox, 1);
        const maxX = argAt(bbox, 2), maxY = argAt(bbox, 3);
        if (
          minX !== undefined && maxX !== undefined &&
          minY !== undefined && maxY !== undefined && maxX - minX > 0
        ) {
          const p0 = apply(ctm, minX, minY);
          const p1 = apply(ctm, maxX, maxY);
          clip = intersectRect(clip, {
            x0: Math.min(p0.x, p1.x),
            y0: Math.min(p0.y, p1.y),
            x1: Math.max(p0.x, p1.x),
            y1: Math.max(p0.y, p1.y),
          });
        }
      } else if (fn === OPS.paintFormXObjectEnd) {
        ctm = ctmStack.pop() ?? IDENTITY;
        clip = clipStack.pop() ?? null;
        const st = stateStack.pop();
        if (st) {
          renderMode = st.renderMode;
          fillColor = st.fillColor;
          fillAlpha = st.fillAlpha;
          leading = st.leading;
        }
      } else if (fn === OPS.beginText) {
        textMatrix = IDENTITY;
        lineMatrix = IDENTITY;
      } else if (fn === OPS.setTextMatrix) {
        // args は [matrixObj] ラップ形式またはフラット形式の両方があり得る
        const m = parseMatrixFlexible(args);
        if (m) {
          textMatrix = m;
          lineMatrix = m;
        }
      } else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText) {
        const tx = argAt(args, 0), ty = argAt(args, 1);
        if (tx !== undefined && ty !== undefined) {
          if (fn === OPS.setLeadingMoveText) leading = -ty;
          lineMatrix = mul({ ...IDENTITY, e: tx, f: ty }, lineMatrix);
          textMatrix = lineMatrix;
        }
      } else if (fn === OPS.setLeading) {
        const tl = argAt(args, 0);
        if (tl !== undefined) leading = tl;
      } else if (fn === OPS.nextLine) {
        lineMatrix = mul({ ...IDENTITY, f: -leading }, lineMatrix);
        textMatrix = lineMatrix;
      } else if (fn === OPS.setTextRenderingMode) {
        renderMode = Number(args[0]);
      } else if (
        fn === OPS.setFillRGBColor || fn === OPS.setFillGray ||
        fn === OPS.setFillCMYKColor || fn === OPS.setFillColor
      ) {
        const color = parseFillColor(fn, args, OPS);
        if (color) fillColor = color;
      } else if (fn === OPS.setGState) {
        const entries = args[0] as [string, unknown][] | undefined;
        if (Array.isArray(entries)) {
          for (const [k, v] of entries) {
            if (k === "ca") fillAlpha = Number(v);
          }
        }
      } else if (
        fn === OPS.showText || fn === OPS.showSpacedText ||
        fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText
      ) {
        const tm = mul(textMatrix, ctm);
        const o = apply(tm, 0, 0);
        const pageFontSize = Math.hypot(tm.a, tm.b) ||
          Math.hypot(tm.c, tm.d) || 10;
        const clipped = !containsPoint(clip, o.x, o.y);
        if (clipped || renderMode === 3 || fillAlpha < 0.02) {
          origins.push({ x: o.x, y: o.y });
          continue;
        }
        const background = backgroundAt(painted, o.x, o.y);
        // 背景とほぼ同色のテキストは見えない(白地の白文字など)
        if (colorsClose(fillColor, background) && fillAlpha >= 0.5) {
          origins.push({ x: o.x, y: o.y });
          continue;
        }
        // 文字色と背景色が近すぎて判別できない場合は可視とみなす
        const advance = showTextAdvance(args, pageFontSize);
        styles.push({
          x: o.x,
          y: o.y,
          endX: o.x + Math.max(advance, 0),
          textColor: fillColor,
          backgroundColor: background,
        });
      }
    }
    // マスク後に同じ位置へ訳文を描き直した PDF では、不可視になった原文と
    // 可視の訳文が同じ原点を持つ。両方を除外しないよう、可視スタイルのある
    // 原点は不可視リストから落とす。
    const filteredOrigins = origins.filter((o) =>
      !styles.some((st) =>
        Math.abs(st.x - o.x) <= 0.75 && Math.abs(st.y - o.y) <= 0.75
      )
    );
    return { invisibleOrigins: filteredOrigins, styles };
  } catch {
    return empty;
  }
}

/** 後方互換: 不可視テキスト原点のみを返す。 */
export async function findInvisibleTextOrigins(
  page: {
    getOperatorList: () => Promise<{
      fnArray: number[];
      argsArray: unknown[][];
    }>;
  },
): Promise<{ x: number; y: number }[]> {
  return (await analyzePagePaint(page)).invisibleOrigins;
}

/**
 * 抽出済みテキスト項目から、不可視テキストと一致するものを除外する。
 * origins はオペレータリスト由来の原点(ページ座標系)、items は getTextContent
 * 由来の同座標系の項目。一致判定は原点距離の許容で行う。
 */
export function filterVisibleItems<
  T extends { x: number; y: number; fontSize: number },
>(
  items: T[],
  invisibleOrigins: { x: number; y: number }[],
): T[] {
  if (invisibleOrigins.length === 0) return items;
  return items.filter((it) => {
    const tol = Math.max(3, it.fontSize * 0.5);
    return !invisibleOrigins.some((o) =>
      Math.abs(o.x - it.x) <= tol && Math.abs(o.y - it.y) <= tol
    );
  });
}

/** 抽出項目に対応する描画スタイルを探す(同じ showText の複数項目も拾う)。 */
export function findTextStyle(
  styles: TextStyleRecord[],
  x: number,
  y: number,
  fontSize: number,
): TextStyleRecord | undefined {
  const tol = Math.max(2.5, fontSize * 0.6);
  let fallback: TextStyleRecord | undefined;
  for (const s of styles) {
    if (Math.abs(s.y - y) > tol) continue;
    if (x >= s.x - 3 && x <= s.endX + 3) return s;
    if (x >= s.x - 3 && (!fallback || s.x > fallback.x)) fallback = s;
  }
  return fallback;
}
