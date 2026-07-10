import { entrypointSpecifierFor, resolveServiceRole } from './service-dispatch.js';

/**
 * Multi-service entrypoint. Every Railway service runs the same start command
 * (`node dist/index.js`); the `SERVICE_ROLE` variable selects which service boots, so services
 * differ only by a variable (CLI-settable) rather than a per-service start command. The chosen
 * module (`dist/services/<role>.js`) self-runs its own boot sequence on import — validating config,
 * wiring dependencies, and installing its own heartbeats.
 *
 * An unset or unknown `SERVICE_ROLE` fails fast with a named `CONFIG_MISSING_OR_INVALID` (below),
 * never a silent no-op boot.
 */
async function main(): Promise<void> {
  const role = resolveServiceRole(process.env);
  // Breadcrumb before the child's own structured logger starts — the role name is not sensitive.
  process.stderr.write(`entrypoint: booting SERVICE_ROLE=${role}\n`);
  await import(entrypointSpecifierFor(role));
}

main().catch((err: unknown) => {
  process.stderr.write(`entrypoint failed: ${String(err)}\n`);
  process.exit(1);
});
