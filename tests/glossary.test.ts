import { assert, assertEquals } from "@std/assert";
import {
  buildGlossarySystemPrompt,
  buildGlossaryUserPrompt,
  collectGlossaryTexts,
  extractGlossary,
  mergeGlossary,
  parseGlossaryResponse,
  sampleTexts,
} from "../engine/core/glossary.ts";
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

Deno.test("buildGlossarySystemPrompt: 用語集作成者の役割のみを定義する", () => {
  const system = buildGlossarySystemPrompt();
  assertEquals(
    system,
    "You are a terminology specialist who builds translation glossaries for academic papers.",
  );
  // 抽出条件・出力形式は user ロール側に置く
  assertEquals(system.includes("<target>"), false);
  assertEquals(system.includes("JSON"), false);
});

Deno.test("buildGlossaryUserPrompt: 対象言語と <target> ブロックを埋め込む", () => {
  const user = buildGlossaryUserPrompt(["alpha text", "beta text"], "日本語");
  assert(
    user.startsWith(
      "Read the text segments sampled from a PDF academic paper, stored as a JSON array inside the <target> tags below, and build a glossary for a translation into 日本語.",
    ),
    user,
  );
  assert(user.includes('{"source": string, "target": string}'));
  assert(user.includes('<target>\n["alpha text","beta text"]\n</target>'));
});

/** user プロンプトの <target> ブロック(セグメントの JSON 配列)を取り出す。 */
function targetBlock(user: string): string[] {
  const match = /<target>\n([\s\S]*?)\n<\/target>/.exec(user);
  if (!match) throw new Error("no <target> block in user prompt");
  return JSON.parse(match[1]) as string[];
}

Deno.test("extractGlossary chunks texts, calls LLM per chunk and merges", async () => {
  const systemCalls: string[] = [];
  const userCalls: string[] = [];
  const call = (system: string, user: string, _signal: AbortSignal) => {
    systemCalls.push(system);
    userCalls.push(user);
    return Promise.resolve(JSON.stringify(
      targetBlock(user).map((t) => ({
        source: `term ${t.slice(0, 3)}`,
        target: "訳",
      })),
    ));
  };
  const texts = ["alpha text", "beta text", "gamma text"];
  const entries = await extractGlossary(
    call,
    texts,
    "日本語",
    new AbortController().signal,
  );
  assertEquals(systemCalls[0], buildGlossarySystemPrompt());
  assertEquals(userCalls.length, 1);
  assertEquals(userCalls[0], buildGlossaryUserPrompt(texts, "日本語"));
  assertEquals(entries.length, 3);
});

Deno.test("extractGlossary splits chunks at char budget", async () => {
  const chunkSizes: number[] = [];
  const call = (_system: string, user: string, _signal: AbortSignal) => {
    chunkSizes.push(targetBlock(user).reduce((a, t) => a + t.length, 0));
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
