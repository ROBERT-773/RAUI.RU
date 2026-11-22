UPDATE attribute_definitions
SET required = true
WHERE category_code = 'commercial'
  AND code = 'commercial_property_type';
