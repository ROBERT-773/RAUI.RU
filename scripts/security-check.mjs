import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const paths = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { encoding: 'utf8' },
)
  .split('\u0000')
  .filter(Boolean);
const violations = [];
for (const path of paths) {
  if (!/\.(ts|tsx|js|mjs|json|md|ya?ml|sql)$/.test(path)) continue;
  const text = await readFile(path, 'utf8');
  if (
    /AKIA[A-Z0-9]{16}/.test(text) ||
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{30}/.test(
      text,
    )
  )
    violations.push(path + ': embedded credential');
  if (
    !path.includes('.test.') &&
    !path.startsWith('docs/') &&
    /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/.test(
      text,
    )
  )
    violations.push(path + ': TLS verification bypass');
  if (
    path.startsWith('apps/web/') &&
    !path.includes('.test.') &&
    /process\.env\.(?:AI_GATEWAY_TOKEN|NOTIFICATION_GATEWAY_TOKEN|VERIFICATION_GATEWAY_TOKEN|AWS_SECRET_ACCESS_KEY)/.test(
      text,
    )
  )
    violations.push(path + ': server credential in web surface');
}
execFileSync('git', ['diff', '--check'], { stdio: 'inherit' });
if (violations.length) throw new Error(violations.join('\n'));
console.log(
  'Credential/TLS/client boundary scan and diff integrity passed; dependency audit is a separate mandatory gate',
);
