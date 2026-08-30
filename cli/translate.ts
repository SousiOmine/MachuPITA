import { join } from "@std/path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  buildSystemPrompt,
  FauxEchoTranslator,
  PiTranslator,
} from "../engine/core/translate.ts";
import { resolveTargetLanguageLabel, runPipeline } from "../engine/jobs.ts";
import type {
  JobEvent,
  JobOptionsPayload,
  JobSnapshot,
} from "../engine/jobs.ts";
import type { AppCtx } from "./context.ts";

/** 翻訳エンジンの駆動方式。 */
export type TranslatorMode =
  | { kind: "faux" }
  | { kind: "llm"; model: Model<Api> };

export interface TranslateRequest {
  fileName: string;
  bytes: Uint8Array;
  options: JobOptionsPayload;
  /** 成果物 (PDF / sidecar / 元PDF) の出力先ディレクトリ */
  outDir: string;
  /** 既定では翻訳PDFのみ出力。sidecar / 元PDF は指定時にのみコピー */
  artifacts?: TranslateArtifactSelection;
}

/** 追加成果物の出力指定 (dual PDF は options.outputFormat に従う) */
export interface TranslateArtifactSelection {
  sidecar?: boolean;
  original?: boolean;
}

export interface TranslateResult {
  mono?: string;
  dual?: string;
  sidecar?: string;
  original?: string;
}

export interface TranslateHandle {
  id: string;
  cancel(): void;
  subscribe(cb: (event: JobEvent) => void): () => void;
  snapshot(): JobSnapshot | undefined;
}

/**
 * プロバイダ/モデルの指定と認証状態から翻訳モードを解決する。
 * faux モードでは LLM を必要としない。
 */
export function resolveModelMode(
  ctx: AppCtx,
  settings: { provider: string; model: string },
  providerOverride?: string,
  modelOverride?: string,
): { ok: true; mode: TranslatorMode } | { ok: false; message: string } {
  if (ctx.faux) return { ok: true, mode: { kind: "faux" } };
  const providerId = (providerOverride || settings.provider || "").trim();
  const modelId = (modelOverride || settings.model || "").trim();
  const resolved = ctx.piai.resolveModel(providerId, modelId);
  if (!resolved) {
    return {
      ok: false,
      message:
        "プロバイダまたはモデルが未設定です。auth 画面でプロバイダ認証とモデル選択をしてください。",
    };
  }
  return { ok: true, mode: { kind: "llm", model: resolved } };
}

/** PDF 翻訳ジョブを開始し、進捗購読・キャンセル・スナップショット取得のハンドルを返す。 */
export function startTranslate(
  ctx: AppCtx,
  request: TranslateRequest,
  mode: TranslatorMode,
): TranslateHandle {
  const snapshot = ctx.jobs.create(
    request.fileName,
    request.bytes,
    request.options,
    async (job, signal, emit) => {
      await runPipeline(
        await Deno.makeTempDir({ prefix: "machupita-job-" }),
        job,
        signal,
        emit,
        () =>
          Promise.resolve(
            mode.kind === "faux" ? new FauxEchoTranslator() : new PiTranslator(
              ctx.piai.models(),
              mode.model,
              buildSystemPrompt(
                resolveTargetLanguageLabel(
                  request.options.targetLanguage,
                  request.options.targetLanguageFree,
                ),
              ),
            ),
          ),
      );
    },
  );
  const id = snapshot.id;
  return {
    id,
    cancel: () => void ctx.jobs.cancel(id),
    subscribe: (cb) => ctx.jobs.subscribe(id, cb) ?? (() => {}),
    snapshot: () => ctx.jobs.get(id),
  };
}

/** ジョブ成果物を出力先ディレクトリへコピーし、実パスを返す。 */
export async function copyArtifacts(
  ctx: AppCtx,
  handle: TranslateHandle,
  outDir: string,
  include?: TranslateArtifactSelection,
): Promise<TranslateResult> {
  await Deno.mkdir(outDir, { recursive: true });
  const snap = handle.snapshot();
  if (!snap) return {};
  const base = snap.fileName.replace(/\.[^/.]+$/, "") || "translated";
  const result: TranslateResult = {};
  const kinds = [
    ["mono", `${base}_translated.pdf`],
    ["dual", `${base}_bilingual.pdf`],
    ["sidecar", `${base}_sidecar.json`],
    ["original", `${base}_original.pdf`],
  ] as const;
  for (const [kind, name] of kinds) {
    if (kind === "sidecar" && !include?.sidecar) continue;
    if (kind === "original" && !include?.original) continue;
    const src = ctx.jobs.artifactPath(handle.id, kind);
    if (!src) continue;
    const dest = join(outDir, name);
    await Deno.copyFile(src, dest);
    result[kind] = dest;
  }
  return result;
}

/** 実行結果のサマリ文字列。 */
export function buildSummary(outcome: {
  status: "running" | "done" | "error" | "cancelled";
  error?: string;
  artifacts?: TranslateResult;
}): string {
  if (outcome.status === "error") {
    return `エラー: ${outcome.error ?? "不明なエラー"}`;
  }
  if (outcome.status === "cancelled") {
    return "中止されました。";
  }
  const a = outcome.artifacts;
  const lines = ["完了しました。成果物:"];
  if (a?.mono) lines.push(`  翻訳のみPDF: ${a.mono}`);
  if (a?.dual) lines.push(`  バイリンガルPDF: ${a.dual}`);
  if (a?.sidecar) lines.push(`  sidecar JSON: ${a.sidecar}`);
  if (a?.original) lines.push(`  元PDF: ${a.original}`);
  return lines.join("\n");
}
