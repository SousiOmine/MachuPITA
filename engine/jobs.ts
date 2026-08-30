import { join } from "@std/path";
import { extractPages } from "./core/extract.ts";
import { analyzePage } from "./core/layout.ts";
import { classifyBlocks } from "./core/classify.ts";
import {
  buildSystemPrompt,
  translateBlocks,
  type Translator,
} from "./core/translate.ts";
import {
  type GlossaryEntry,
  collectGlossaryTexts,
} from "./core/glossary.ts";
import { buildDualPdf, renderTranslatedPdf } from "./core/render.ts";
import type { Block, PageLayout, TokenUsageTotals } from "./core/types.ts";
import { LANGUAGE_PRESETS } from "./settings.ts";
import type { OutputFormat } from "./settings.ts";

export type JobStage =
  | "queued"
  | "extracting"
  | "analyzing"
  | "glossary"
  | "translating"
  | "rendering"
  | "done"
  | "error"
  | "cancelled";

export interface JobOptionsPayload {
  targetLanguage: string;
  targetLanguageFree?: string;
  outputFormat: OutputFormat;
  concurrency?: number;
  batchSizeChars?: number;
  maskColor?: string;
  minFontScale?: number;
}

export interface JobSnapshot {
  id: string;
  fileName: string;
  stage: JobStage;
  totalPages: number;
  pagesExtracted: number;
  blocksTotal: number;
  blocksTranslated: number;
  blocksFailed: number;
  /** 文書から抽出された用語集のエントリ数(非対応 Translator は 0) */
  glossarySize: number;
  usage: TokenUsageTotals;
  warnings: string[];
  error?: string;
  createdAt: number;
  finishedAt?: number;
  hasMono: boolean;
  hasDual: boolean;
  outputFormat: OutputFormat;
}

export interface JobEvent {
  type:
    | "snapshot"
    | "stage"
    | "progress"
    | "usage"
    | "warning"
    | "done"
    | "error"
    | "cancelled";
  payload: unknown;
}

interface JobInternals {
  id: string;
  fileName: string;
  dir: string;
  sourceBytes: Uint8Array;
  options: JobOptionsPayload;
  controller: AbortController;
  subscribers: Set<(event: JobEvent) => void>;
  snapshot: JobSnapshot;
  layouts: PageLayout[];
  artifacts: {
    mono?: string;
    dual?: string;
    sidecar?: string;
    original?: string;
  };
}

function emptyUsage(): TokenUsageTotals {
  return { input: 0, output: 0, total: 0, costTotal: 0 };
}

export class JobManager {
  #jobs = new Map<string, JobInternals>();

  cleanupStale(): void {
    // best-effort removal of previous session's job dirs is skipped:
    // OS temp dirs are cleaned by the operating system.
  }

  create(
    fileName: string,
    bytes: Uint8Array,
    options: JobOptionsPayload,
    runner: (
      job: JobInternals,
      signal: AbortSignal,
      emit: (event: JobEvent) => void,
    ) => Promise<void>,
  ): JobSnapshot {
    const id = crypto.randomUUID().slice(0, 8);
    const internals: JobInternals = {
      id,
      fileName,
      dir: "",
      sourceBytes: bytes,
      options,
      controller: new AbortController(),
      subscribers: new Set(),
      layouts: [],
      artifacts: {},
      snapshot: {
        id,
        fileName,
        stage: "queued",
        totalPages: 0,
        pagesExtracted: 0,
        blocksTotal: 0,
        blocksTranslated: 0,
        blocksFailed: 0,
        glossarySize: 0,
        usage: emptyUsage(),
        warnings: [],
        createdAt: Date.now(),
        hasMono: false,
        hasDual: false,
        outputFormat: options.outputFormat,
      },
    };
    this.#jobs.set(id, internals);
    void runner(
      internals,
      internals.controller.signal,
      (event) => this.#emit(internals, event),
    ).catch((err) => {
      const aborted = err instanceof Error && err.name === "AbortError";
      internals.snapshot.stage = aborted ? "cancelled" : "error";
      internals.snapshot.error = aborted
        ? undefined
        : err instanceof Error
        ? err.message
        : String(err);
      internals.snapshot.finishedAt = Date.now();
      this.#emit(internals, {
        type: aborted ? "cancelled" : "error",
        payload: aborted ? null : internals.snapshot.error,
      });
    });
    return this.snapshotOf(internals);
  }

  snapshotOf(job: JobInternals): JobSnapshot {
    return {
      ...job.snapshot,
      warnings: [...job.snapshot.warnings],
      hasMono: Boolean(job.artifacts.mono),
      hasDual: Boolean(job.artifacts.dual),
      usage: { ...job.snapshot.usage },
    };
  }

  get(id: string): JobSnapshot | undefined {
    const job = this.#jobs.get(id);
    return job ? this.snapshotOf(job) : undefined;
  }

  artifactPath(
    id: string,
    kind: "mono" | "dual" | "sidecar" | "original",
  ): string | undefined {
    return this.#jobs.get(id)?.artifacts[kind];
  }

  cancel(id: string): boolean {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (["done", "error", "cancelled"].includes(job.snapshot.stage)) {
      return true;
    }
    job.controller.abort();
    return true;
  }

  subscribe(
    id: string,
    cb: (event: JobEvent) => void,
  ): (() => void) | undefined {
    const job = this.#jobs.get(id);
    if (!job) return undefined;
    job.subscribers.add(cb);
    return () => job.subscribers.delete(cb);
  }

  #emit(job: JobInternals, event: JobEvent): void {
    for (const cb of job.subscribers) {
      try {
        cb(event);
      } catch {
        /* subscriber vanished */
      }
    }
  }
}

export function resolveTargetLanguageLabel(
  code: string,
  freeText?: string,
): string {
  if (freeText && code === "free") return freeText;
  const preset = LANGUAGE_PRESETS.find((l) => l.code === code);
  if (preset) {
    return freeText ? `${preset.label} (${freeText})` : preset.label;
  }
  return code;
}

export function makeTranslatorFactory(
  translatorFactory: () => Promise<Translator>,
) {
  return translatorFactory;
}

export async function runPipeline(
  jobDir: string,
  job: JobInternals,
  signal: AbortSignal,
  emit: (event: JobEvent) => void,
  createTranslator: () => Promise<Translator>,
): Promise<void> {
  await Deno.mkdir(jobDir, { recursive: true });
  job.dir = jobDir;
  const originalPath = join(job.dir, "original.pdf");
  await Deno.writeFile(originalPath, job.sourceBytes);
  job.artifacts.original = originalPath;

  const setStage = (stage: JobStage) => {
    job.snapshot.stage = stage;
    emit({ type: "stage", payload: stage });
  };

  setStage("extracting");
  const extractedPages = await extractPages(job.sourceBytes, (page, total) => {
    job.snapshot.totalPages = total;
    job.snapshot.pagesExtracted = page;
    emit({
      type: "progress",
      payload: { pagesExtracted: page, totalPages: total },
    });
  });
  throwIfAborted(signal);

  setStage("analyzing");
  job.layouts = extractedPages.map((p) => analyzePage(p));
  for (const layout of job.layouts) classifyBlocks(layout.blocks);
  job.snapshot.totalPages = extractedPages.length;
  job.snapshot.pagesExtracted = extractedPages.length;
  const translatable = job.layouts.flatMap((l) =>
    l.blocks.filter((b) => b.status !== "skipped")
  );
  job.snapshot.blocksTotal = translatable.length;
  emit({
    type: "progress",
    payload: {
      blocksTotal: translatable.length,
      totalPages: job.snapshot.totalPages,
      pagesExtracted: job.snapshot.pagesExtracted,
    },
  });

  setStage("glossary");
  const baseTranslator = await createTranslator();
  const { translator, glossary } = await withDocumentGlossary(
    baseTranslator,
    translatable,
    signal,
    (warning) => {
      job.snapshot.warnings.push(warning);
      emit({ type: "warning", payload: warning });
    },
  );
  job.snapshot.glossarySize = glossary.length;

  setStage("translating");
  await translateBlocks(
    translatable,
    translator,
    {
      targetLanguage: resolveTargetLanguageLabel(
        job.options.targetLanguage,
        job.options.targetLanguageFree,
      ),
      batchSizeChars: job.options.batchSizeChars ?? 3000,
      concurrency: job.options.concurrency ?? 3,
    },
    signal,
    {
      onBlockDone: (_id, ok) => {
        if (ok) job.snapshot.blocksTranslated++;
        else job.snapshot.blocksFailed++;
        emit({
          type: "progress",
          payload: {
            blocksTranslated: job.snapshot.blocksTranslated,
            blocksFailed: job.snapshot.blocksFailed,
          },
        });
      },
      onUsage: (usage) => {
        job.snapshot.usage = usage;
        emit({ type: "usage", payload: usage });
      },
    },
  );

  setStage("rendering");
  const monoBytes = await renderTranslatedPdf(job.sourceBytes, job.layouts, {
    maskColor: job.options.maskColor ?? "#ffffff",
    minFontScale: job.options.minFontScale ?? 0.55,
  });
  const monoPath = join(job.dir, "translated.pdf");
  await Deno.writeFile(monoPath, monoBytes);
  job.artifacts.mono = monoPath;

  if (job.options.outputFormat === "dual") {
    const dualBytes = await buildDualPdf(job.sourceBytes, monoBytes);
    const dualPath = join(job.dir, "bilingual.pdf");
    await Deno.writeFile(dualPath, dualBytes);
    job.artifacts.dual = dualPath;
  }

  const sidecar = {
    fileName: job.fileName,
    targetLanguage: resolveTargetLanguageLabel(
      job.options.targetLanguage,
      job.options.targetLanguageFree,
    ),
    generatedAt: new Date().toISOString(),
    glossary: glossary.length > 0
      ? glossary.map((e) => ({ source: e.source, target: e.target }))
      : undefined,
    pages: job.layouts.map((layout) => ({
      pageNumber: layout.pageNumber,
      width: layout.width,
      height: layout.height,
      blocks: layout.blocks.map((b) => ({
        id: b.id,
        page: b.page,
        bbox: { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 },
        original: b.originalText,
        translation: b.translation ?? null,
        status: b.status,
        kind: b.kind,
        fontSize: b.fontSize,
        bold: b.bold,
        centered: b.centered,
        warnings: b.warnings ?? [],
      })),
    })),
  };
  const sidecarPath = join(job.dir, "sidecar.json");
  await Deno.writeTextFile(sidecarPath, JSON.stringify(sidecar));
  job.artifacts.sidecar = sidecarPath;

  for (const block of translatable) {
    for (const warning of block.warnings ?? []) {
      job.snapshot.warnings.push(`${block.id}: ${warning}`);
    }
  }
  if (job.snapshot.warnings.length > 50) {
    job.snapshot.warnings = [
      ...job.snapshot.warnings.slice(0, 50),
      "...",
    ];
  }
  setStage("done");
  job.snapshot.finishedAt = Date.now();
  emit({ type: "done", payload: null });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("aborted", "AbortError");
}

/**
 * 文書から用語集を抽出し、Translator に反映する。
 * 用語抽出に対応しない Translator や抽出失敗時は、翻訳を止めずそのまま続行する。
 */
export async function withDocumentGlossary(
  translator: Translator,
  blocks: Block[],
  signal: AbortSignal,
  warn: (message: string) => void,
): Promise<{ translator: Translator; glossary: GlossaryEntry[] }> {
  if (!translator.extractGlossary || !translator.withGlossary) {
    return { translator, glossary: [] };
  }
  const texts = collectGlossaryTexts(blocks);
  if (texts.length === 0) return { translator, glossary: [] };
  try {
    const glossary = await translator.extractGlossary(texts, signal);
    if (glossary.length === 0) return { translator, glossary: [] };
    return { translator: translator.withGlossary(glossary), glossary };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    warn("用語集の抽出に失敗したためグロッサリなしで翻訳を続行します");
    return { translator, glossary: [] };
  }
}

export function buildPromptFor(options: JobOptionsPayload): string {
  return buildSystemPrompt(
    resolveTargetLanguageLabel(
      options.targetLanguage,
      options.targetLanguageFree,
    ),
  );
}
