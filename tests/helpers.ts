import { PDFDocument, rgb, StandardFonts } from "@cantoo/pdf-lib";
import type { ExtractedPage, TextItemBox } from "../engine/core/types.ts";

export interface FixtureLine {
  x: number;
  y: number;
  text: string;
  size?: number;
  font?: "regular" | "bold";
}

export async function createFixturePdf(
  pages: FixtureLine[][],
  opts: { width?: number; height?: number; whiteTextLines?: number[][] } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const page of pages) {
    const p = doc.addPage([opts.width ?? 612, opts.height ?? 792]);
    for (const line of page) {
      p.drawText(line.text, {
        x: line.x,
        y: line.y,
        size: line.size ?? 11,
        font: line.font === "bold" ? bold : regular,
        color: rgb(0, 0, 0),
      });
    }
    for (const rect of opts.whiteTextLines ?? []) {
      p.drawRectangle({
        x: rect[0],
        y: rect[1],
        width: rect[2],
        height: rect[3],
        color: rgb(1, 1, 1),
      });
    }
  }
  return new Uint8Array(await doc.save()) as Uint8Array<ArrayBuffer>;
}

export function itemsFromFixture(
  page: ExtractedPage,
): TextItemBox[] {
  return page.items;
}
