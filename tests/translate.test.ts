import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  type BatchItem,
  type BatchResult,
  buildSystemPrompt,
  type GlossaryCapable,
  isGlossaryCapable,
  isJapaneseTarget,
  normalizeBatchId,
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

Deno.test("isJapaneseTarget: 日本語ラベル/コードを判定する", () => {
  assertEquals(isJapaneseTarget("日本語"), true);
  assertEquals(isJapaneseTarget("日本語 (学術)"), true);
  assertEquals(isJapaneseTarget("ja"), true);
  assertEquals(isJapaneseTarget("Japanese"), true);
  assertEquals(isJapaneseTarget("English"), false);
  assertEquals(isJapaneseTarget("中文"), false);
});

Deno.test("buildSystemPrompt: 日本語ターゲットに常体ルールを追加する", () => {
  const ja = buildSystemPrompt("日本語");
  assertEquals(ja.includes("常体 (だ・である調)"), true);
  assertEquals(ja.includes("です / ます / でした / ました"), true);
  const en = buildSystemPrompt("English");
  assertEquals(en.includes("常体 (だ・である調)"), false);
  // 既存のハードルールは維持される
  assertEquals(ja.includes("a JSON array of objects"), true);
});

Deno.test("isGlossaryCapable: 用語集対応の翻訳器のみ true を返す", () => {
  const base: Translator = {
    translateBatch: async () => [],
    usage: () => ({ input: 0, output: 0, total: 0, costTotal: 0 }),
  };
  assertFalse(isGlossaryCapable(base), "用語集非対応は false");
  const withGlossary: Translator & GlossaryCapable = {
    ...base,
    extractGlossary: async () => [],
    withGlossary: (_entries) => withGlossary,
  };
  assert(isGlossaryCapable(withGlossary), "用語集対応は true");
});

Deno.test("normalizeBatchId: IDの揺れを吸収する", () => {
  assertEquals(normalizeBatchId("p9-11"), "p9-11");
  assertEquals(normalizeBatchId(" P9-11 "), "p9-11");
  assertEquals(normalizeBatchId("p9_11"), "p9-11");
  assertEquals(normalizeBatchId("p9–11"), "p9-11");
  assertEquals(normalizeBatchId("p9 - 11"), "p9-11");
});

Deno.test("parseBatchResponse normalizes ids and dedupes", () => {
  const raw =
    '[{"id":" P9-11 ","translation":"a"},{"id":"p9_4","translation":"b"},{"id":"p9-11","translation":"dup"}]';
  const result = parseBatchResponse(raw, [
    { id: "p9-11", text: "x" },
    { id: "p9-4", text: "y" },
  ]);
  assertEquals(result.length, 2);
  assertEquals(result.find((r) => r.id === "p9-11")?.translation, "a");
  assertEquals(result.find((r) => r.id === "p9-4")?.translation, "b");
});

Deno.test("translateBlocks retries a missing id with a single-item request", async () => {
  const blocks = [
    makeBlock("b1", "First paragraph about Emilia dataset."),
    makeBlock("b2", "Second paragraph about speech generation."),
  ];
  let calls = 0;
  const translator: Translator = {
    async translateBatch(items: BatchItem[]): Promise<BatchResult[]> {
      calls++;
      if (items.length > 1) {
        // 初回バッチでは b2 を欠落させる
        return [{ id: "b1", translation: "訳:b1" }];
      }
      return items.map((i) => ({ id: i.id, translation: `訳:${i.id}` }));
    },
    usage: () => ({ input: 0, output: 0, total: 0, costTotal: 0 }),
  };
  const done: string[] = [];
  await translateBlocks(
    blocks,
    translator,
    { targetLanguage: "日本語", batchSizeChars: 3000, concurrency: 1 },
    new AbortController().signal,
    { onBlockDone: (id) => done.push(id) },
    4,
    0,
  );
  assertEquals(blocks[0].status, "translated");
  assertEquals(blocks[1].status, "translated");
  assertEquals(blocks[1].translation, "訳:b2");
  assert(calls >= 2, `expected retry, got ${calls} calls`);
  assertEquals(done.length, 2);
});

Deno.test("translateBlocks retries placeholder loss and recovers", async () => {
  const blocks = [makeBlock("b1", "Sampled from AISHELL-3 dataset [17].")];
  let calls = 0;
  const translator: Translator = {
    async translateBatch(items: BatchItem[]): Promise<BatchResult[]> {
      calls++;
      if (calls === 1) return [{ id: items[0].id, translation: "訳文のみ" }];
      return [{ id: items[0].id, translation: "訳文 [[M0]] 付き" }];
    },
    usage: () => ({ input: 0, output: 0, total: 0, costTotal: 0 }),
  };
  await translateBlocks(
    blocks,
    translator,
    { targetLanguage: "日本語", batchSizeChars: 3000, concurrency: 1 },
    new AbortController().signal,
    {},
    4,
    0,
  );
  assertEquals(blocks[0].status, "translated");
  assertEquals(blocks[0].translation?.includes("[17]"), true);
  assertEquals(blocks[0].warnings, undefined);
  assert(calls >= 2, `expected retry, got ${calls} calls`);
});

Deno.test("translateBlocks appends persistently missing placeholders at the end", async () => {
  const blocks = [makeBlock("b1", "Sampled from AISHELL-3 dataset [17].")];
  const translator: Translator = {
    async translateBatch(items: BatchItem[]): Promise<BatchResult[]> {
      return items.map((i) => ({ id: i.id, translation: "訳文のみ" }));
    },
    usage: () => ({ input: 0, output: 0, total: 0, costTotal: 0 }),
  };
  await translateBlocks(
    blocks,
    translator,
    { targetLanguage: "日本語", batchSizeChars: 3000, concurrency: 1 },
    new AbortController().signal,
    {},
    2,
    0,
  );
  assertEquals(blocks[0].status, "translated");
  assertEquals(blocks[0].translation?.includes("[17]"), true);
  assertEquals(blocks[0].warnings?.length ?? 0, 1);
  assertEquals(blocks[0].warnings?.[0].includes("文末に補完"), true);
});
