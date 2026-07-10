import type { SecretBackend } from './secret-backend.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RailwayApiSecretBackendOptions {
  token: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  fetch?: FetchLike;
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://backboard.railway.app/graphql/v2';

/**
 * Read+write SecretBackend over Railway's GraphQL API. Used by the key-lifecycle CLIs ONLY
 * (bootstrap/rotate/revoke/confirm-destruction) — a running service uses the read-only
 * EnvSecretBackend. Never logs variable values (key material). After a CLI mutates secrets, the
 * operator must redeploy the encrypting services so they pick up the new material (ADR 0008).
 *
 * The `variables` query and `variableUpsert` mutation shapes follow Railway's documented public
 * GraphQL API (https://docs.railway.com/guides/manage-variables): both are scoped by
 * `projectId` + `environmentId` (+ `serviceId` to target one service rather than a shared
 * variable). The tests assert BEHAVIOR (the scoping ids are sent, a variableUpsert mutation is
 * issued, values are never logged, reads return the variable).
 */
export class RailwayApiSecretBackend implements SecretBackend {
  readonly #token: string;
  readonly #projectId: string;
  readonly #environmentId: string;
  readonly #serviceId: string;
  readonly #fetch: FetchLike;
  readonly #endpoint: string;

  constructor(opts: RailwayApiSecretBackendOptions) {
    this.#token = opts.token;
    this.#projectId = opts.projectId;
    this.#environmentId = opts.environmentId;
    this.#serviceId = opts.serviceId;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.#endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  }

  async #gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#token}` },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Railway API HTTP ${String(res.status)}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors && json.errors.length > 0) {
      throw new Error(`Railway API error: ${json.errors.map((e) => e.message).join('; ')}`);
    }
    if (!json.data) throw new Error('Railway API: empty response');
    return json.data;
  }

  async read(name: string): Promise<string | undefined> {
    const data = await this.#gql<{ variables: Record<string, string> }>(
      `query($projectId: String!, $environmentId: String!, $serviceId: String!) {
         variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
       }`,
      {
        projectId: this.#projectId,
        environmentId: this.#environmentId,
        serviceId: this.#serviceId,
      },
    );
    return data.variables[name];
  }

  async write(name: string, value: string): Promise<void> {
    try {
      await this.#gql<{ variableUpsert: boolean }>(
        `mutation($projectId: String!, $environmentId: String!, $serviceId: String!, $name: String!, $value: String!) {
           variableUpsert(input: { projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, name: $name, value: $value })
         }`,
        {
          projectId: this.#projectId,
          environmentId: this.#environmentId,
          serviceId: this.#serviceId,
          name,
          value,
        },
      );
    } catch {
      // Rethrow a GENERIC error: #gql folds the upstream GraphQL errors[].message in verbatim, and
      // if Railway ever echoes the submitted value back in a validation error, propagating it would
      // leak key material to the CLI's stderr (CLIs print String(err)). Never include the caught
      // error, the name, or the value. read() keeps its detailed errors — it sends no key material.
      throw new Error('Railway API: variable write failed');
    }
  }
}
