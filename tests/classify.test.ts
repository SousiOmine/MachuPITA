import { assertEquals } from "@std/assert";
import {
  isTranslatable,
  looksLikeFormula,
  protectPlaceholders,
  restorePlaceholders,
} from "../engine/core/classify.ts";

Deno.test("isTranslatable rejects numbers and symbols", () => {
  assertEquals(isTranslatable("12345"), false);
  assertEquals(isTranslatable("[12]"), false);
  assertEquals(isTranslatable("Fig. 3"), true);
});

Deno.test("isTranslatable rejects URLs and DOIs", () => {
  assertEquals(isTranslatable("https://example.com/path"), false);
  assertEquals(isTranslatable("10.1234/abcd.5678"), false);
});

Deno.test("isTranslatable accepts normal sentences", () => {
  assertEquals(
    isTranslatable(
      "Deep neural networks have revolutionized natural language processing.",
    ),
    true,
  );
  assertEquals(isTranslatable("これは日本語の段落です。"), true);
});

Deno.test("placeholder protection round-trips citations and urls", () => {
  const source =
    "As shown in [12] and [3, 4], see https://example.com/a and (Smith et al., 2020).";
  const { text, tokens } = protectPlaceholders(source);
  for (let i = 0; i < tokens.length; i++) {
    assertEquals(text.includes(`[[M${i}]]`), true);
  }
  // simulate a translation that keeps placeholders in place
  const translated = text.replace(/[^[\]\sM0-9]/g, "x");
  const restored = restorePlaceholders(translated, tokens);
  assertEquals(restored.missingTokens.length, 0);
  for (const token of tokens) {
    assertEquals(restored.text.includes(token), true);
  }
});

Deno.test("restorePlaceholders reports missing tokens", () => {
  const { tokens } = protectPlaceholders("see [7] for details");
  const restored = restorePlaceholders("詳細は参照", tokens);
  assertEquals(restored.missingTokens.length, 1);
});

Deno.test("restorePlaceholders tolerates collapsed placeholder spellings", () => {
  const { tokens } = protectPlaceholders("see [7] for details");
  for (
    const variant of [
      "詳細は参照 [M0]",
      "詳細は参照 ［［Ｍ０］］",
      "詳細は参照 `[[M0]]`",
      "詳細は参照 [[m0]]",
      "詳細は参照 [[M00]]",
    ]
  ) {
    const restored = restorePlaceholders(variant, tokens);
    assertEquals(restored.missingTokens.length, 0, variant);
    assertEquals(restored.text.includes("[7]"), true, variant);
  }
});

Deno.test("restorePlaceholders drops hallucinated placeholders", () => {
  const { tokens } = protectPlaceholders("see [7] for details");
  const restored = restorePlaceholders("訳 [[M0]] と [[M5]] と [M9]", tokens);
  assertEquals(restored.missingTokens.length, 0);
  assertEquals(restored.text.includes("[7]"), true);
  assertEquals(restored.text.includes("M5"), false);
  assertEquals(restored.text.includes("M9"), false);
});

Deno.test("looksLikeFormula detects equations without sentence enders", () => {
  assertEquals(
    looksLikeFormula("Attention(Q, K, V) = softmax(QK^T / √dk) V (1)"),
    true,
  );
  assertEquals(looksLikeFormula("x = y + z"), true);
  assertEquals(looksLikeFormula("dq · dk = 1"), true);
});

Deno.test("looksLikeFormula keeps sentences and headings translatable", () => {
  assertEquals(
    looksLikeFormula(
      "We compute the matrix of outputs as: Attention(Q, K, V) = softmax(...).",
    ),
    false,
  );
  assertEquals(
    looksLikeFormula("The model achieves 28.4 BLEU on the benchmark."),
    false,
  );
  assertEquals(looksLikeFormula("これは日本語の本文です。"), false);
  assertEquals(looksLikeFormula("1 Introduction"), false);
});

Deno.test("filterVisibleItems drops items matching invisible origins", async () => {
  const { filterVisibleItems } = await import("../engine/core/visibility.ts");
  const items = [
    { str: "visible", x: 100, y: 700, fontSize: 10 },
    { str: "hidden label", x: 108, y: 668.5, fontSize: 19 },
  ];
  const filtered = filterVisibleItems(
    items,
    [{ x: 108.2, y: 668.3 }],
  );
  assertEquals(filtered.length, 1);
  assertEquals(filtered[0].str, "visible");
  // origins が空なら何も落ちない
  assertEquals(filterVisibleItems(items, []).length, 2);
});
