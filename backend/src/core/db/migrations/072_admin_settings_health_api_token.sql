-- Migration 072: health API token (Compendiq/compendiq-ee#113 Part A)
--
-- Per-instance opaque bearer token for the internal /api/internal/health
-- endpoint that the compendiq-mgmt instance poller calls every ~5 min to
-- collect lifecycle metrics (version, tier, user count, last sync, error
-- rate). Generated atomically here on first run; subsequent runs are
-- no-ops thanks to ON CONFLICT DO NOTHING (operators rotating the token
-- hand-edit the row or POST to a future rotation route).
--
-- Stored as 64-char lowercase hex (32 bytes of randomness from
-- pgcrypto's gen_random_bytes). pgcrypto is enabled by migration 054.
--
-- Operators rotate via:
--   UPDATE admin_settings
--      SET setting_value = encode(gen_random_bytes(32), 'hex'),
--          updated_at = NOW()
--    WHERE setting_key = 'health_api_token';
--
-- The route in `routes/foundation/health-api.ts` reads this value and
-- compares with `crypto.timingSafeEqual` against the `?token=` query
-- param. Treat the row value as a secret: never log it; never include it
-- in any user-facing API response; never write it to the audit log.

INSERT INTO admin_settings (setting_key, setting_value, updated_at)
VALUES ('health_api_token', encode(gen_random_bytes(32), 'hex'), NOW())
ON CONFLICT (setting_key) DO NOTHING;
