import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  Api,
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { deepinfraProvider } from "./deepinfra.ts";
import { FileCredentialStore } from "./store.ts";

export interface LoginUiState {
  providerId: string;
  phase: "idle" | "in_progress" | "awaiting_input" | "done" | "error";
  events: (AuthEvent & { at: number })[];
  pendingPrompt?: {
    kind: AuthPrompt["type"];
    message: string;
    options?: readonly { id: string; label: string; description?: string }[];
    resolve: (value: string) => void;
    reject: (reason: unknown) => void;
  };
  error?: string;
}

export class PiaiService {
  #models: Models | null = null;
  #store: FileCredentialStore;
  #logins = new Map<string, LoginUiState>();

  constructor(dataDir: string) {
    this.#store = new FileCredentialStore(dataDir);
  }

  models(): Models {
    if (!this.#models) {
      const models = builtinModels({ credentials: this.#store });
      models.setProvider(deepinfraProvider());
      this.#models = models;
    }
    return this.#models;
  }

  listProviders() {
    return this.models().getProviders().map((p) => ({
      id: p.id,
      name: p.name,
      authType: p.auth.apiKey
        ? ("api_key" as const)
        : p.auth.oauth
        ? ("oauth" as const)
        : ("api_key" as const),
      hasInteractiveLogin: Boolean(p.auth.apiKey?.login ?? p.auth.oauth?.login),
    }));
  }

  async listAuthStatuses() {
    const providers = this.models().getProviders();
    const out: {
      id: string;
      configured: boolean;
      source?: string;
      type?: string;
    }[] = [];
    for (const p of providers) {
      try {
        const check = await this.models().checkAuth(p.id);
        out.push({
          id: p.id,
          configured: Boolean(check),
          source: check?.source,
          type: check?.type,
        });
      } catch {
        out.push({ id: p.id, configured: false });
      }
    }
    return out;
  }

  listModels(providerId: string): Promise<Model<Api>[]> {
    return Promise.resolve([...this.models().getModels(providerId)]);
  }

  getLoginState(providerId: string): LoginUiState | undefined {
    return this.#logins.get(providerId);
  }

  startLogin(providerId: string, apiKey?: string): LoginUiState {
    const existing = this.#logins.get(providerId);
    if (
      existing &&
      (existing.phase === "in_progress" || existing.phase === "awaiting_input")
    ) {
      return existing;
    }
    const state: LoginUiState = {
      providerId,
      phase: "in_progress",
      events: [],
    };
    this.#logins.set(providerId, state);

    const interaction: AuthInteraction = {
      prompt: (prompt: AuthPrompt) =>
        new Promise<string>((resolve, reject) => {
          state.phase = "awaiting_input";
          state.pendingPrompt = {
            kind: prompt.type,
            message: prompt.message,
            options: "options" in prompt ? prompt.options : undefined,
            resolve,
            reject,
          };
        }),
      notify: (event: AuthEvent) => {
        state.events.push({ ...event, at: Date.now() });
      },
    };

    const run = (async () => {
      const provider = this.models().getProvider(providerId);
      if (!provider) throw new Error(`unknown provider: ${providerId}`);
      if (provider.auth.oauth?.login && !apiKey) {
        await this.models().login(providerId, "oauth", interaction);
      } else if (provider.auth.apiKey?.login) {
        await this.models().login(providerId, "api_key", interaction);
      } else {
        throw new Error(
          `provider ${providerId} does not support interactive login`,
        );
      }
      state.phase = "done";
    })().catch((err) => {
      state.phase = "error";
      state.error = err instanceof Error ? err.message : String(err);
    });

    void run;
    return state;
  }

  answerPrompt(
    providerId: string,
    value: string,
  ): boolean {
    const state = this.#logins.get(providerId);
    if (!state?.pendingPrompt) return false;
    const { resolve } = state.pendingPrompt;
    state.pendingPrompt = undefined;
    state.phase = "in_progress";
    resolve(value);
    return true;
  }

  cancelLogin(providerId: string): void {
    const state = this.#logins.get(providerId);
    if (!state) return;
    if (state.pendingPrompt) {
      state.pendingPrompt.reject(new Error("cancelled"));
      state.pendingPrompt = undefined;
    }
    state.phase = "error";
    state.error = "cancelled by user";
  }

  logout(providerId: string): Promise<void> {
    return this.models().logout(providerId);
  }

  resolveModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.models().getModel(providerId, modelId);
  }

  async saveApiKey(providerId: string, key: string): Promise<void> {
    await this.#store.modify(
      providerId,
      () => Promise.resolve({ type: "api_key", key }),
    );
  }
}
