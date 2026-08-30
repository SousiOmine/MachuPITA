import { getResolvedPDFJS } from "unpdf";

/**
 * PDF のオペレータリストを軽量解釈し、「実際には可視化されないテキスト」
 * (クリップ領域の外に描かれたテキスト、白塗りテキスト、非表示レンダリング
 * モードのテキスト)のページ座標上の原点を収集する。
 *
 * pdf.js の getTextContent はクリッピングを無視するため、図の中に埋め込まれた
 * 不可視ラベルまで抽出されてしまう。それらを描画前に除外するために使う。
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
  return x >= r.x0 - tol && x <= r.x1 + tol && y >= r.y0 - tol && y <= r.y1 + tol;
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

/** 塗り色が(ほぼ)白かどうかを判定する */
function isWhiteFill(fn: number, args: unknown[], OPS: Record<string, number>): boolean {
  if (fn === OPS.setFillRGBColor) {
    const color = args[0];
    if (typeof color === "string") {
      const m = color.replace("#", "");
      const v = m.length === 3
        ? m.split("").map((c) => parseInt(c + c, 16))
        : [0, 2, 4].map((i) => parseInt(m.slice(i, i + 2), 16));
      return v.every((x) => x >= 250);
    }
    if (Array.isArray(color)) return color.every((x) => Number(x) >= 0.98);
  } else if (fn === OPS.setFillGray) {
    return Number(args[0]) >= 0.98;
  } else if (fn === OPS.setFillCMYKColor) {
    const v = (args as number[]).map((x) => Number(x));
    return v.length === 4 && v[0] < 0.05 && v[1] < 0.05 && v[2] < 0.05 && v[3] < 0.05;
  }
  return false;
}

/**
 * 指定ページの不可視テキスト原点(ページ座標系)を検出する。
 * 失敗した場合は空配列を返し(除外なしで継続)、描画を妨げない。
 */
export async function findInvisibleTextOrigins(
  page: {
    getOperatorList: () => Promise<{
      fnArray: number[];
      argsArray: unknown[][];
    }>;
  },
): Promise<{ x: number; y: number }[]> {
  try {
    const pdfjs = await getResolvedPDFJS();
    const OPS = pdfjs.OPS as unknown as Record<string, number>;
    const { fnArray, argsArray } = await page.getOperatorList();

    const origins: { x: number; y: number }[] = [];
    const ctmStack: Matrix[] = [];
    const clipStack: (Rect | null)[] = [];
    // グラフィックス状態(レンダリングモード・塗り色)も save/restore の対象
    const stateStack: { renderMode: number; whiteFill: boolean }[] = [];
    let ctm = IDENTITY;
    let clip: Rect | null = null;
    // pdf.js のオペレータリストは "clip" の直後に対応する constructPath
    // (minMax 付き)を出力する順序になるため、先に clip を検知してから
    // 続く constructPath の bbox を適用する。
    let pendingClipRule = false;
    let textMatrix = IDENTITY;
    let lineMatrix = IDENTITY;
    let renderMode = 0;
    let whiteFill = false;

    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i];
      const args = argsArray[i] ?? [];
      if (fn === OPS.save) {
        ctmStack.push(ctm);
        clipStack.push(clip);
        stateStack.push({ renderMode, whiteFill });
      } else if (fn === OPS.restore) {
        ctm = ctmStack.pop() ?? IDENTITY;
        clip = clipStack.pop() ?? null;
        const st = stateStack.pop();
        if (st) {
          renderMode = st.renderMode;
          whiteFill = st.whiteFill;
        }
      } else if (fn === OPS.transform) {
        ctm = mul(parseMatrixFlexible(args) ?? IDENTITY, ctm);
      } else if (fn === OPS.clip || fn === OPS.eoClip) {
        pendingClipRule = true;
      } else if (fn === OPS.constructPath) {
        // args = [pathOps, coords, minMax] (pdf.js が計算したパスの bbox)
        if (pendingClipRule) {
          pendingClipRule = false;
          const minX = argAt(args[2], 0), minY = argAt(args[2], 1);
          const maxX = argAt(args[2], 2), maxY = argAt(args[2], 3);
          if (minX !== undefined && maxX !== undefined && minY !== undefined && maxY !== undefined) {
            const p0 = apply(ctm, minX, minY);
            const p1 = apply(ctm, maxX, maxY);
            clip = intersectRect(clip, {
              x0: Math.min(p0.x, p1.x),
              y0: Math.min(p0.y, p1.y),
              x1: Math.max(p0.x, p1.x),
              y1: Math.max(p0.y, p1.y),
            });
          }
        }
      } else if (fn === OPS.paintFormXObjectBegin) {
        // フォームの BBox もレンダリング時にはクリップとして働く。
        ctmStack.push(ctm);
        clipStack.push(clip);
        stateStack.push({ renderMode, whiteFill });
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
          whiteFill = st.whiteFill;
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
          lineMatrix = mul({ ...IDENTITY, e: tx, f: ty }, lineMatrix);
          textMatrix = lineMatrix;
        }
      } else if (fn === OPS.nextLine) {
        textMatrix = lineMatrix;
      } else if (fn === OPS.setTextRenderingMode) {
        renderMode = Number(args[0]);
      } else if (
        fn === OPS.setFillRGBColor || fn === OPS.setFillGray ||
        fn === OPS.setFillCMYKColor
      ) {
        whiteFill = isWhiteFill(fn, args, OPS);
      } else if (fn === OPS.setGState) {
        const entries = args[0] as [string, unknown][] | undefined;
        if (Array.isArray(entries)) {
          for (const [k, v] of entries) {
            if (k === "ca" || k === "CA") {
              if (Number(v) === 0) whiteFill = true;
            }
          }
        }
      } else if (
        fn === OPS.showText || fn === OPS.showSpacedText ||
        fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText
      ) {
        const o = apply(mul(textMatrix, ctm), 0, 0);
        const clipped = !containsPoint(clip, o.x, o.y);
        if (clipped || renderMode === 3 || whiteFill) {
          origins.push({ x: o.x, y: o.y });
        }
      }
    }
    return origins;
  } catch {
    return [];
  }
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
