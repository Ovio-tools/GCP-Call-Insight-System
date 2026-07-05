/**
 * `eval:run` entrypoint (Task 6.3). Thin re-export of the evaluation-run SERVICE, which is also the
 * weekly Railway cron target (`dist/services/evaluation-run.js`). Importing the service module runs
 * its `main()` (guarded off `VITEST`), so `node dist/scripts/run-evaluation.js` and the Railway cron
 * share one code path. CLI flags (`--stub`, `--dry-run`) are read by the service from `process.argv`.
 */
import '../services/evaluation-run.js';
