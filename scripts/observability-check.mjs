import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Official v3.5.0 manifest verified by Docker pull; immutable evaluator in CI/local.
const image =
  'prom/prometheus@sha256:63805ebb8d2b3920190daf1cb14a60871b16fd38bed42b857a3182bc621f4996';
const directory = fileURLToPath(
  new URL('../infra/observability', import.meta.url),
);
for (const args of [
  ['check', 'rules', 'alerts.yml'],
  ['test', 'rules', 'alerts.test.yml'],
]) {
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=128m',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '256m',
      '--cpus',
      '1',
      '--mount',
      `type=bind,source=${directory},target=/rules,readonly`,
      '--workdir',
      '/rules',
      '--entrypoint',
      '/bin/promtool',
      image,
      ...args,
    ],
    { stdio: 'inherit', timeout: 120000 },
  );
}
