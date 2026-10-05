-- Forward-only separation: known provider-reported cost versus uncertain budget exposure.
-- Preserve legacy usage values with an explicit unverified basis; do not invent a backfill.
ALTER TABLE ai_budget_days ADD COLUMN uncertain_micros bigint NOT NULL DEFAULT 0 CHECK(uncertain_micros>=0);
UPDATE ai_budget_days SET uncertain_micros=spent_micros,spent_micros=0;
ALTER TABLE ai_usage ADD COLUMN cost_basis text NOT NULL DEFAULT 'legacy_unverified' CHECK(cost_basis IN ('legacy_unverified','reported_only'));
ALTER TABLE ai_usage ADD COLUMN unknown_cost_attempts integer NOT NULL DEFAULT 0 CHECK(unknown_cost_attempts BETWEEN 0 AND 2);
ALTER TABLE ai_usage ADD COLUMN uncertain_micros bigint NOT NULL DEFAULT 0 CHECK(uncertain_micros>=0);
COMMENT ON COLUMN ai_budget_days.spent_micros IS 'Valid provider-reported usage only; not a reconciled external invoice';
COMMENT ON COLUMN ai_budget_days.uncertain_micros IS 'Conservative unknown/legacy exposure consuming budget, not known spend';
COMMENT ON COLUMN ai_usage.cost_basis IS 'Legacy values retained without claiming confirmed provider usage';
