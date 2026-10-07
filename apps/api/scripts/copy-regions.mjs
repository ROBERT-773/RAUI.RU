import 'reflect-metadata';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--test')) {
  throw new Error('Invalid region asset build target');
}
const output = args[0] === '--test' ? '.cache/test' : 'dist';
const { RegionCatalogue, loadRegionDocuments } = await import(
  `../${output}/modules/geo/regions.js`
);

const source = resolve(import.meta.dirname, '../config/regions');
const target = resolve(import.meta.dirname, `../${output}/config/regions`);
new RegionCatalogue(loadRegionDocuments(source));
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of await readdir(source)) {
  if (name.endsWith('.yaml'))
    await copyFile(join(source, name), join(target, name));
}
