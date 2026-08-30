import { basename, resolve } from "@std/path";
import React from "react";
import { render } from "@deno-ink/core";
import { App } from "./app.tsx";
import type { CliOutcome, Screen } from "./app.tsx";
import type { AppCtx } from "./context.ts";
import { buildSummary, resolveModelMode } from "./translate.ts";
import type { TranslateRequest } from "./translate.ts";
import { JobManager } from "../engine/jobs.ts";
import type { JobOptionsPayload } from "../engine/jobs.ts";
import { PiaiService } from "../engine/piai/service.ts";
import { resolveAppPaths, SettingsStore } from "../engine/settings.ts";
import type { Settings } from "../engine/settings.ts";

export interface TranslateCliFlags {
  file?: string;
  lang?: string;
  langFree?: string;
  format?: "mono" | "dual";
  outDir?: string;
  concurrency?: number;
  batchSizeChars?: number;
  maskColor?: string;
  minFontScale?: number;
  provider?: string;
  model?: string;
  faux?: boolean;
  sidecar?: boolean;
  original?: boolean;
}

export type CliCommand = "menu" | "auth" | "model" | "settings" | "help";

export interface CliArgs {
  command: CliCommand;
  flags: TranslateCliFlags;
}

export function parseArgs(argv: string[]): CliArgs {
  const flags: TranslateCliFlags = {};
  let command: CliCommand = "menu";
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "help":
      case "--help":
      case "-h":
        command = "help";
        break;
      case "auth":
        command = "auth";
        break;
      case "model":
        command = "model";
        break;
      case "settings":
        command = "settings";
        break;
      case "--faux":
        flags.faux = true;
        break;
      case "--sidecar":
        flags.sidecar = true;
        break;
      case "--original":
        flags.original = true;
        break;
      default:
        if (a.startsWith("-")) {
          const val = argv[i + 1];
          if (val === undefined) break;
          switch (a) {
            case "--lang":
              flags.lang = val;
              i++;
              break;
            case "--lang-free":
              flags.langFree = val;
              i++;
              break;
            case "--format":
              if (val === "mono" || val === "dual") {
                flags.format = val;
                i++;
              }
              break;
            case "--out-dir":
              flags.outDir = val;
              i++;
              break;
            case "--concurrency":
              flags.concurrency = Number(val);
              i++;
              break;
            case "--batch-size":
              flags.batchSizeChars = Number(val);
              i++;
              break;
            case "--mask-color":
              flags.maskColor = val;
              i++;
              break;
            case "--min-font-scale":
              flags.minFontScale = Number(val);
              i++;
              break;
            case "--provider":
              flags.provider = val;
              i++;
              break;
            case "--model":
              flags.model = val;
              i++;
              break;
          }
        } else {
          positional.push(a);
        }
    }
  }
  if (!flags.file && positional.length > 0) flags.file = positional[0];
  return { command, flags };
}

export const HELP_TEXT = `MachuPITA — 論文PDFをレイアウトを保ったまま翻訳するCLI

使い方:
  machupita                      対話メニュー (翻訳 / 認証 / モデル選択 / 設定)
  machupita auth                 プロバイダ認証 (APIキー入力 / OAuth ログイン / 解除)
  machupita model                モデル選択 (認証済みプロバイダから選択)
  machupita settings             既定設定の表示・変更
  machupita <PDF> [options]      PDF翻訳を実行 (未指定の設定は既定値を使用)
  machupita --help               このヘルプを表示

翻訳 options:
  --lang <code>         翻訳先 (プリセット: ja, en, zh-CN, zh-TW, ko, de, fr, es, pt, it, ru)
  --lang-free <text>    自由記述の翻訳指示 (例: ビジネス文書調の中国語)
  --format <mono|dual>  出力形式 (mono: 翻訳のみ / dual: 交互バイリンガル)
  --out-dir <dir>       成果物の出力先 (既定: カレントディレクトリ)
  --concurrency <n>     翻訳の同時実行数 (既定: 設定値)
  --batch-size <n>      1リクエストあたりの文字数予算 (既定: 設定値)
  --mask-color <color>  原文のマスク色 (既定: 設定値)
  --min-font-scale <n>  フォント縮小の下限 (既定: 設定値)
  --provider <id>       使用プロバイダ (既定: 設定値)
  --model <id>          使用モデル (既定: 設定値)
  --faux                LLMを使わずダミー翻訳で動作確認 (MACHUPITA_FAUX=1 と同等)
  --sidecar             段落対応JSON (sidecar) も出力
  --original            元PDFのコピーも出力

出力されるファイルは既定で {名前}_translated.pdf のみです (出力形式が dual なら {名前}_bilingual.pdf も生成)。

環境変数:
  MACHUPITA_FAUX=1        LLMを使わず FAUX: 接頭辞のダミー翻訳を流し込む

データはアプリデータディレクトリ配下に保存されます (settings.json / auth.json)。`;

export function buildOptions(
  settings: Settings,
  flags: TranslateCliFlags,
): JobOptionsPayload {
  return {
    targetLanguage: flags.langFree
      ? "free"
      : flags.lang ?? settings.targetLanguage,
    targetLanguageFree: flags.langFree ?? settings.targetLanguageFree,
    outputFormat: flags.format ?? settings.outputFormat,
    concurrency: flags.concurrency ?? settings.concurrency,
    batchSizeChars: flags.batchSizeChars ?? settings.batchSizeChars,
    maskColor: flags.maskColor ?? settings.maskColor,
    minFontScale: flags.minFontScale ?? settings.minFontScale,
  };
}

export async function runCli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.command === "help") {
    console.log(HELP_TEXT);
    return;
  }

  const paths = resolveAppPaths();
  await Deno.mkdir(paths.dataDir, { recursive: true });
  const ctx: AppCtx = {
    settings: new SettingsStore(paths),
    piai: new PiaiService(paths.dataDir),
    jobs: new JobManager(),
    paths,
    faux: Deno.env.get("MACHUPITA_FAUX") === "1" || args.flags.faux === true,
  };
  ctx.jobs.cleanupStale();

  const outcome: CliOutcome = { status: "running" };
  let initial: Screen = { kind: "menu" };
  let autoExit = false;

  if (args.command === "auth") {
    initial = { kind: "auth" };
  } else if (args.command === "model") {
    initial = { kind: "model" };
  } else if (args.command === "settings") {
    initial = { kind: "settings" };
  } else if (args.flags.file) {
    autoExit = true;
    const file = args.flags.file;
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(file);
    } catch (err) {
      console.error(
        `ファイルを開けません: ${file} (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      Deno.exit(2);
    }
    const settings = await ctx.settings.get();
    const mode = resolveModelMode(
      ctx,
      settings,
      args.flags.provider,
      args.flags.model,
    );
    if (!mode.ok) {
      console.error(mode.message);
      Deno.exit(2);
    }
    const request: TranslateRequest = {
      fileName: basename(file),
      bytes,
      options: buildOptions(settings, args.flags),
      outDir: resolve(args.flags.outDir ?? "."),
      artifacts: {
        sidecar: args.flags.sidecar === true,
        original: args.flags.original === true,
      },
    };
    initial = { kind: "progress", request, mode: mode.mode };
  }

  const { waitUntilExit } = await render(
    React.createElement(App, { ctx, initial, autoExit, outcome }),
  );
  await waitUntilExit();

  if (!autoExit) Deno.exit(0);
  if (outcome.status === "done") {
    console.log(buildSummary(outcome));
    Deno.exit(0);
  }
  if (outcome.status === "error") {
    console.error(`エラー: ${outcome.error ?? "不明なエラー"}`);
  } else if (outcome.status === "cancelled") {
    console.error("中止されました。");
  }
  Deno.exit(1);
}
