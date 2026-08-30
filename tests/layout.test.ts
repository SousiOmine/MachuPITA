import { assertEquals } from "@std/assert";
import {
  analyzePage,
  buildLines,
  detectColumns,
  groupParagraphs,
} from "../engine/core/layout.ts";
import type {
  ExtractedPage,
  LineBox,
  TextItemBox,
} from "../engine/core/types.ts";

function item(
  str: string,
  x: number,
  y: number,
  fontSize = 11,
): TextItemBox {
  return {
    str,
    x,
    y,
    width: str.length * fontSize * 0.5,
    fontSize,
    fontName: "Helvetica",
    rotation: 0,
  };
}

Deno.test("buildLines groups items on the same baseline", () => {
  const lines = buildLines([
    item("Hello", 72, 700),
    item("world", 110, 700),
    item("second line", 72, 685),
  ]);
  assertEquals(lines.length, 2);
  assertEquals(lines[0].text, "Hello world");
  assertEquals(lines[1].text, "second line");
});

Deno.test("buildLines sorts top to bottom", () => {
  const lines = buildLines([
    item("lower", 72, 600),
    item("upper", 72, 640),
  ]);
  assertEquals(lines[0].text, "upper");
});

function line(
  text: string,
  x0: number,
  baselineY: number,
  fontSize = 11,
  widthFactor = 0.5,
): LineBox {
  const width = text.length * fontSize * widthFactor;
  return {
    x0,
    y0: baselineY - fontSize * 0.25,
    x1: x0 + width,
    y1: baselineY + fontSize * 0.75,
    baselineY,
    text,
    fontSize,
    bold: false,
  };
}

Deno.test("groupParagraphs merges consecutive lines into one paragraph", () => {
  const groups = groupParagraphs([
    line("first line of paragraph text here", 72, 700),
    line("second line continues the thought", 72, 685),
    line("third line ends it all now ok", 72, 670),
  ], 0);
  assertEquals(groups.length, 1);
});

Deno.test("groupParagraphs splits on large vertical gaps", () => {
  const groups = groupParagraphs([
    line("end of first paragraph block here", 72, 700),
    line("start of second paragraph block", 72, 650),
  ], 0);
  assertEquals(groups.length, 2);
});

Deno.test("detectColumns finds two columns when a wide gap exists", () => {
  const left = [1, 2, 3, 4].map((i) =>
    line(`left col line number ${i}`, 60, 700 - i * 15, 10)
  );
  const right = [1, 2, 3, 4].map((i) =>
    line(`right col line number ${i}`, 330, 700 - i * 15, 10)
  );
  const columns = detectColumns([...left, ...right], 612);
  assertEquals(columns.length, 2);
});

Deno.test("buildLines attaches superscript items to the main line", () => {
  // 上付きの ∗ (小フォント・ベースラインより上) は名前と同じ行に取り込まれる
  const lines = buildLines([
    item("Ashish Vaswani", 132, 700, 10),
    item("\u2217", 202, 703.6, 7),
  ]);
  assertEquals(lines.length, 1);
  assertEquals(lines[0].text, "Ashish Vaswani\u2217");
});

Deno.test("assembleLine splits grid rows into cells at large gaps", () => {
  // 著者グリッドの1行: 名前と名前の間に大きい余白がある
  const lines = buildLines([
    item("Ashish Vaswani", 132, 700, 10),
    item("Noam Shazeer", 239, 700, 10),
    item("Niki Parmar", 338, 700, 10),
  ]);
  assertEquals(lines.length, 1);
  const cells = lines[0].cells ?? [];
  assertEquals(cells.length, 3);
  assertEquals(cells[0].text, "Ashish Vaswani");
  assertEquals(cells[1].text, "Noam Shazeer");
  assertEquals(cells[2].text, "Niki Parmar");
});

Deno.test("analyzePage keeps grid cells as separate blocks", () => {
  const page: ExtractedPage = {
    pageNumber: 1,
    width: 612,
    height: 792,
    items: [
      item("Ashish Vaswani", 132, 700, 10),
      item("Noam Shazeer", 239, 700, 10),
      item("Google Brain", 139, 685, 10),
      item("Google Brain", 242, 685, 10),
      item(
        "Body text line one of a normal paragraph flows here",
        72,
        650,
        10,
      ),
      item(
        "Body text line two continues the same paragraph ok",
        72,
        635,
        10,
      ),
    ],
  };
  const layout = analyzePage(page);
  const texts = layout.blocks.map((b) => b.originalText);
  // セルは単独ブロック(名前+所属が1文に連結されない)
  assertEquals(texts.includes("Ashish Vaswani"), true);
  assertEquals(texts.includes("Noam Shazeer"), true);
  assertEquals(texts.includes("Google Brain"), true);
  // 本文は段落として統合される
  const body = texts.find((t) => t.startsWith("Body text line one"));
  assertEquals(body?.includes("line two"), true);
});
