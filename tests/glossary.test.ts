import { assertEquals } from "@std/assert";
import {
  appendGlossary,
  buildGlossarySystemPrompt,
  collectGlossaryTexts,
  extractGlossary,
  type GlossaryEntry,
  mergeGlossary,
  parseGlossaryResponse,
  sampleTexts,
} from "../engine/core/glossary.ts";
import { buildSystemPrompt } from "../engine/core/translate.ts";
import type { Block } from "../engine/core/types.ts";

Deno.test("parseGlossaryResponse extracts entries from noisy output", () => {
  const raw =
    'Glossary:\n[{"source":"attention mechanism","target":"注意機構"},{"source":"MachuPITA","target":"MachuPITA"}]\nDone.';
  const entries = parseGlossaryResponse(raw);
  assertEquals(entries.length, 2);
  assertEquals(entries[0], {
    source: "attention mechanism",
    target: "注意機構",
  });
  assertEquals(entries[1], { source: "MachuPITA", target: "MachuPITA" });
});

Deno.test("parseGlossaryResponse drops malformed entries and throws without array", () => {
  assertEquals(
    parseGlossaryResponse('[{"source":"ab"},{"source":"xy","target":"y"}]')
      .length,
    1,
  );
  let threw = false;
  try {
    parseGlossaryResponse("no json");
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("mergeGlossary dedupes case-insensitively with last wins", () => {
  const merged = mergeGlossary([
    [{ source: "Attention", target: "注意" }],
    [{ source: "attention", target: "注意機構" }],
  ]);
  assertEquals(merged.length, 1);
  assertEquals(merged[0].target, "注意機構");
});

Deno.test("appendGlossary embeds entries and keeps base prompt intact", () => {
  const base = buildSystemPrompt("日本語");
  const entries: GlossaryEntry[] = [
    { source: "attention mechanism", target: "注意機構" },
    { source: "MachuPITA", target: "MachuPITA" },
  ];
  const appended = appendGlossary(base, entries);
  assertEquals(appended.startsWith(base), true);
  assertEquals(appended.includes("- attention mechanism => 注意機構"), true);
  assertEquals(appended.includes("- MachuPITA => MachuPITA"), true);
  assertEquals(appendGlossary(base, []), base);
});

Deno.test("extractGlossary chunks texts, calls LLM per chunk and merges", async () => {
  const systemCalls: string[] = [];
  const userCalls: string[][] = [];
  const call = (system: string, user: string, _signal: AbortSignal) => {
    systemCalls.push(system);
    userCalls.push(JSON.parse(user));
    const texts = JSON.parse(user) as string[];
    return Promise.resolve(JSON.stringify(
      texts.map((t) => ({ source: `term ${t.slice(0, 3)}`, target: "訳" })),
    ));
  };
  const entries = await extractGlossary(
    call,
    ["alpha text", "beta text", "gamma text"],
    buildGlossarySystemPrompt("日本語"),
    new AbortController().signal,
  );
  assertEquals(systemCalls[0], buildGlossarySystemPrompt("日本語"));
  assertEquals(userCalls.length, 1);
  assertEquals(entries.length, 3);
});

Deno.test("extractGlossary splits chunks at char budget", async () => {
  const chunkSizes: number[] = [];
  const call = (_system: string, user: string, _signal: AbortSignal) => {
    const texts = JSON.parse(user) as string[];
    chunkSizes.push(texts.reduce((a, t) => a + t.length, 0));
    return Promise.resolve("[]");
  };
  const long = "x".repeat(8000);
  await extractGlossary(
    call,
    [long, long, long],
    "ja",
    new AbortController().signal,
  );
  assertEquals(chunkSizes.length, 3);
  assertEquals(chunkSizes[0], 8000);
});

Deno.test("sampleTexts strides evenly when over budget", () => {
  const texts = Array.from({ length: 10 }, (_, i) => String(i).repeat(100));
  const sampled = sampleTexts(texts, 300);
  assertEquals(sampled.length, 3);
  assertEquals(sampled[0], "0".repeat(100));
  assertEquals(sampled[2], "8".repeat(100));
  assertEquals(sampleTexts(["abc"], 300), ["abc"]);
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

Deno.test("collectGlossaryTexts filters short fragments", () => {
  const texts = collectGlossaryTexts([
    makeBlock("b1", "A recurrent neural network (RNN) processes sequences."),
    makeBlock("b2", "Fig. 1"),
    makeBlock("b3", "  ok  "),
  ]);
  assertEquals(texts.length, 1);
  assertEquals(texts[0].startsWith("A recurrent"), true);
});
