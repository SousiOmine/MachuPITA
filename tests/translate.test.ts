import { assertEquals } from "@std/assert";
import {
  type BatchItem,
  type BatchResult,
  parseBatchResponse,
  translateBlocks,
  type Translator,
} from "../engine/core/translate.ts";
import type { Block } from "../engine/core/types.ts";

Deno.test("parseBatchResponse extracts JSON array from noisy output", () => {
  const raw =
    'Here is the translation:\n[{"id":"b1","translation":"こんにちは"}]\nDone.';
  const result = parseBatchResponse(raw, [{ id: "b1", text: "hello" }]);
  assertEquals(result.length, 1);
  assertEquals(result[0].translation, "こんにちは");
});

Deno.test("parseBatchResponse throws without array", () => {
  let threw = false;
  try {
    parseBatchResponse("no json here", [{ id: "b1", text: "hello" }]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

function makeBlock(id: string, text: string): Block {
  return {
    id,
    page: 1,
    columnIndex: 0,
    x0: 72,
    y0: 700,
    x1: 500,
    y1: 715,
    text,
    originalText: text,
    status: "pending",
    fontSize: 11,
    bold: false,
    centered: false,
    kind: "body",
  };
}

class MockTranslator implements Translator {
  calls = 0;
  #failFirst = new Set<string>();
  usageTotals = { input: 0, output: 0, total: 0, costTotal: 0 };

  constructor(failIdsOnFirstCall: string[] = []) {
    this.#failFirst = new Set(failIdsOnFirstCall);
  }

  async translateBatch(
    items: BatchItem[],
    _signal: AbortSignal,
  ): Promise<BatchResult[]> {
    this.calls++;
    return items.map((item) => {
      if (this.#failFirst.has(item.id) && this.calls === 1) {
        return { id: item.id, translation: "" };
      }
      const withPlaceholders = item.text.replace(
        /\[\[M\d+\]\]/g,
        (m) => m,
      );
      return { id: item.id, translation: `訳:${withPlaceholders}` };
    }).filter((r) => r.translation !== "");
  }

  usage() {
    return this.usageTotals;
  }
}

Deno.test("translateBlocks fills translations and preserves placeholders", async () => {
  const blocks = [
    makeBlock("b1", "The model achieves state of the art results [12]."),
    makeBlock("b2", "Second paragraph about evaluation metrics."),
  ];
  const translator = new MockTranslator();
  await translateBlocks(
    blocks,
    translator,
    {
      targetLanguage: "日本語",
      batchSizeChars: 3000,
      concurrency: 2,
    },
    new AbortController().signal,
  );
  assertEquals(blocks[0].status, "translated");
  assertEquals(blocks[0].translation?.includes("[12]"), true);
  assertEquals(blocks[0].translation?.startsWith("訳:"), true);
  assertEquals(blocks[1].status, "translated");
});

Deno.test("translateBlocks falls back to original on persistent failure", async () => {
  const blocks = [makeBlock("bad", "This block always fails to translate.")];
  class AlwaysFailing implements Translator {
    async translateBatch(): Promise<BatchResult[]> {
      throw new Error("LLM exploded");
    }
    usage() {
      return { input: 0, output: 0, total: 0, costTotal: 0 };
    }
  }
  await translateBlocks(
    blocks,
    new AlwaysFailing(),
    {
      targetLanguage: "ja",
      batchSizeChars: 100,
      concurrency: 1,
    },
    new AbortController().signal,
    {},
    2,
  );
  assertEquals(blocks[0].status, "failed");
  assertEquals(blocks[0].translation, undefined);
});
