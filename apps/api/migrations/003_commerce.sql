BEGIN;

CREATE TABLE IF NOT EXISTS commerce_payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  provider text NOT NULL,
  provider_payment_id text,
  reference text NOT NULL,
  idempotency_key text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL,
  state text NOT NULL CHECK (state IN ('created','pending','authorized','captured','failed','cancelled','refunded')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, idempotency_key),
  UNIQUE (provider, provider_payment_id)
);

CREATE INDEX IF NOT EXISTS commerce_payment_orders_account_created_idx
  ON commerce_payment_orders(account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS commerce_payment_orders_state_created_idx
  ON commerce_payment_orders(state, created_at);

CREATE TABLE IF NOT EXISTS commerce_promotion_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('standard','highlighted','premium','vip','super_vip','top')),
  version integer NOT NULL CHECK (version > 0),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL,
  duration_hours integer NOT NULL CHECK (duration_hours > 0),
  priority integer NOT NULL CHECK (priority >= 0),
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, version)
);

CREATE TABLE IF NOT EXISTS commerce_promotion_activations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL,
  listing_id uuid NOT NULL,
  promotion_product_id uuid NOT NULL REFERENCES commerce_promotion_products(id),
  payment_order_id uuid REFERENCES commerce_payment_orders(id),
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','active','expired','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS commerce_promotion_activations_listing_idx
  ON commerce_promotion_activations(listing_id, status, ends_at);

CREATE INDEX IF NOT EXISTS commerce_promotion_activations_account_idx
  ON commerce_promotion_activations(account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS commerce_payment_events (
  id bigserial PRIMARY KEY,
  payment_order_id uuid NOT NULL REFERENCES commerce_payment_orders(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  source text NOT NULL,
  event_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_order_id, event_key)
);

CREATE INDEX IF NOT EXISTS commerce_payment_events_order_created_idx
  ON commerce_payment_events(payment_order_id, created_at);

COMMIT;
