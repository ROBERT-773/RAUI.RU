import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateRuntimeReceipt } from './release-contract.mjs';

async function artifactFile(root, name) {
  const cache = resolve(root, '.cache');
  const directory = await lstat(cache);
  if (directory.isSymbolicLink() || !directory.isDirectory())
    throw new Error('Runtime artifact path rejected');
  const file = resolve(cache, name);
  const info = await lstat(file);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    !(await realpath(file)).startsWith((await realpath(root)) + '/')
  )
    throw new Error('Runtime artifact path rejected');
  return file;
}
export async function verifyRuntimeArchive(root, expectedSha, expectedRunId) {
  const receiptFile = await artifactFile(root, 'runtime-image-receipt.json');
  const archiveFile = await artifactFile(root, 'runtime-image.tar.gz');
  let receipt;
  try {
    receipt = JSON.parse(await readFile(receiptFile, 'utf8'));
  } catch {
    throw new Error('Invalid runtime image evidence');
  }
  validateRuntimeReceipt(receipt, expectedSha, expectedRunId);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(archiveFile)) hash.update(bytes);
  if (hash.digest('hex') !== receipt.archiveSha256)
    throw new Error('Runtime archive checksum mismatch');
  return receipt;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length !== 2)
    throw new Error('Use immutable source SHA and CI run ID');
  await verifyRuntimeArchive(process.cwd(), args[0], args[1]);
  console.log('Runtime archive bytes, source and CI identity verified');
}
