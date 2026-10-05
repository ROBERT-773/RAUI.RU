import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interpretSearch, redactQuery, runAi } from './modules/ai/runtime';
import { evaluateRules } from './modules/trust/rules';

test('Natural language fallback preserves explicit filters and redacts contact data', () => {
  const filters = interpretSearch('Купить 2 комнаты в Москве до 15 млн');
  assert.equal(filters.dealType, 'sale');
  assert.equal(filters.price?.max, 15000000);
  assert.deepEqual(filters.attributes.rooms, { min: 2, max: 2 });
  assert.equal(filters.locality, 'Москва');
  assert.ok(
    !redactQuery(
      'test@example.com +7 (999) 123-45-67 https://private.test/token',
    ).includes('test@example.com'),
  );
  assert.ok(
    !redactQuery(
      'test@example.com +7 (999) 123-45-67 https://private.test/token',
    ).includes('999'),
  );
});
test('AI off never calls provider and keeps facts in fallback authoritative', async () => {
  let calls = 0;
  const answer = await runAi({
    capability: 'description',
    context: {},
    fallback: { area: 50 },
    enabled: async () => false,
    provider: {
      async generate() {
        calls++;
        throw new Error('unused');
      },
    },
  });
  assert.equal(calls, 0);
  assert.equal(answer.mode, 'fallback');
  assert.deepEqual(answer.result, { area: 50 });
});
test('AI retries are bounded, timeouts abort and provider errors are sanitized', async () => {
  let aborted = false,
    calls = 0;
  const answer = await runAi({
    capability: 'search',
    context: {},
    fallback: {},
    enabled: async () => true,
    timeoutMs: 10,
    provider: {
      async generate(_input, signal) {
        calls++;
        signal.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise(() => {});
      },
    },
  });
  assert.equal(answer.mode, 'fallback');
  assert.equal(answer.reason, 'provider_unavailable');
  assert.equal(calls, 2);
  assert.equal(aborted, true);
  assert.ok(!JSON.stringify(answer).includes('secret'));
});
test('Invalid or fabricated provider facts fail closed and kill switch overrides in-flight replies', async () => {
  const invalid = await runAi({
    capability: 'description',
    context: {},
    fallback: { area: 50 },
    enabled: async () => true,
    provider: {
      async generate() {
        return { area: 99, token: 'secret' };
      },
    },
  });
  assert.equal(invalid.mode, 'fallback');
  assert.deepEqual(invalid.result, { area: 50 });
  let checks = 0;
  const disabled = await runAi({
    capability: 'description',
    context: {},
    fallback: { area: 50 },
    enabled: async () => ++checks <= 2,
    provider: {
      async generate() {
        return {
          suggestion: 'Advice',
          confidence: 0.5,
          modelVersion: 'test-v1',
          usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
        };
      },
    },
  });
  assert.equal(disabled.mode, 'fallback');
  assert.equal(disabled.reason, 'disabled');
});
test('Deterministic fraud rules require human review without any AI dependency', () => {
  const issues = evaluateRules({
    title: 'Квартира',
    description: 'Переведите предоплату до просмотра квартиры',
    price: 10000000,
  });
  assert.ok(
    issues.some(
      (x) =>
        x.code === 'advance_payment_before_viewing' && x.severity === 'review',
    ),
  );
  assert.ok(
    evaluateRules({
      title: 'Flat',
      description: 'Normal description',
      price: null,
    }).some((x) => x.severity === 'block'),
  );
  assert.deepEqual(
    evaluateRules({
      title: 'Flat',
      description: 'Normal description',
      price: 10000000,
    }),
    [],
  );
});
