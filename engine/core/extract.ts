import { getDocumentProxy } from "unpdf";
import type { ExtractedPage, TextItemBox } from "./types.ts";
import { filterVisibleItems, findInvisibleTextOrigins } from "./visibility.ts";

export async function extractPages(
  input: Uint8Array,
  onProgress?: (page: number, total: number) => void,
): Promise<ExtractedPage[]> {
  // PDF.js transfers the buffer to its worker, detaching it; operate on a copy
  // so callers keep their original bytes usable for rendering later.
  const bytes = input.slice();
  const pdf = await getDocumentProxy(bytes);
  const pages: ExtractedPage[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // 図の中に埋め込まれた不可視テキスト(クリップ外・白塗り等)を除外する
    let invisibleOrigins: { x: number; y: number }[] = [];
    try {
      invisibleOrigins = await findInvisibleTextOrigins(page);
    } catch {
      // 検出に失敗した場合は除外せず続行
    }
    const items: TextItemBox[] = [];
    for (const item of content.items) {
      if (!("str" in item)) continue;
      if (item.str.trim() === "") continue;
      const m = item.transform as unknown as number[];
      const fontSize = Math.hypot(m[2], m[3]) || Math.abs(m[3]);
      const skew = Math.atan2(m[1], m[0]);
      items.push({
        str: item.str,
        x: m[4],
        y: m[5],
        width: item.width ?? item.str.length * fontSize * 0.5,
        fontSize,
        fontName: String(item.fontName ?? ""),
        rotation: Math.abs(skew),
      });
    }
    pages.push({
      pageNumber: i,
      width: viewport.width,
      height: viewport.height,
      items: filterVisibleItems(items, invisibleOrigins),
    });
    page.cleanup();
    onProgress?.(i, pdf.numPages);
  }
  return pages;
}
