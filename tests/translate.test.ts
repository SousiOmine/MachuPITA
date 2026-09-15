import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { buildGlossarySystemPrompt } from "../engine/core/glossary.ts";
import {
  buildSystemPrompt,
  buildTranslationUserPrompt,
  type GlossaryCapable,
  isGlossaryCapable,
  isJapaneseTarget,
  parseTranslationResponse,
  PiTranslator,
  translateBlocks,
  type Translator,
} from "../engine/core/translate.ts";
import type { Block } from "../engine/core/types.ts";

Deno.test("parseTranslationResponse extracts the block from noisy output", () => {
  const raw = "Here you are:\n\n<translated>こんにちは</translated>\n";
  assertEquals(parseTranslationResponse(raw), "こんにちは");
});

Deno.test("parseTranslationResponse skips empty blocks and throws without one", () => {
  assertEquals(
    parseTranslationResponse(
      "<translated>  </translated>\n<translated>訳文</translated>",
    ),
    "訳文",
  );
  assertThrows(
    () => parseTranslationResponse("no tags here"),
    Error,
    "no <translated> block",
  );
});

Deno.test("parseTranslationResponse tolerates fences, chatter and attributes", () => {
  const cases: Array<[string, string]> = [
    ["```xml\n<translated>訳文A</translated>\n```", "訳文A"],
    ["Sure!\n<translated>\n  訳文 B  \n</translated>\nHope this helps.", "訳文 B"],
    ["<translated>訳文C</translated>", "訳文C"],
    ["<target>source</target>\n<translated>訳文D</translated>", "訳文D"],
    ["<translated>\r\n訳文E\r\n</translated>", "訳文E"],
    ['<translated lang="ja">訳文F</translated>', "訳文F"],
    ["<TRANSLATED>訳文G</TRANSLATED>", "訳文G"],
  ];
  for (const [raw, expected] of cases) {
    assertEquals(parseTranslationResponse(raw), expected, raw);
  }
});

Deno.test("parseTranslationResponse rejects responses without a usable block", () => {
  for (
    const raw of [
      "ok",
      "<translated>訳文",
      "<translated></translated>",
      "<target>原文</target>",
    ]
  ) {
    assertThrows(() => parseTranslationResponse(raw), Error, undefined, raw);
  }
});

Deno.test("buildSystemPrompt: 翻訳者の役割のみを定義する", () => {
  const system = buildSystemPrompt();
  assertEquals(
    system,
    "You are a professional translator of academic papers.",
  );
  // 翻訳対象・出力形式・用語集の指定は user ロール側に置く
  assertEquals(system.includes("<target>"), false);
  assertEquals(system.includes("<translated>"), false);
  assertEquals(system.includes("[[M0]]"), false);
  assertEquals(system.includes("常体"), false);
  assertEquals(system.includes("JSON"), false);
});

Deno.test("buildTranslationUserPrompt: 対象言語とタグ形式を user 側で指定する", () => {
  const user = buildTranslationUserPrompt("We propose a method.", "日本語");
  assert(
    user.startsWith(
      "Translate the text extracted from a PDF academic paper into 日本語.",
    ),
    user,
  );
  assert(user.includes("<translated></translated>"));
  assert(user.includes("<target>\nWe propose a method.\n</target>"));
  // 日本語ターゲット時のみ常体ルールを付与する
  assert(user.includes("常体 (だ・である調)"));
  assert(user.includes("です / ます / でした / ました"));

  const en = buildTranslationUserPrompt("We propose a method.", "English");
  assert(en.startsWith(
    "Translate the text extracted from a PDF academic paper into English.",
  ));
  assertEquals(en.includes("常体"), false);
});

Deno.test("buildTranslationUserPrompt: 用語集を user プロンプトへ埋め込む", () => {
  const glossary = [
    { source: "attention mechanism", target: "注意機構" },
    { source: "MachuPITA", target: "MachuPITA" },
  ];
  const user = buildTranslationUserPrompt("We propose.", "日本語", glossary);
  assert(user.includes("Glossary (MANDATORY)"));
  assert(user.includes("- attention mechanism => 注意機構"));
  assert(user.includes("- MachuPITA => MachuPITA"));
  // 用語集が空ならセクション自体を出さない
  assertEquals(
    buildTranslationUserPrompt("We propose.", "日本語").includes("Glossary"),
    false,
  );
});

Deno.test("PiTranslator: system=役割のみ / user=指示+<target> を送って応答を集計する", async () => {
  const calls: Array<{ system: string; user: string; temperature?: number }> =
    [];
  const models = {
    completeSimple: (
      _model: unknown,
      context: { systemPrompt: string; messages: Array<{ content: string }> },
      options: { temperature?: number },
    ) => {
      calls.push({
        system: context.systemPrompt,
        user: context.messages[0].content,
        temperature: options.temperature,
      });
      const text = calls.length === 1
        ? "前置き\n<translated>訳文 [[M0]] 付き</translated>"
        : '[{"source":"term","target":"訳語"}]';
      return Promise.resolve({
        content: [{ type: "text", text }],
        usage: { input: 1, output: 2, totalTokens: 3, cost: { total: 0.5 } },
        stopReason: "stop",
      });
    },
  } as unknown as Models;
  const translator = new PiTranslator(models, {} as Model<Api>, "日本語", [
    { source: "term", target: "訳語" },
  ]);
  const signal = new AbortController().signal;

  assertEquals(
    await translator.translate("Hello [[M0]].", signal),
    "訳文 [[M0]] 付き",
  );
  assertEquals(calls[0].system, buildSystemPrompt());
  assert(calls[0].user.includes("<target>\nHello [[M0]].\n</target>"));
  assert(calls[0].user.includes("- term => 訳語"));
  assertEquals(calls[0].temperature, 0.2);

  assertEquals(await translator.extractGlossary(["sentence text"], signal), [
    { source: "term", target: "訳語" },
  ]);
  assertEquals(calls[1].system, buildGlossarySystemPrompt());
  assert(calls[1].user.includes('<target>\n["sentence text"]\n</target>'));
  assertEquals(calls[1].temperature, 0);

  assertEquals(translator.usage(), {
    input: 2,
    output: 4,
    total: 6,
    costTotal: 1,
  });
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

/** 原文の前に `訳:` を付けて返すダミー翻訳器。 */
class MockTranslator implements Translator {
  calls = 0;
  #failOnFirstCall: Set<string>;

  constructor(failTextsOnFirstCall: string[] = []) {
    this.#failOnFirstCall = new Set(failTextsOnFirstCall);
  }

  async translate(text: string, _signal: AbortSignal): Promise<string> {
    this.calls++;
    if (this.#failOnFirstCall.has(text) && this.calls === 1) {
      throw new Error("transient failure");
    }
    return `訳:${text}`;
  }

  usage() {
    return { input: 0, output: 0, total: 0, costTotal: 0 };
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
    { concurrency: 2 },
    new AbortController().signal,
  );
  assertEquals(blocks[0].status, "translated");
  assertEquals(blocks[0].translation?.includes("[12]"), true);
  assertEquals(blocks[0].translation?.startsWith("訳:"), true);
  assertEquals(blocks[1].status, "translated");
  assertEquals(translator.calls, 2);
});

Deno.test("translateBlocks retries a transient failure per paragraph", async () => {
  const text = "This paragraph fails on the first request.";
  const blocks = [makeBlock("b1", text)];
  const translator = new MockTranslator([text]);
  await translateBlocks(
    blocks,
    translator,
    { concurrency: 1 },
    new AbortController().signal,
    {},
    2,
    0,
  );
  assertEquals(translator.calls, 2);
  assertEquals(blocks[0].status, "translated");
  assertEquals(blocks[0].translation, `訳:${text}`);
});

Deno.test("translateBlocks falls back to original on persistent failure", async () => {
  const blocks = [makeBlock("bad", "This block always fails to translate.")];
  class AlwaysFailing implements Translator {
    async translate(): Promise<string> {
      throw new Error("LLM exploded");
    }
    usage() {
      return { input: 0, output: 0, total: 0, costTotal: 0 };
    }
  }
  await translateBlocks(
    blocks,
    new AlwaysFailing(),
    { concurrency: 1 },
    new AbortController().signal,
    {},
    2,
    0,
  );
  assertEquals(blocks[0].status, "failed");
  assertEquals(blocks[0].translation, undefined);
  assertEquals(blocks[0].warnings?.length, 1);
  assertEquals(blocks[0].warnings?.[0].includes("LLM exploded"), true);
});

Deno.test("isJapaneseTarget: 日本語ラベル/コードを判定する", () => {
  assertEquals(isJapaneseTarget("日本語"), true);
  assertEquals(isJapaneseTarget("日本語 (学術)"), true);
  assertEquals(isJapaneseTarget("ja"), true);
  assertEquals(isJapaneseTarget("Japanese"), true);
  assertEquals(isJapaneseTarget("English"), false);
  assertEquals(isJapaneseTarget("中文"), false);
});

Deno.test("isGlossaryCapable: 用語集対応の翻訳器のみ true を返す", () => {
  const base: Translator = {
    translate: async () => "",
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

Deno.test("translateBlocks retries placeholder loss and recovers", async () => {
  const blocks = [makeBlock("b1", "Sampled from AISHELL-3 dataset [17].")];
  let calls = 0;
  const translator: Translator = {
    async translate(): Promise<string> {
      calls++;
      return calls === 1 ? "訳文のみ" : "訳文 [[M0]] 付き";
    },
    usage: () => ({ input: 0, output: 0, total: 0, costTotal: 0 }),
  };
  await translateBlocks(
    blocks,
    translator,
    { concurrency: 1 },
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
    async translate(): Promise<string> {
      return "訳文のみ";
    },
    usage: () => ({ input: 0, output: 0, total: 0, costTotal: 0 }),
  };
  await translateBlocks(
    blocks,
    translator,
    { concurrency: 1 },
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
