import { join } from "@std/path";
import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";

type StoreShape = Record<string, Credential>;

export class FileCredentialStore implements CredentialStore {
  #path: string;
  #chains = new Map<string, Promise<unknown>>();

  constructor(dataDir: string) {
    this.#path = join(dataDir, "auth.json");
  }

  async #readAll(): Promise<StoreShape> {
    try {
      return JSON.parse(await Deno.readTextFile(this.#path)) as StoreShape;
    } catch {
      return {};
    }
  }

  async #writeAll(shape: StoreShape): Promise<void> {
    await Deno.mkdir(Deno.env.get("TEMP") ?? ".", { recursive: true });
    const tmp = this.#path + ".tmp";
    await Deno.writeTextFile(tmp, JSON.stringify(shape, null, 2));
    await Deno.rename(tmp, this.#path);
    try {
      await Deno.chmod(this.#path, 0o600);
    } catch {
      /* Windows ignores */
    }
  }

  #enqueue<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chains.get(providerId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#chains.set(
      providerId,
      next.catch(() => undefined),
    );
    return next;
  }

  read(
    providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#readAll().then((s) => s[providerId]);
  }

  list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.#readAll().then((s) =>
      Object.entries(s).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }))
    );
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    _options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.#enqueue(providerId, async () => {
      const shape = await this.#readAll();
      const next = await fn(shape[providerId]);
      if (next === undefined) return shape[providerId];
      shape[providerId] = next;
      await this.#writeAll(shape);
      return next;
    });
  }

  delete(
    providerId: string,
    _options?: AuthOperationOptions,
  ): Promise<void> {
    return this.#enqueue(providerId, async () => {
      const shape = await this.#readAll();
      delete shape[providerId];
      await this.#writeAll(shape);
    });
  }
}
