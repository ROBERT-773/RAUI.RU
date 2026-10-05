import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { ProfessionalFeeds } from './modules/professional/feeds';

test('professional feed module is exported for Phase 4B wiring', () => {
  assert.equal(typeof ProfessionalFeeds, 'function');
});

test('dry-run input rejects missing items before persistence', async () => {
  const feeds = new ProfessionalFeeds(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(
    feeds.dryRun(
      {
        id: '00000000-0000-4000-8000-000000000001',
        role: 'admin',
        email_verified_at: 'verified',
        phone_verified_at: 'verified',
        session_id: '00000000-0000-4000-8000-000000000002',
      },
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000004',
      {},
      'phase4btest',
    ),
    BadRequestException,
  );
});
