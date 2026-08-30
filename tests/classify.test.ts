import { assertEquals } from "@std/assert";
import {
  isTranslatable,
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
