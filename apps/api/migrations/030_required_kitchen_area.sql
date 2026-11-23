UPDATE attribute_definitions
SET required = true
WHERE code = 'kitchen_area'
  AND category_code IN ('apartment', 'aparthotel', 'new_build', 'secondary');
