import { parse as parseCsv } from 'csv-parse/sync';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { BadRequestException } from '@nestjs/common';
import { parse } from '../../common/security';
import { importInput } from './contracts';
export function parseFeed(
  text: string,
  format: string,
  mapping: Record<string, string>,
): unknown[] {
  if (Buffer.byteLength(text) > 2_000_000)
    throw new BadRequestException('Feed exceeds 2 MB');
  let rows: unknown;
  try {
    if (format === 'json') rows = JSON.parse(text);
    else if (format === 'csv')
      rows = parseCsv(text, {
        columns: true,
        skip_empty_lines: true,
        max_record_size: 20000,
      }) as unknown[];
    else if (format === 'xml') {
      if (
        /<!DOCTYPE|<!ENTITY/i.test(text) ||
        XMLValidator.validate(text) !== true
      )
        throw new Error('Unsafe XML');
      const body = new XMLParser({
        ignoreAttributes: false,
        processEntities: false,
        maxNestedTags: 20,
        parseTagValue: false,
        isArray: (name) => name === 'item',
      }).parse(text) as { feed?: { item?: unknown[] } };
      rows = body.feed?.item;
    } else throw new Error('Unsupported format');
  } catch {
    throw new BadRequestException('Feed decoding failed');
  }
  const input = parse(importInput, { items: rows });
  // Mapping is output dotted field -> input dotted field. No prototype-sensitive paths.
  const forbidden = ['__proto__', 'constructor', 'prototype'];
  for (const [target, source] of Object.entries(mapping))
    if (
      [...target.split('.'), ...source.split('.')].some(
        (x) => forbidden.includes(x) || !x,
      )
    )
      throw new BadRequestException('Unsafe mapping');
  return input.items.map((raw) => {
    if (!Object.keys(mapping).length) return raw;
    const out: Record<string, unknown> = {};
    for (const [target, source] of Object.entries(mapping)) {
      let value: unknown = raw;
      for (const part of source.split('.'))
        value =
          typeof value === 'object' && value !== null
            ? Object.hasOwn(value, part)
              ? (value as Record<string, unknown>)[part]
              : undefined
            : undefined;
      if (value === undefined) continue;
      if (
        [
          'price',
          'address.longitude',
          'address.latitude',
          'attributes.area',
        ].includes(target) &&
        typeof value === 'string'
      )
        value = Number(value);
      const parts = target.split('.');
      let obj = out;
      for (const part of parts.slice(0, -1)) {
        obj[part] ??= {};
        if (typeof obj[part] !== 'object' || obj[part] === null)
          throw new BadRequestException('Conflicting mapping');
        obj = obj[part] as Record<string, unknown>;
      }
      obj[parts.at(-1)!] = value;
    }
    return out;
  });
}
