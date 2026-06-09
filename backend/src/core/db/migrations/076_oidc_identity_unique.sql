-- Migration 076: one Compendiq account per OIDC identity
--
-- The EE OIDC SSO provisioning path (provisionOidcUser) looks users up by
-- (oidc_sub, oidc_issuer) and inserts on miss, with no DB-level uniqueness
-- guard. Two concurrent first-logins for the same IdP subject could therefore
-- both pass the lookup and both insert, creating duplicate accounts for one
-- identity (with divergent role/group state). This partial unique index makes
-- "one IdP subject = one user" authoritative; the EE provisioning path now
-- catches the resulting 23505 and converges on the winning row.
--
-- Partial (WHERE oidc_sub IS NOT NULL) so local / non-OIDC users — whose
-- oidc_sub and oidc_issuer are NULL — are entirely unaffected and may coexist.
--
-- NOTE: if a deployment already contains duplicate (oidc_issuer, oidc_sub) rows
-- from the pre-fix behaviour, this index creation will fail; resolve the
-- duplicates (merge/disable the extra accounts) before applying.

CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_identity_uniq
  ON users (oidc_issuer, oidc_sub)
  WHERE oidc_sub IS NOT NULL;
