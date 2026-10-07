import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegionCatalogue, loadRegionDocuments } from './modules/geo/regions';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const document = (code = 'moscow', extra = '') => `
code: ${code}
name: Москва
type: city
search_entities: [okrug, district, metro, street, house]
metro_available: true
directions_available: false
timezone: Europe/Moscow
currency: RUB
${extra}`;

test('Catalogue reads YAML records and adds a new region without code changes', () => {
  const catalogue = new RegionCatalogue([document(), document('new_city')]);
  assert.deepEqual(
    catalogue.list().map((r) => r.code),
    ['moscow', 'new_city'],
  );
  assert.deepEqual(catalogue.filters('new_city').search_entities, [
    'okrug',
    'district',
    'metro',
    'street',
    'house',
  ]);
  assert.equal(catalogue.filters('new_city').data_status, 'catalogue_only');
});

test('Unknown codes are 404; malformed codes never become filesystem paths', () => {
  const catalogue = new RegionCatalogue([document()]);
  assert.throws(
    () => catalogue.filters('unknown'),
    (e: { getStatus(): number }) => e.getStatus() === 404,
  );
  for (const code of ['../secret', 'MOSCOW', '', 'a'.repeat(51)])
    assert.throws(
      () => catalogue.filters(code),
      (e: { getStatus(): number }) => e.getStatus() === 400,
    );
});

test('Malformed duplicate aliased oversized and incoherent configuration fails closed', () => {
  for (const records of [
    [],
    [document(), document()],
    ['[not-a-mapping]'],
    [document('moscow', 'secret: private-token')],
    [document('moscow', 'name: changed')],
    [document().replace('metro_available: true', 'metro_available: false')],
    [document().replace('currency: RUB', 'currency: USD')],
    [document().replace('Europe/Moscow', 'not/a/timezone')],
    [
      document().replace(
        '[okrug, district, metro, street, house]',
        '&entities [metro, metro]',
      ),
    ],
    [
      document()
        .replace('name: Москва', 'name: &name Москва')
        .replace('timezone: Europe/Moscow', 'timezone: *name'),
    ],
    [document() + '#'.repeat(65537)],
  ])
    assert.throws(
      () => new RegionCatalogue(records),
      /Invalid region configuration/,
    );
});

test('Public metadata is detached so one caller cannot mutate subsequent results', () => {
  const catalogue = new RegionCatalogue([document()]);
  const list = catalogue.list();
  list[0]!.search_entities.length = 0;
  list[0]!.name = 'changed';
  assert.equal(catalogue.list()[0]!.name, 'Москва');
  assert.equal(catalogue.filters('moscow').search_entities.length, 5);
});

test('Configuration assets load from a directory but symlinks and oversized files fail closed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'raui-regions-'));
  const path = join(directory, 'moscow.yaml');
  try {
    writeFileSync(path, document());
    assert.equal(
      new RegionCatalogue(loadRegionDocuments(directory)).list()[0]!.code,
      'moscow',
    );
    writeFileSync(path, '#'.repeat(65537));
    assert.throws(
      () => loadRegionDocuments(directory),
      /Invalid region configuration/,
    );
    rmSync(path);
    symlinkSync('/etc/passwd', path);
    assert.throws(
      () => loadRegionDocuments(directory),
      /Invalid region configuration/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
