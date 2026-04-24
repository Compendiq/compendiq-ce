-- Migration 066: webhook subscription registry (Compendiq/compendiq-ee#114)
--
-- Primary table behind the Enterprise webhook push feature. Each row is an
-- admin-configured external endpoint that receives HMAC-signed POSTs when
-- events they subscribed to occur. Secret encryption at rest uses the same
-- AES-256-GCM primitive + PAT_ENCRYPTION_KEY as Confluence PATs.
--
-- Secret rotation semantics (standardwebhooks convention):
--   - `secret_enc`            primary signing key — every new delivery is
--                             signed with this.
--   - `secret_hint`           last 4 chars of the plaintext secret shown in
--                             the admin UI so the operator can visually
--                             correlate their receiver's configured secret
--                             without ever exfiltrating it.
--   - `secret_secondary_enc`  optional — rotation staging. Receivers can
--                             accept signatures from EITHER key during the
--                             overlap window so a key rotation never drops
--                             deliveries. Promoted to primary + cleared
--                             when rotation completes.
--   - `secret_secondary_added` timestamp of the rotation start; UI surfaces
--                             it so the operator can see how long the
--                             overlap window has been open.
--
-- `event_types` is an allowlist per subscription. Empty array = subscribe
-- to nothing (useful while configuring). A row is only considered for an
-- outgoing event when `active=true` AND `event_type = ANY(event_types)`.
--
-- Slot rationale: plan .plans/114-webhooks.md §1.1 originally named 064;
-- CE dev has since moved past (064 = local_attachments, 065 =
-- page_restrictions_sync from EE #112), so this migration takes 066.

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                  TEXT,
  url                    TEXT NOT NULL,
  secret_enc             BYTEA NOT NULL,
  secret_hint            TEXT,
  event_types            TEXT[] NOT NULL DEFAULT '{}',
  active                 BOOLEAN NOT NULL DEFAULT TRUE,
  secret_secondary_enc   BYTEA,
  secret_secondary_added TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_user_id
  ON webhook_subscriptions (user_id);
