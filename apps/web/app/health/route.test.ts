import { test, expect } from 'vitest';
import { GET } from './route';
test('web health returns service identity and prevents caching', async () => {
  const response = GET();
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ status: 'ok', service: 'web' });
});
