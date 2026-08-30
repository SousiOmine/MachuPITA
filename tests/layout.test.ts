import { assertEquals } from "@std/assert";
import {
  buildLines,
  detectColumns,
  groupParagraphs,
} from "../engine/core/layout.ts";
import type { LineBox, TextItemBox } from "../engine/core/types.ts";

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
