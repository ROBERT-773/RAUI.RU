INSERT INTO attribute_definitions(category_code, code, name, kind)
SELECT c.code, a.code, a.name, a.kind
FROM categories c
CROSS JOIN (VALUES
  ('metro_walk_minutes', 'Пешком до метро, мин', 'number'),
  ('kitchen_area', 'Площадь кухни, м²', 'number'),
  ('living_area', 'Жилая площадь, м²', 'number'),
  ('passenger_elevators', 'Пассажирские лифты', 'number'),
  ('freight_elevators', 'Грузовые лифты', 'number'),
  ('separate_bathrooms', 'Раздельные санузлы', 'number'),
  ('combined_bathrooms', 'Совмещённые санузлы', 'number'),
  ('internet', 'Интернет', 'boolean'),
  ('air_conditioning', 'Кондиционер', 'boolean'),
  ('refrigerator', 'Холодильник', 'boolean'),
  ('washing_machine', 'Стиральная машина', 'boolean'),
  ('television', 'Телевизор', 'boolean')
) AS a(code, name, kind)
WHERE c.code IN ('apartment', 'room', 'aparthotel', 'new_build', 'secondary')
ON CONFLICT (category_code, code) DO NOTHING;
