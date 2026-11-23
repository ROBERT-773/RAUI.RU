UPDATE attribute_definitions
SET name = CASE WHEN category_code = 'land'
  THEN 'Площадь участка, м²'
  ELSE 'Площадь дома, м²'
END
WHERE code = 'area'
  AND category_code IN ('house', 'townhouse', 'land');

INSERT INTO attribute_definitions(category_code, code, name, kind)
SELECT code, 'land_area', 'Площадь участка, м²', 'number'
FROM categories WHERE code IN ('house', 'townhouse')
ON CONFLICT DO NOTHING;

INSERT INTO attribute_definitions(category_code, code, name, kind, options)
SELECT code, 'land_status', 'Статус земли', 'enum',
  '["ИЖС", "ЛПХ", "Садоводство", "Другое"]'::jsonb
FROM categories WHERE code IN ('house', 'townhouse', 'land')
ON CONFLICT DO NOTHING;
