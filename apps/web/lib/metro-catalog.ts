import catalogue from './metro-stations.json';

const cityRegions = new Map([
  ['москва', 'moscow'],
  ['санкт-петербург', 'saint_petersburg'],
]);
const normalize = (value: string) =>
  value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function metroSuggestions(
  region: string | undefined,
  city: string | undefined,
  query: string,
) {
  const locality = normalize(city ?? '');
  const cityRegion = cityRegions.get(locality);
  if (locality && !cityRegion) return [];
  if (cityRegion && region && cityRegion !== region) return [];
  const key = region ?? cityRegion;
  if (key !== 'moscow' && key !== 'saint_petersburg') return [];
  const prefix = normalize(query);
  return catalogue[key]
    .flatMap(({ id, name: line, color, stations }) =>
      stations.map((name) => ({ id: id + ':' + name, name, line, color })),
    )
    .filter(({ name }) => normalize(name).startsWith(prefix))
    .sort((left, right) => left.name.localeCompare(right.name, 'ru'))
    .slice(0, 12);
}
