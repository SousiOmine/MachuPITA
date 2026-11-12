import { getDocumentProxy } from "unpdf";
import type { ExtractedPage, TextItemBox } from "./types.ts";
import {
  analyzePagePaint,
  filterVisibleItems,
  findTextStyle,
} from "./visibility.ts";

/** pdf.js のフォントローダーID("g_d0_f1" など)から得た実際のフォント情報。 */
interface FontTrait {
  /**
   * 実フォント名(例: "ABCDEF+NimbusRomNo9L-Medi")。pdf.js が公開するのは
   * fontExtraProperties を有効にしたときだけなので、無ければ undefined。
   */
  name?: string;
  /** pdf.js が判定した太字フラグ。埋め込みフォントでは undefined のことが多い。 */
  bold?: boolean;
}

interface FontSource {
  getOperatorList(): Promise<unknown>;
  commonObjs: {
    has(id: string): boolean;
    get(id: string): unknown;
  };
}

/**
 * pdf.js のテキスト項目の fontName は "g_d0_f1" のような内部ローダーIDで、
 * 実際のフォント名は commonObjs に読み込まれたフォントにある。実フォント名が
 * 分かれば "NimbusRomNo9L-Medi" "CMBX10" のような太字書体も判定できる。
 * フォントはオペレータリストの実行時に読み込まれるため、未読み込みなら
 * getOperatorList() を呼んでから引き直す(可視性検査で読み込み済みなら再実行しない)。
 */
async function resolveFontTraits(
  page: FontSource,
  ids: string[],
): Promise<Map<string, FontTrait>> {
  const traits = new Map<string, FontTrait>();
  const collect = () => {
    for (const id of ids) {
      if (traits.has(id) || !page.commonObjs.has(id)) continue;
      const font = page.commonObjs.get(id) as {
        name?: unknown;
        bold?: unknown;
      } | null;
      if (!font) continue;
      traits.set(id, {
        name: typeof font.name === "string" ? font.name : undefined,
        bold: typeof font.bold === "boolean" ? font.bold : undefined,
      });
    }
  };
  collect();
  if (traits.size < ids.length) {
    try {
      await page.getOperatorList();
    } catch {
      // 読み込みに失敗しても fontName だけは元の値のまま使う
    }
    collect();
  }
  return traits;
}

export async function extractPages(
  input: Uint8Array,
  onProgress?: (page: number, total: number) => void,
): Promise<ExtractedPage[]> {
  // PDF.js transfers the buffer to its worker, detaching it; operate on a copy
  // so callers keep their original bytes usable for rendering later.
  const bytes = input.slice();
  // fontExtraProperties を有効にすると、フォント名(name)まで取得できる。
  const pdf = await getDocumentProxy(bytes, { fontExtraProperties: true });
  const pages: ExtractedPage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // 図の中に埋め込まれた不可視テキスト(クリップ外・後の塗りに覆われた・
    // 背景と同色など)を除外する。あわせて文字色と背景色を取得する。
    let paint = { invisibleOrigins: [], styles: [] } as Awaited<
      ReturnType<typeof analyzePagePaint>
    >;
    try {
      paint = await analyzePagePaint(page);
    } catch {
      // 検出に失敗した場合は除外せず続行
    }
    const fontIds = new Set<string>();
    for (const item of content.items) {
      if (!("str" in item) || item.str.trim() === "") continue;
      if (item.fontName) fontIds.add(String(item.fontName));
    }
    const fontTraits = await resolveFontTraits(page, [...fontIds]);
    const items: TextItemBox[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      if (item.str.trim() === "") continue;
      const m = item.transform as unknown as number[];
      const fontSize = Math.hypot(m[2], m[3]) || Math.abs(m[3]);
      const skew = Math.atan2(m[1], m[0]);
      const fontId = String(item.fontName ?? "");
      const trait = fontTraits.get(fontId);
      const style = findTextStyle(paint.styles, m[4], m[5], fontSize);
      items.push({
        str: item.str,
        x: m[4],
        y: m[5],
        width: item.width ?? item.str.length * fontSize * 0.5,
        fontSize,
        fontName: trait?.name ?? fontId,
        bold: trait?.bold,
        rotation: Math.abs(skew),
        color: style?.textColor,
        backgroundColor: style?.backgroundColor,
      });
    }
    pages.push({
      pageNumber: i,
      width: viewport.width,
      height: viewport.height,
      items: filterVisibleItems(items, paint.invisibleOrigins),
    });
    page.cleanup();
    onProgress?.(i, pdf.numPages);
  }
  return pages;
}
