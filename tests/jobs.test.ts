import { assertEquals } from "@std/assert";
import { JobManager } from "../engine/jobs.ts";
import type { JobEvent, JobOptionsPayload } from "../engine/jobs.ts";

const OPTIONS: JobOptionsPayload = {
  targetLanguage: "ja",
  outputFormat: "mono",
};

/** stage が期待値になるまでポーリングで待つ。 */
async function waitForStage(
  jobId: string,
  stage: string,
  mgr: JobManager,
  timeout = 2000,
): Promise<void> {
  const start = Date.now();
  while (true) {
    if (mgr.get(jobId)?.stage === stage) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `timeout waiting for stage "${stage}" (got "${mgr.get(jobId)?.stage}")`,
      );
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

Deno.test("JobManager: done まで状態遷移し成果物パスを公開する", async () => {
  const mgr = new JobManager();
  const snap = mgr.create(
    "a.pdf",
    new Uint8Array([1]),
    OPTIONS,
    async (job, _signal, emit) => {
      job.snapshot.stage = "done";
      emit({ type: "stage", payload: "done" });
    },
  );
  assertEquals(snap.stage, "queued");
  await waitForStage(snap.id, "done", mgr);
  const s = mgr.get(snap.id);
  assertEquals(s?.stage, "done");
  assertEquals(s?.hasMono, false);
});

Deno.test("JobManager: runner が throw すると error になる", async () => {
  const mgr = new JobManager();
  const snap = mgr.create(
    "a.pdf",
    new Uint8Array([1]),
    OPTIONS,
    async () => {
      throw new Error("boom");
    },
  );
  await waitForStage(snap.id, "error", mgr);
  assertEquals(mgr.get(snap.id)?.error, "boom");
});

Deno.test("JobManager: AbortError は cancelled になる", async () => {
  const mgr = new JobManager();
  const snap = mgr.create(
    "a.pdf",
    new Uint8Array([1]),
    OPTIONS,
    async (_job, signal) => {
      await new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    },
  );
  assertEquals(mgr.cancel(snap.id), true);
  await waitForStage(snap.id, "cancelled", mgr);
  assertEquals(mgr.get(snap.id)?.stage, "cancelled");
});

Deno.test("JobManager: subscribe した購読者にイベントが届く", async () => {
  const mgr = new JobManager();
  const events: JobEvent[] = [];
  const snap = mgr.create(
    "a.pdf",
    new Uint8Array([1]),
    OPTIONS,
    async (job, _signal, emit) => {
      emit({ type: "warning", payload: "w1" });
      job.snapshot.stage = "done";
      emit({ type: "stage", payload: "done" });
    },
  );
  const unsub = mgr.subscribe(snap.id, (e) => events.push(e));
  await waitForStage(snap.id, "done", mgr);
  unsub?.();
  assertEquals(
    events.some((e) => e.type === "warning" && e.payload === "w1"),
    true,
  );
  assertEquals(
    events.some((e) => e.type === "stage" && e.payload === "done"),
    true,
  );
});

Deno.test("JobManager: arts を設定すると artifactPath で取得できる", async () => {
  const mgr = new JobManager();
  const snap = mgr.create(
    "a.pdf",
    new Uint8Array([1]),
    OPTIONS,
    async (job) => {
      job.artifacts.mono = "/tmp/translated.pdf";
      job.snapshot.stage = "done";
    },
  );
  await waitForStage(snap.id, "done", mgr);
  assertEquals(mgr.artifactPath(snap.id, "mono"), "/tmp/translated.pdf");
  assertEquals(mgr.get(snap.id)?.hasMono, true);
});

Deno.test("JobManager: 存在しないIDの参照は undefined / false を返す", () => {
  const mgr = new JobManager();
  assertEquals(mgr.get("nope"), undefined);
  assertEquals(mgr.cancel("nope"), false);
  assertEquals(mgr.subscribe("nope", () => {}), undefined);
});
