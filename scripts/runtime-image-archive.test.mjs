import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'raui-archive-test-'));
  const bytes = Buffer.from('synthetic saved-image archive');
  const receipt = {
    version: 1,
    sourceRevision: 'a'.repeat(40),
    ciRunId: '123',
    imageId: 'sha256:' + 'b'.repeat(64),
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    sourceState: 'committed',
    siteUrl: 'http://127.0.0.1:3000',
    deploymentEnvironment: 'staging',
    contract: 'passed',
    serviceSmoke: 'passed',
    migrationCount: 17,
    network: 'linux-host',
    adapters: 'local-development',
    stagingAcceptance: 'not_executed',
    deployment: 'not_executed',
  };
  await mkdir(join(root, '.cache'));
  await writeFile(join(root, '.cache/runtime-image.tar.gz'), bytes);
  await writeFile(
    join(root, '.cache/runtime-image-receipt.json'),
    JSON.stringify(receipt),
  );
  try {
    await run(root, receipt);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('saved archive verifies streamed bytes and source/run identity', async () => {
  const { verifyRuntimeArchive } = await import('./runtime-image-archive.mjs');
  await fixture(async (root, receipt) => {
    assert.deepEqual(
      await verifyRuntimeArchive(root, 'a'.repeat(40), '123'),
      receipt,
    );
  });
});
test('saved archive rejects tampering instead of restoring unchecked bytes', async () => {
  const { verifyRuntimeArchive } = await import('./runtime-image-archive.mjs');
  await fixture(async (root) => {
    await writeFile(
      join(root, '.cache/runtime-image.tar.gz'),
      'changed archive',
    );
    await assert.rejects(
      verifyRuntimeArchive(root, 'a'.repeat(40), '123'),
      /Runtime archive checksum mismatch/,
    );
  });
});
test('saved archive rejects a receipt for another source or CI run', async () => {
  const { verifyRuntimeArchive } = await import('./runtime-image-archive.mjs');
  await fixture(async (root) => {
    await assert.rejects(
      verifyRuntimeArchive(root, 'c'.repeat(40), '123'),
      /Invalid runtime image evidence/,
    );
    await assert.rejects(
      verifyRuntimeArchive(root, 'a'.repeat(40), '456'),
      /Invalid runtime image evidence/,
    );
  });
});
test('saved archive rejects symlinks, including an escaped cache parent', async () => {
  const { verifyRuntimeArchive } = await import('./runtime-image-archive.mjs');
  await fixture(async (root) => {
    const archive = join(root, '.cache/runtime-image.tar.gz');
    await rm(archive);
    await symlink('runtime-image-receipt.json', archive);
    await assert.rejects(
      verifyRuntimeArchive(root, 'a'.repeat(40), '123'),
      /Runtime artifact path rejected/,
    );
    const other = await mkdtemp(join(tmpdir(), 'raui-archive-outside-'));
    try {
      await rm(join(root, '.cache'), { recursive: true, force: true });
      await writeFile(join(other, 'runtime-image-receipt.json'), '{}');
      await symlink(other, join(root, '.cache'));
      await assert.rejects(
        verifyRuntimeArchive(root, 'a'.repeat(40), '123'),
        /Runtime artifact path rejected/,
      );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
