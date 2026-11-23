INSERT INTO attribute_definitions(category_code, code, name, kind, options)
VALUES (
  'commercial',
  'commercial_property_type',
  'Тип коммерческого помещения',
  'enum',
  '["Офис","Коворкинг","Склад","Торговая площадь","Помещение свободного назначения","Здание","Производство","Коммерческая земля","Готовый бизнес"]'::jsonb
)
ON CONFLICT (category_code, code) DO NOTHING;
