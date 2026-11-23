CREATE OR REPLACE VIEW public_search_listings AS
SELECT l.id,l.title,l.description,l.price::float8 AS price,l.deal_type,l.published_at,
 p.category_code AS category,
 (p.attributes - 'rent_deposit' - 'rent_commission' - 'utilities_included')
 || jsonb_strip_nulls(jsonb_build_object('floor',f.number,'building_year',EXTRACT(YEAR FROM b.completion_date)))
 || CASE WHEN l.deal_type IN ('long_rent','short_rent') AND jsonb_typeof(l.terms->'deposit')='number'
         THEN jsonb_build_object('rent_deposit',l.terms->'deposit') ELSE '{}'::jsonb END
 || CASE WHEN l.deal_type='long_rent' AND jsonb_typeof(l.terms->'commission')='number'
         THEN jsonb_build_object('rent_commission',l.terms->'commission') ELSE '{}'::jsonb END
 || CASE WHEN l.deal_type='long_rent' AND jsonb_typeof(l.terms->'utilitiesIncluded')='boolean'
         THEN jsonb_build_object('utilities_included',l.terms->'utilitiesIncluded') ELSE '{}'::jsonb END AS attributes,
 a.formatted AS address,a.locality,a.district,
 ST_X(a.point) AS longitude,ST_Y(a.point) AS latitude,a.point,
 u.role AS seller_type,s.kind AS source_type,
 CASE WHEN (p.attributes->>'area') ~ '^[0-9]+(\.[0-9]+)?$' THEN l.price::float8 / NULLIF((p.attributes->>'area')::float8,0) END AS price_per_m2,a.region_code
FROM listings l JOIN users u ON u.id=l.seller_id JOIN properties p ON p.id=l.property_id
JOIN addresses a ON a.id=p.address_id JOIN listing_sources s ON s.id=l.source_id
LEFT JOIN floors f ON f.id=p.floor_id LEFT JOIN buildings b ON b.id=p.building_id
WHERE l.status='published' AND u.active AND u.email_verified_at IS NOT NULL AND u.phone_verified_at IS NOT NULL
AND u.role IN ('owner','agent','agency','developer','admin')
AND (l.organization_id IS NULL OR EXISTS(SELECT 1 FROM organizations o JOIN memberships m ON m.organization_id=o.id
 WHERE o.id=l.organization_id AND o.active AND m.user_id=l.seller_id AND m.active));
