import type { JobManager } from "../engine/jobs.ts";
import type { PiaiService } from "../engine/piai/service.ts";
import type { AppPaths, SettingsStore } from "../engine/settings.ts";

/** CLI の全画面から参照する共有コンテキスト。 */
export interface AppCtx {
  settings: SettingsStore;
  piai: PiaiService;
  jobs: JobManager;
  paths: AppPaths;
  /** MACHUPITA_FAUX=1 のとき true (ダミー翻訳) */
  faux: boolean;
}
