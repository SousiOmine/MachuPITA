import { dirname, fromFileUrl, join } from "@std/path";

export const PROJECT_ROOT = join(dirname(fromFileUrl(import.meta.url)), "..");

export interface AppPaths {
  dataDir: string;
  fontsDir: string;
  distDir: string;
}

export function resolveAppPaths(dataDirOverride?: string): AppPaths {
  const home = Deno.env.get("USERPROFILE") ?? Deno.env.get("HOME") ?? ".";
  const base = Deno.env.get("APPDATA") ??
    Deno.env.get("XDG_CONFIG_HOME") ??
    join(home, ".config");
  return {
    dataDir: dataDirOverride ?? join(base, "machupita"),
    fontsDir: join(PROJECT_ROOT, "assets", "fonts"),
    distDir: join(PROJECT_ROOT, "web", "dist"),
  };
}

export const LANGUAGE_PRESETS = [
  { code: "ja", label: "日本語" },
  { code: "en", label: "English" },
  { code: "zh-CN", label: "簡体字中国語" },
  { code: "zh-TW", label: "繁体字中国語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
  { code: "it", label: "Italiano" },
  { code: "ru", label: "Русский" },
] as const;

export type OutputFormat = "mono" | "dual";

export interface Settings {
  provider: string;
  model: string;
  customBaseUrl?: string;
  apiKeyDrafts?: Record<string, string>;
  targetLanguage: string;
  targetLanguageFree?: string;
  outputFormat: OutputFormat;
  concurrency: number;
  batchSizeChars: number;
  maskColor: string;
  minFontScale: number;
}

export const DEFAULT_SETTINGS: Settings = {
  provider: "",
  model: "",
  targetLanguage: "ja",
  outputFormat: "mono",
  concurrency: 3,
  batchSizeChars: 3000,
  maskColor: "#ffffff",
  minFontScale: 0.55,
};

export class SettingsStore {
  #path: string;
  #cache: Settings | null = null;

  constructor(paths: AppPaths) {
    this.#path = join(paths.dataDir, "settings.json");
  }

  async get(): Promise<Settings> {
    if (this.#cache) return this.#cache;
    try {
      const raw = await Deno.readTextFile(this.#path);
      this.#cache = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } as Settings;
    } catch {
      this.#cache = { ...DEFAULT_SETTINGS };
    }
    return this.#cache;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.get();
    const next = { ...current, ...patch };
    await Deno.mkdir(dirname(this.#path), { recursive: true });
    await Deno.writeTextFile(this.#path, JSON.stringify(next, null, 2));
    this.#cache = next;
    return next;
  }
}
