import { assertEquals } from "@std/assert";
import { extractPages } from "../engine/core/extract.ts";
import { createFixturePdf } from "./helpers.ts";

Deno.test("extract: 太字フォントの太字フラグと実フォント名を取り出す", async () => {
  const bytes = await createFixturePdf([
    [
      { x: 72, y: 740, text: "Bold Heading", size: 18, font: "bold" },
      { x: 72, y: 700, text: "Regular body text", size: 11 },
    ],
  ]);
  const pages = await extractPages(bytes);
  assertEquals(pages.length, 1);

  const heading = pages[0].items.find((i) => i.str.includes("Bold Heading"));
  const body = pages[0].items.find((i) => i.str.includes("Regular body"));
  assertEquals(heading?.bold, true);
  assertEquals(body?.bold, false);
});
