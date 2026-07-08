/**
 * Storage seam for the RailwaySecretKeyStore. A backend holds named secret values (opaque JSON
 * strings). Running services get a read-only view of the values injected at boot; the key-lifecycle
 * CLIs get a read+write view backed by the Railway API. Never logs values — they are key material.
 */
export interface SecretBackend {
  /** Current value for `name`, or undefined if unset. */
  read(name: string): Promise<string | undefined>;
  /** Persist `value` for `name`. Read-only backends reject with {@link ReadOnlySecretBackendError}. */
  write(name: string, value: string): Promise<void>;
}

/** Thrown when a read-only backend (a running service) is asked to mutate key material. */
export class ReadOnlySecretBackendError extends Error {
  constructor(name: string) {
    super(
      `secret backend is read-only for "${name}"; run key changes via a Railway-API-backed CLI, not a service`,
    );
    this.name = 'ReadOnlySecretBackendError';
  }
}

/** In-memory backend for tests. */
export class InMemorySecretBackend implements SecretBackend {
  readonly #values = new Map<string, string>();
  read(name: string): Promise<string | undefined> {
    return Promise.resolve(this.#values.get(name));
  }
  write(name: string, value: string): Promise<void> {
    this.#values.set(name, value);
    return Promise.resolve();
  }
}

/** Read-only backend over values injected at boot (the two Railway secrets). Used by services. */
export class EnvSecretBackend implements SecretBackend {
  readonly #values: Readonly<Record<string, string | undefined>>;
  constructor(values: Readonly<Record<string, string | undefined>>) {
    this.#values = values;
  }
  read(name: string): Promise<string | undefined> {
    return Promise.resolve(this.#values[name]);
  }
  write(name: string, _value: string): Promise<void> {
    return Promise.reject(new ReadOnlySecretBackendError(name));
  }
}
