import { assertEquals } from "@std/assert";
import { extractPages } from "../engine/core/extract.ts";
import { analyzePage } from "../engine/core/layout.ts";
import { classifyBlocks } from "../engine/core/classify.ts";
import { buildDualPdf, renderTranslatedPdf } from "../engine/core/render.ts";
import type {
  BatchItem,
  BatchResult,
  Translator,
} from "../engine/core/translate.ts";
import { translateBlocks } from "../engine/core/translate.ts";
import { createFixturePdf } from "./helpers.ts";

async function fontsAvailable(): Promise<boolean> {
  try {
    await Deno.stat("assets/fonts/NotoSansJP-Regular.ttf");
    return true;
  } catch {
    return false;
  }
}

Deno.test(
  "full pipeline: extract -> analyze -> classify -> translate(mock) -> render",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    if (!(await fontsAvailable())) {
      console.log("skip: run deno task setup:fonts first");
      return;
    }
    const fixtureBytes = await createFixturePdf([
      [
        { x: 72, y: 740, text: "A Study on Machine Translation", size: 16 },
        {
          x: 72,
          y: 700,
          text: "This paper studies layout-preserving",
          size: 11,
        },
        {
          x: 72,
          y: 685,
          text: "translation of academic papers using",
          size: 11,
        },
        {
          x: 72,
          y: 670,
          text: "large language models and pdf tools.",
          size: 11,
        },
        {
          x: 72,
          y: 630,
          text: "The second paragraph adds more detail.",
          size: 11,
        },
        { x: 72, y: 590, text: "12345", size: 11 },
      ],
    ]);

    // extract
    const pages = await extractPages(fixtureBytes);
    assertEquals(pages.length, 1);
    const allText = pages[0].items.map((i) => i.str).join(" ");
    assertEquals(allText.includes("layout-preserving"), true);

    // analyze
    const layout = analyzePage(pages[0]);
    const texts = layout.blocks.map((b) => b.originalText);
    assertEquals(
      texts.some((t) => t.includes("layout-preserving translation")),
      true,
    );
    assertEquals(texts.some((t) => t.startsWith("A Study")), true);

    // classify
    classifyBlocks(layout.blocks);
    const numberBlock = layout.blocks.find((b) => b.originalText === "12345");
    assertEquals(numberBlock?.status, "skipped");

    // mock translate with deliberately short output so that everything except
    // a small left-most area of each block must be covered by the white mask
    class MockTranslator implements Translator {
      async translateBatch(items: BatchItem[]): Promise<BatchResult[]> {
        return items.map((i) => ({
          id: i.id,
          translation: "訳",
        }));
      }
      usage() {
        return { input: 10, output: 10, total: 20, costTotal: 0 };
      }
    }
    const translatable = layout.blocks.filter((b) => b.status !== "skipped");
    await translateBlocks(
      translatable,
      new MockTranslator(),
      {
        targetLanguage: "日本語",
        batchSizeChars: 3000,
        concurrency: 2,
      },
      new AbortController().signal,
    );
    assertEquals(
      translatable.every((b) => b.status === "translated"),
      true,
    );

    // render mono
    const mono = await renderTranslatedPdf(fixtureBytes, [layout], {
      maskColor: "#ffffff",
      minFontScale: 0.55,
    });
    assertEquals(mono[0] === 0x25 && mono[1] === 0x50, true); // %PDF

    // re-extract output and confirm translated text present
    const outPages = await extractPages(mono);
    const outText = outPages[0].items.map((i) => i.str).join(" ");
    assertEquals(outText.includes("訳"), true);

    // visual check: the original first body line area must be covered by the
    // white mask (only a tiny translated glyph remains at the left edge), and
    // dark glyph pixels must exist somewhere on the page.
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const { renderPageAsImage } = await import("unpdf");
    const png = await renderPageAsImage(mono.slice(), 1, {
      scale: 2,
      canvasImport: () => import("@napi-rs/canvas"),
    });
    const image = await loadImage(png);
    const canvas = createCanvas(image.width, image.height);
    const ctx2d = canvas.getContext("2d");
    ctx2d.drawImage(image, 0, 0);
    const scale = image.width / 612;
    // original line "This paper studies layout-preserving" baseline y=700;
    // sample right of the short translated glyph (x > 112) up to x=340
    const sampleYTop = Math.floor((792 - 707) * scale);
    const sampleYBottom = Math.floor((792 - 693) * scale);
    let sum = 0;
    let count = 0;
    for (
      let py = sampleYTop;
      py < sampleYBottom;
      py++
    ) {
      for (
        let px = Math.floor(112 * scale);
        px < Math.floor(340 * scale);
        px++
      ) {
        const d = ctx2d.getImageData(px, py, 1, 1).data;
        sum += (d[0] + d[1] + d[2]) / 3;
        count++;
      }
    }
    const meanLuminance = sum / count;
    assertEquals(
      meanLuminance > 250,
      true,
      `mask not applied: ${meanLuminance}`,
    );

    const wholePage = ctx2d.getImageData(0, 0, image.width, image.height).data;
    let darkPixels = 0;
    for (let i = 0; i < wholePage.length; i += 4) {
      if ((wholePage[i] + wholePage[i + 1] + wholePage[i + 2]) / 3 < 100) {
        darkPixels++;
      }
    }
    assertEquals(
      darkPixels > 20,
      true,
      `translated text not drawn: ${darkPixels}`,
    );

    // dual output has twice the pages
    const dual = await buildDualPdf(fixtureBytes, mono);
    const dualPages = await extractPages(dual);
    assertEquals(dualPages.length, 2);
    const dualText = dualPages.map((p) => p.items.map((i) => i.str).join(" "))
      .join("\n");
    assertEquals(dualText.includes("layout-preserving"), true);
    assertEquals(dualText.includes("訳"), true);
  },
);
