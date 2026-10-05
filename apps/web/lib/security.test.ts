import { describe, expect, it } from 'vitest';
import { publicOrigin, jsonLd, contentSecurityPolicy } from './security';
describe('Phase 4D web security and SEO guardrails', () => {
  it('requires a clean HTTPS public production origin and retains explicit local development origins', () => {
    expect(publicOrigin('https://raui.ru', true)).toBe('https://raui.ru');
    expect(publicOrigin('http://127.0.0.1:3100')).toBe('http://127.0.0.1:3100');
    for (const input of [
      undefined,
      'http://raui.ru',
      'https://user:secret@raui.ru',
      'https://raui.ru/path',
      'https://raui.ru?token=secret',
      'https://raui.ru#fragment',
      'javascript:alert(1)',
    ])
      expect(() => publicOrigin(input, true)).toThrow();
  });
  it('malformed site origins do not expose raw config values', () => {
    expect(() => publicOrigin('https://private-secret@[', true)).toThrow(
      'Invalid public site origin',
    );
  });
  it('serializes hostile listing text without closing a JSON-LD script and preserves its actual data', () => {
    const value = {
      name: '</script><script>alert("secret")</script>',
      description: '<&>\u2028\u2029',
    };
    const result = jsonLd(value);
    expect(result).not.toContain('<');
    expect(result).not.toContain('\u2028');
    expect(JSON.parse(result)).toEqual(value);
    expect(() => jsonLd(undefined)).toThrow('Invalid structured data');
  });
  it('uses bounded trusted nonces, blocks inline/eval production scripts and only allows the configured HTTPS tile origin', () => {
    const nonce = 'YWJjZGVmZ2hpamtsbW5vcA==';
    const result = contentSecurityPolicy(nonce, {
      tileUrl: 'https://tiles.example/{z}/{x}/{y}.png?key=public',
    });
    expect(result).toContain(
      "script-src 'self' 'nonce-" + nonce + "' 'strict-dynamic'",
    );
    expect(
      result.split(';').find((x) => x.trim().startsWith('script-src')),
    ).not.toContain('unsafe-inline');
    expect(result).not.toContain('unsafe-eval');
    expect(result).toContain('https://tiles.example');
    expect(result).not.toContain('key=public');
    for (const invalid of ["x';script-src *", 'x\nheader:value', 'short'])
      expect(() => contentSecurityPolicy(invalid)).toThrow();
    for (const tileUrl of [
      'http://private.local/{z}',
      'https://secret:password@tiles.example/{z}',
      'javascript:alert(1)',
    ])
      expect(() => contentSecurityPolicy(nonce, { tileUrl })).toThrow();
  });
});
