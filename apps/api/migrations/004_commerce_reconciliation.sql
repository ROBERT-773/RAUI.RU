-- Additive Phase 4A follow-up; 001..003 are immutable.
CREATE TABLE commerce_feature_flags (
  code text PRIMARY KEY CHECK(code IN ('payments','promotions','advertising')),
  enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO commerce_feature_flags(code) VALUES('payments'),('promotions'),('advertising');
CREATE TABLE commerce_reconciliation_jobs (
  order_id uuid PRIMARY KEY REFERENCES commerce_payment_orders(id),
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  dead_at timestamptz,
  checked_at timestamptz
);
CREATE INDEX commerce_reconciliation_claim ON commerce_reconciliation_jobs(available_at,order_id) WHERE dead_at IS NULL;
ALTER TABLE advertising_campaigns ADD COLUMN impressions bigint NOT NULL DEFAULT 0 CHECK(impressions>=0);
ALTER TABLE advertising_campaigns ADD COLUMN clicks bigint NOT NULL DEFAULT 0 CHECK(clicks>=0);
ALTER TABLE advertising_campaigns ADD COLUMN impression_cost_minor bigint NOT NULL DEFAULT 0 CHECK(impression_cost_minor>=0);
ALTER TABLE advertising_campaigns ADD COLUMN click_cost_minor bigint NOT NULL DEFAULT 0 CHECK(click_cost_minor>=0);
CREATE TABLE advertising_events (
  campaign_id uuid NOT NULL REFERENCES advertising_campaigns(id),
  event_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('impression','click')),
  cost_minor bigint NOT NULL CHECK(cost_minor>=0),
  actor_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(campaign_id,event_id)
);
CREATE TRIGGER immutable_advertising_events BEFORE UPDATE OR DELETE ON advertising_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE TRIGGER immutable_commerce_payment_events BEFORE UPDATE OR DELETE ON commerce_payment_events FOR EACH ROW EXECUTE FUNCTION reject_history_mutation();
CREATE UNIQUE INDEX commerce_one_paid_activation ON commerce_promotion_activations(payment_order_id) WHERE payment_order_id IS NOT NULL;
ALTER TABLE commerce_payment_orders ADD CONSTRAINT commerce_account_fk FOREIGN KEY(account_id) REFERENCES users(id) NOT VALID;
ALTER TABLE commerce_promotion_activations ADD CONSTRAINT commerce_activation_account_fk FOREIGN KEY(account_id) REFERENCES users(id) NOT VALID;
ALTER TABLE commerce_promotion_activations ADD CONSTRAINT commerce_activation_listing_fk FOREIGN KEY(listing_id) REFERENCES listings(id) NOT VALID;
ALTER TABLE advertising_campaigns ADD CONSTRAINT commerce_campaign_org_fk FOREIGN KEY(organization_id) REFERENCES organizations(id) NOT VALID;
-- Existing rows stay readable; validate these constraints only after legacy-data
-- reconciliation. PostgreSQL enforces every new/updated row immediately.
