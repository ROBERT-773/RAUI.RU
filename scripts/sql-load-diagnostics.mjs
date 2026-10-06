import { summarizeSlowQueries } from '../apps/api/scripts/e2e-runtime.mjs';
let log = '';
for await (const chunk of process.stdin) {
  if (log.length + chunk.length <= 1024 * 1024) log += chunk.toString('utf8');
}
for (const result of summarizeSlowQueries(log))
  console.log(
    `::notice title=Slow SQL timing::${result.query} thresholdMs=100 count=${result.count} maxMs=${result.maxMs ?? 'unavailable'}`,
  );
