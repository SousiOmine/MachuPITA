import { useEffect, useRef, useState } from "react";
import {
  Box,
  ProgressBar,
  SelectInput,
  Spinner,
  Text,
  TextInput,
  useApp,
  useInput,
} from "@deno-ink/core";
import type { SelectInputItem } from "@deno-ink/core";
import { basename } from "@std/path";
import { LANGUAGE_PRESETS } from "../engine/settings.ts";
import type { OutputFormat } from "../engine/settings.ts";
import type { JobOptionsPayload, JobSnapshot } from "../engine/jobs.ts";
import type { AppCtx } from "./context.ts";
import {
  copyArtifacts,
  resolveModelMode,
  startTranslate,
} from "./translate.ts";
import type {
  TranslateHandle,
  TranslateRequest,
  TranslateResult,
  TranslatorMode,
} from "./translate.ts";
import type { CliOutcome } from "./app.tsx";

// ---------------------------------------------------------------------------
// 翻訳セットアップ (対話メニュー用ウィザード)
// ---------------------------------------------------------------------------

export function TranslateSetupScreen({
  ctx,
  initialFile,
  onBack,
  onStart,
}: {
  ctx: AppCtx;
  initialFile?: string;
  onBack: () => void;
  onStart: (request: TranslateRequest, mode: TranslatorMode) => void;
}) {
  const [notice, setNotice] = useState("");
  const [step, setStep] = useState<
    "file" | "lang" | "free" | "format" | "confirm"
  >("file");
  const [filePath, setFilePath] = useState(initialFile ?? "");
  const [lang, setLang] = useState("ja");
  const [freeText, setFreeText] = useState("");
  const [format, setFormat] = useState<OutputFormat>("mono");

  // 対話ウィザードの初期値をアプリ設定(settings.json)から引き継ぐ。
  // 毎回 "ja" から始めるのではなく、前回の翻訳先を既定に使う。
  useEffect(() => {
    let cancelled = false;
    void ctx.settings.get().then((s) => {
      if (cancelled) return;
      if (s.targetLanguage === "free") {
        setLang("free");
        setFreeText(s.targetLanguageFree ?? "");
      } else if (LANGUAGE_PRESETS.some((l) => l.code === s.targetLanguage)) {
        setLang(s.targetLanguage);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [ctx]);

  // 最初のステップで Esc → メニューへ戻る
  useInput((_input, key) => {
    if (key.escape && step === "file") onBack();
  });

  if (step === "file") {
    return (
      <Box flexDirection="column">
        <Text bold>翻訳する PDF のパスを入力</Text>
        <TextInput
          value={filePath}
          onChange={setFilePath}
          placeholder="例: paper.pdf"
          onSubmit={(value) => {
            if (!value.trim()) {
              setNotice("ファイルパスを入力してください");
              return;
            }
            setNotice("");
            setStep("lang");
          }}
        />
        <Text dimColor>Enter で次へ、Esc で戻る</Text>
        {notice && <Text color="yellow">{notice}</Text>}
      </Box>
    );
  }

  if (step === "lang") {
    const items: SelectInputItem<string>[] = [
      ...LANGUAGE_PRESETS.map((l) => ({ label: l.label, value: l.code })),
      { label: "自由記述", value: "free" },
      { label: "← 戻る", value: "__back" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>翻訳先言語を選択</Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__back") {
              setStep("file");
            } else if (item.value === "free") {
              setLang("free");
              setStep("free");
            } else {
              setLang(item.value);
              setStep("format");
            }
          }}
        />
        <Text dimColor>Esc で戻る</Text>
      </Box>
    );
  }

  if (step === "free") {
    return (
      <Box flexDirection="column">
        <Text bold>翻訳の指示を自由記述</Text>
        <TextInput
          value={freeText}
          onChange={setFreeText}
          placeholder="例: ビジネス文書調の中国語"
          onSubmit={(value) => {
            setFreeText(value);
            setStep("format");
          }}
        />
        <Text dimColor>Enter で次へ、Esc で戻る</Text>
      </Box>
    );
  }

  if (step === "format") {
    const items: SelectInputItem<"mono" | "dual" | "__back">[] = [
      { label: "翻訳のみ", value: "mono" },
      { label: "交互バイリンガル", value: "dual" },
      { label: "← 戻る", value: "__back" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>出力形式を選択</Text>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__back") {
              setStep(lang === "free" ? "free" : "lang");
            } else {
              setFormat(item.value);
              setStep("confirm");
            }
          }}
        />
        <Text dimColor>Esc で戻る</Text>
      </Box>
    );
  }

  const langDesc = lang === "free"
    ? freeText
    : LANGUAGE_PRESETS.find((l) => l.code === lang)?.label ?? lang;
  const items: SelectInputItem<"run" | "back">[] = [
    { label: "実行", value: "run" },
    { label: "← 戻る", value: "back" },
  ];
  return (
    <Box flexDirection="column">
      <Text bold>実行内容の確認</Text>
      <Text>PDF: {filePath}</Text>
      <Text>翻訳先: {langDesc}</Text>
      <Text>
        出力形式: {format === "dual" ? "交互バイリンガル" : "翻訳のみ"}
      </Text>
      <SelectInput
        items={items}
        onSelect={async (item) => {
          if (item.value === "back") {
            setStep("format");
            return;
          }
          try {
            const bytes = await Deno.readFile(filePath);
            const s = await ctx.settings.get();
            const options: JobOptionsPayload = {
              targetLanguage: lang === "free" ? "free" : lang,
              targetLanguageFree: lang === "free" ? freeText : undefined,
              outputFormat: format,
              concurrency: s.concurrency,
              batchSizeChars: s.batchSizeChars,
              maskColor: s.maskColor,
              minFontScale: s.minFontScale,
            };
            const mode = resolveModelMode(ctx, s);
            if (!mode.ok) {
              setNotice(mode.message);
              return;
            }
            onStart(
              {
                fileName: basename(filePath),
                bytes,
                options,
                outDir: ".",
              },
              mode.mode,
            );
          } catch (err) {
            setNotice(
              `ファイルを開けません: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }}
      />
      {notice && <Text color="yellow">{notice}</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// 進捗表示
// ---------------------------------------------------------------------------

const STAGE_LABEL: Record<string, string> = {
  queued: "待機中",
  extracting: "テキスト抽出中",
  analyzing: "レイアウト解析中",
  glossary: "用語集抽出中",
  translating: "翻訳中",
  rendering: "描画中",
  done: "完了",
  error: "エラー",
  cancelled: "中止",
};

export function ProgressScreen({
  ctx,
  request,
  mode,
  autoExit,
  outcome,
  onBack,
}: {
  ctx: AppCtx;
  request: TranslateRequest;
  mode: TranslatorMode;
  autoExit: boolean;
  outcome: CliOutcome;
  onBack: () => void;
}) {
  const { exit } = useApp();
  const [snap, setSnap] = useState<JobSnapshot | null>(null);
  const [artifacts, setArtifacts] = useState<TranslateResult | null>(null);
  const [finished, setFinished] = useState(false);
  const handleRef = useRef<TranslateHandle | null>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    const handle = startTranslate(ctx, request, mode);
    handleRef.current = handle;
    const unsub = handle.subscribe((event) => {
      const s = handle.snapshot();
      setSnap(s ? { ...s } : null);
      if (finishedRef.current) return;
      if (event.type === "done") {
        finishedRef.current = true;
        void copyArtifacts(ctx, handle, request.outDir, request.artifacts)
          .then((paths) => {
            setArtifacts(paths);
            outcome.status = "done";
            outcome.artifacts = paths;
            setFinished(true);
          });
      } else if (event.type === "error") {
        finishedRef.current = true;
        outcome.status = "error";
        outcome.error = String(event.payload ?? "不明なエラー");
        setFinished(true);
      } else if (event.type === "cancelled") {
        finishedRef.current = true;
        outcome.status = "cancelled";
        setFinished(true);
      }
    });
    return unsub;
  }, []);

  // q キーでジョブを中止
  useInput((input) => {
    if (input === "q" && !finishedRef.current) {
      handleRef.current?.cancel();
    }
  });

  // 自動終了モード: 完了したら end して終了 (サマリは run.ts が出力)
  useEffect(() => {
    if (!finished || !autoExit) return;
    const t = setTimeout(() => exit(), 150);
    return () => clearTimeout(t);
  }, [finished, autoExit]);

  const stage = snap?.stage ?? "queued";
  const done = finished || snap?.stage === "done";

  return (
    <Box flexDirection="column">
      <Text bold>ステージ: {STAGE_LABEL[stage] ?? stage}</Text>
      {!finished && (
        <Box flexDirection="row" alignItems="center">
          <Spinner />
          <Box marginLeft={1}>
            <Text dimColor>処理中... q キーで中止</Text>
          </Box>
        </Box>
      )}
      {snap && snap.totalPages > 0 && snap.pagesExtracted > 0 && (
        <Box flexDirection="column">
          <Text>ページ: {snap.pagesExtracted} / {snap.totalPages}</Text>
          <ProgressBar
            value={snap.pagesExtracted}
            maxValue={snap.totalPages}
            width={40}
          />
        </Box>
      )}
      {snap && snap.blocksTotal > 0 && (
        <Text>
          段落: {snap.blocksTranslated} / {snap.blocksTotal} 翻訳済み
          {snap.blocksFailed > 0 ? ` (失敗 ${snap.blocksFailed})` : ""}
        </Text>
      )}
      {snap && snap.usage.total > 0 && (
        <Text dimColor>
          tokens: in {snap.usage.input} / out {snap.usage.output} / total{" "}
          {snap.usage.total}
          {snap.usage.costTotal > 0
            ? ` (${snap.usage.costTotal.toFixed(4)} USD)`
            : ""}
        </Text>
      )}
      {snap && snap.warnings.length > 0 && (
        <Box flexDirection="column">
          <Text color="yellow">警告:</Text>
          {snap.warnings.slice(0, 5).map((w, i) => (
            <Text key={i} dimColor>{w}</Text>
          ))}
        </Box>
      )}
      {artifacts && (
        <Box flexDirection="column">
          <Text color="green" bold>成果物:</Text>
          {Object.entries(artifacts).map(([k, v]) => <Text key={k}>{v}</Text>)}
        </Box>
      )}
      {finished && outcome.status === "error" && (
        <Text color="red" bold>エラー: {outcome.error}</Text>
      )}
      {finished && outcome.status === "cancelled" && (
        <Text color="yellow" bold>中止されました。</Text>
      )}
      {done && !autoExit && (
        <SelectInput
          items={[{ label: "メニューに戻る", value: "back" as const }]}
          onSelect={() => onBack()}
        />
      )}
    </Box>
  );
}
