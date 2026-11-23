INSERT INTO attribute_definitions(category_code, code, name, kind, options)
VALUES
  ('commercial', 'commercial_building_class', 'Класс здания', 'enum',
   '["A+","A","B+","B","C","D"]'::jsonb),
  ('commercial', 'commercial_finish', 'Отделка помещения', 'enum',
   '["Без отделки","Под чистовую отделку","С отделкой","Требуется ремонт"]'::jsonb)
ON CONFLICT (category_code, code) DO NOTHING;
