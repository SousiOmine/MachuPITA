import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { parseArgs } from "../cli/run.ts";
import {
  buildProviderItems,
  matchesProviderFilter,
} from "../cli/auth-screen.tsx";
import { buildModelProviderItems } from "../cli/model-screen.tsx";
import { PROJECT_ROOT } from "../engine/settings.ts";
import { createFixturePdf } from "./helpers.ts";

Deno.test("provider filter: 名前とIDの部分一致で絞り込む", () => {
  const p = { id: "anthropic", name: "Anthropic" };
  assert(matchesProviderFilter(p, "ant"));
  assert(matchesProviderFilter(p, "ANTH"));
  assert(matchesProviderFilter(p, "throp"));
  assert(matchesProviderFilter(p, "  ant  "), "前後空白は無視する");
  assert(
    matchesProviderFilter(
      { id: "custom-endpoint", name: "Custom" },
      "endpoint",
    ),
  );
  assert(!matchesProviderFilter(p, "openai"));
  assert(matchesProviderFilter(p, ""), "空クエリは全件一致");
});

Deno.test("provider list: 絞り込み結果の先頭が検索候補になり、戻るは常に末尾", () => {
  const providers = [
    {
      id: "bedrock",
      name: "Amazon Bedrock",
      authType: "api_key" as const,
      configured: false,
    },
    {
      id: "antling",
      name: "Ant Ling",
      authType: "api_key" as const,
      configured: false,
    },
    {
      id: "anthropic",
      name: "Anthropic",
      authType: "api_key" as const,
      configured: true,
    },
  ];
  assertEquals(
    buildProviderItems(providers, "ant").map((i) => i.value),
    ["antling", "anthropic", "__back"],
  );
  const all = buildProviderItems(providers, "");
  assertEquals(all[all.length - 1].value, "__back");
  assertEquals(all.length, providers.length + 1);
  assertEquals(
    buildProviderItems(providers, "zzz").map((i) => i.value),
    ["__back"],
  );
});

Deno.test("model list: 使用中プロバイダにマークが付き、戻るは末尾", () => {
  const providers = [
    { id: "anthropic", name: "Anthropic" },
    { id: "openai", name: "OpenAI" },
  ];
  assertEquals(
    buildModelProviderItems(providers, "openai").map((i) => i.label),
    ["Anthropic", "OpenAI (使用中)", "← 戻る"],
  );
  assertEquals(
    buildModelProviderItems(providers, "").map((i) => i.label),
    ["Anthropic", "OpenAI", "← 戻る"],
  );
});

Deno.test("parseArgs: PDFパスとフラグを解釈する", () => {
  const args = parseArgs([
    "paper.pdf",
    "--lang",
    "en",
    "--format",
    "dual",
    "--out-dir",
    "out",
    "--concurrency",
    "2",
    "--faux",
    "--sidecar",
    "--original",
  ]);
  assertEquals(args.command, "menu");
  assertEquals(args.flags.file, "paper.pdf");
  assertEquals(args.flags.lang, "en");
  assertEquals(args.flags.format, "dual");
  assertEquals(args.flags.outDir, "out");
  assertEquals(args.flags.concurrency, 2);
  assertEquals(args.flags.faux, true);
  assertEquals(args.flags.sidecar, true);
  assertEquals(args.flags.original, true);
});

Deno.test("parseArgs: 引数なしはメニュー、help/auth/model/settings を振り分ける", () => {
  assertEquals(parseArgs([]).command, "menu");
  assertEquals(parseArgs(["--help"]).command, "help");
  assertEquals(parseArgs(["auth"]).command, "auth");
  assertEquals(parseArgs(["model"]).command, "model");
  assertEquals(parseArgs(["settings"]).command, "settings");
});

/** faux モードで main.ts をサブプロセス実行し、成果物ディレクトリを返す。 */
async function runCliTranslate(
  pdfPath: string,
  outDir: string,
  extraArgs: string[],
): Promise<void> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--no-check",
      join(PROJECT_ROOT, "main.ts"),
      pdfPath,
      "--faux",
      "--format",
      "dual",
      "--out-dir",
      outDir,
      ...extraArgs,
    ],
    cwd: PROJECT_ROOT,
    stdin: "null",
    env: { ...Deno.env.toObject(), MACHUPITA_FAUX: "1" },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
  const out = new TextDecoder().decode(stdout);
  assert(out.includes("完了しました"), out);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

async function makeFixture(): Promise<{ pdfPath: string; outDir: string }> {
  const pdfBytes = await createFixturePdf([
    [
      { x: 72, y: 740, text: "CLI Smoke Test Paper", size: 16 },
      {
        x: 72,
        y: 700,
        text: "First paragraph of the fixture document.",
        size: 11,
      },
      {
        x: 72,
        y: 685,
        text: "It contains a couple of sentences here.",
        size: 11,
      },
      {
        x: 72,
        y: 640,
        text: "Second paragraph with more content.",
        size: 11,
      },
    ],
  ]);
  const dir = await Deno.makeTempDir({ prefix: "machupita-cli-test-" });
  const pdfPath = join(dir, "fixture.pdf");
  await Deno.writeFile(pdfPath, pdfBytes);
  return { pdfPath, outDir: join(dir, "out") };
}

Deno.test(
  "CLI translate: デフォルトでは翻訳PDFのみ出力される",
  {
    sanitizeResources: false,
    sanitizeOps: false,
  },
  async () => {
    const { pdfPath, outDir } = await makeFixture();
    await runCliTranslate(pdfPath, outDir, []);

    const monoPath = join(outDir, "fixture_translated.pdf");
    const dualPath = join(outDir, "fixture_bilingual.pdf");
    const sidecarPath = join(outDir, "fixture_sidecar.json");
    const originalPath = join(outDir, "fixture_original.pdf");
    assertExists(monoPath);
    assertExists(dualPath);
    assertFalse(
      await exists(sidecarPath),
      "sidecar はデフォルトでは出力しない",
    );
    assertFalse(
      await exists(originalPath),
      "元PDFはデフォルトでは出力しない",
    );
  },
);

Deno.test(
  "CLI translate: --sidecar / --original で追加成果物も出力される",
  {
    sanitizeResources: false,
    sanitizeOps: false,
  },
  async () => {
    const { pdfPath, outDir } = await makeFixture();
    await runCliTranslate(pdfPath, outDir, ["--sidecar", "--original"]);

    const monoPath = join(outDir, "fixture_translated.pdf");
    const dualPath = join(outDir, "fixture_bilingual.pdf");
    const sidecarPath = join(outDir, "fixture_sidecar.json");
    const originalPath = join(outDir, "fixture_original.pdf");
    assertExists(monoPath);
    assertExists(dualPath);
    assertExists(sidecarPath);
    assertExists(originalPath);

    const sidecar = JSON.parse(await Deno.readTextFile(sidecarPath));
    const blocks = sidecar.pages[0].blocks;
    assert(
      blocks.some(
        (b: { translation?: string }) => b.translation?.startsWith("FAUX:"),
      ),
      "sidecar に FAUX 翻訳が含まれること",
    );
  },
);
