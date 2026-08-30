import { assert, assertEquals, assertExists, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { ArgParseError, parseArgs } from "../cli/run.ts";
import { matchesNameOrId } from "../cli/filter.ts";
import { buildSummary } from "../cli/translate.ts";
import { PROJECT_ROOT } from "../engine/settings.ts";
import { createFixturePdf } from "./helpers.ts";

Deno.test("filter: 名前とIDの部分一致で絞り込む", () => {
  const p = { id: "anthropic", name: "Anthropic" };
  assert(matchesNameOrId(p, "ant"));
  assert(matchesNameOrId(p, "ANTH"));
  assert(matchesNameOrId(p, "throp"));
  assert(matchesNameOrId(p, "  ant  "), "前後空白は無視する");
  assert(
    matchesNameOrId({ id: "custom-endpoint", name: "Custom" }, "endpoint"),
    "IDでも引ける",
  );
  assert(matchesNameOrId({ id: "gpt-4o", name: "GPT-4o" }, "gpt-4o"));
  assert(!matchesNameOrId(p, "openai"));
  assert(matchesNameOrId(p, ""), "空クエリは全件一致");
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

Deno.test("parseArgs: 不正な数値・形式・不明オプションは ArgParseError", () => {
  const cases: string[][] = [
    ["paper.pdf", "--concurrency", "abc"],
    ["paper.pdf", "--concurrency", "0"],
    ["paper.pdf", "--concurrency", "2.5"],
    ["paper.pdf", "--batch-size", "50"],
    ["paper.pdf", "--min-font-scale", "2"],
    ["paper.pdf", "--min-font-scale", "0"],
    ["paper.pdf", "--mask-color", "ffffff"],
    ["paper.pdf", "--format", "triple"],
    ["paper.pdf", "--unknown"],
    ["paper.pdf", "--lang"],
  ];
  for (const argv of cases) {
    let threw = false;
    try {
      parseArgs(argv);
    } catch (err) {
      threw = err instanceof ArgParseError;
    }
    assert(threw, `should throw ArgParseError for: ${argv.join(" ")}`);
  }
});

Deno.test("parseArgs: 正当なマスク色・フォント縮小は受け付ける", () => {
  const args = parseArgs([
    "paper.pdf",
    "--mask-color",
    "#abcdef",
    "--min-font-scale",
    "0.55",
  ]);
  assertEquals(args.flags.maskColor, "#abcdef");
  assertEquals(args.flags.minFontScale, 0.55);
});

Deno.test("buildSummary: 成果物パスとエラー・中止を整形する", () => {
  const done = buildSummary({
    status: "done",
    artifacts: {
      mono: "/tmp/out/a_translated.pdf",
      dual: "/tmp/out/a_bilingual.pdf",
      sidecar: "/tmp/out/a_sidecar.json",
      original: "/tmp/out/a_original.pdf",
    },
  });
  assert(done.includes("/tmp/out/a_translated.pdf"));
  assert(done.includes("/tmp/out/a_bilingual.pdf"));
  assert(done.includes("/tmp/out/a_sidecar.json"));
  assert(done.includes("/tmp/out/a_original.pdf"));

  assertEquals(
    buildSummary({ status: "error", error: "boom" }),
    "エラー: boom",
  );
  assertEquals(buildSummary({ status: "cancelled" }), "中止されました。");
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
