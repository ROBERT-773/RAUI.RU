-- Expand only: legacy addresses remain unassigned; no guessed regional backfill.
ALTER TABLE addresses ADD COLUMN region_code text
 CHECK(region_code IS NULL OR region_code ~ '^[a-z][a-z0-9_]{0,49}$');

-- Append the new view column to preserve the existing view contract.
CREATE OR REPLACE VIEW public_search_listings AS
SELECT l.id,l.title,l.description,l.price::float8 AS price,l.deal_type,l.published_at,
 p.category_code AS category,p.attributes || jsonb_strip_nulls(jsonb_build_object('floor',f.number,'building_year',EXTRACT(YEAR FROM b.completion_date))) AS attributes,a.formatted AS address,a.locality,a.district,
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
