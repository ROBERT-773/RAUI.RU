export const mapZoomTitles = {
  zoomInTitle: 'Увеличить масштаб',
  zoomOutTitle: 'Уменьшить масштаб',
};

export const attributeLabels: Record<string, string> = {
  area: 'Площадь, м²',
  rooms: 'Комнаты',
  floor: 'Этаж',
  floors: 'Этажей в доме',
  building_year: 'Год постройки',
  building_type: 'Тип дома',
  renovation: 'Ремонт',
  bathroom: 'Санузел',
  balcony: 'Балкон',
  loggia: 'Лоджия',
  ceiling_height: 'Высота потолков, м',
  elevator: 'Лифт',
  parking: 'Парковка',
  furniture: 'Мебель',
  equipment: 'Техника',
  mortgage: 'Ипотека',
  market: 'Рынок',
  metro: 'Метро',
  metro_walk_minutes: 'Пешком до метро, мин',
  kitchen_area: 'Площадь кухни, м²',
  living_area: 'Жилая площадь, м²',
  passenger_elevators: 'Пассажирские лифты',
  freight_elevators: 'Грузовые лифты',
  separate_bathrooms: 'Раздельные санузлы',
  combined_bathrooms: 'Совмещённые санузлы',
  internet: 'Интернет',
  air_conditioning: 'Кондиционер',
  refrigerator: 'Холодильник',
  washing_machine: 'Стиральная машина',
  television: 'Телевизор',
  okrug: 'Округ',
  highway: 'Шоссе',
  highway_distance: 'До шоссе, км',
  commercial_property_type: 'Тип коммерческого помещения',
  commercial_building_class: 'Класс здания',
  commercial_finish: 'Отделка помещения',
  automatic_gates: 'Автоматические ворота',
  separate_entrance: 'Отдельный вход',
};
export const attributeValue = (value: unknown) =>
  typeof value === 'boolean' ? (value ? 'Да' : 'Нет') : String(value ?? '—');

export const pricePeriod = (dealType: string) => {
  if (dealType === 'long_rent') return ' / мес.';
  if (dealType === 'short_rent') return ' / сутки';
  return '';
};

export const formatListingPrice = (price: number | string, dealType: string) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(Number(price)) + pricePeriod(dealType);

const dealLabels: Record<string, string | undefined> = {
  sale: 'Продажа',
  long_rent: 'Долгосрочная аренда',
  short_rent: 'Посуточная аренда',
};

export const dealLabel = (dealType: string) => dealLabels[dealType];
