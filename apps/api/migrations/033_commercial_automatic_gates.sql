INSERT INTO attribute_definitions(category_code, code, name, kind)
VALUES ('commercial', 'automatic_gates', 'Автоматические ворота', 'boolean')
ON CONFLICT (category_code, code) DO NOTHING;
