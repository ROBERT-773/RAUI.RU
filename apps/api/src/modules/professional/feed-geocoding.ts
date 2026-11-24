import { Geocoder, addressSchema } from '../geo/geo';

const addressWithoutPoint = addressSchema.omit({
  latitude: true,
  longitude: true,
});
const normal = (value: string) =>
  value.trim().toLocaleLowerCase('ru-RU').replace(/\s+/gu, ' ');
type Point = { latitude: number; longitude: number };
type Match = { point: Point } | { message: string };

export class FeedGeocoding {
  private readonly matches = new Map<string, Match>();
  constructor(private readonly provider: Geocoder) {}

  async resolve(row: unknown): Promise<{ row: unknown; message?: string }> {
    if (
      !row ||
      typeof row !== 'object' ||
      !('address' in row) ||
      !row.address ||
      typeof row.address !== 'object'
    )
      return { row };
    const { latitude, longitude, ...address } = row.address as Record<
      string,
      unknown
    >;
    if (latitude !== undefined || longitude !== undefined) return { row };
    const parsed = addressWithoutPoint.safeParse(address);
    if (!parsed.success) return { row };
    const { formatted, locality } = parsed.data;
    const query = normal(formatted).includes(normal(locality))
      ? formatted
      : locality + ', ' + formatted;
    const key = JSON.stringify([normal(locality), normal(formatted)]);
    let match = this.matches.get(key);
    if (!match) {
      try {
        const exact = (await this.provider.lookup(query)).filter(
          (candidate) =>
            normal(candidate.locality) === normal(locality) &&
            [normal(formatted), normal(query)].includes(
              normal(candidate.formatted),
            ),
        );
        match =
          exact.length === 1
            ? {
                point: {
                  latitude: exact[0]!.latitude,
                  longitude: exact[0]!.longitude,
                },
              }
            : {
                message:
                  'Не удалось однозначно найти адрес на карте. Уточните адрес или укажите координаты.',
              };
      } catch {
        match = {
          message:
            'Сервис определения координат недоступен. Повторите проверку или укажите координаты.',
        };
      }
      this.matches.set(key, match);
    }
    return 'point' in match
      ? { row: { ...row, address: { ...address, ...match.point } } }
      : { row, message: match.message };
  }
}
