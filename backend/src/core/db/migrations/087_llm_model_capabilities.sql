-- #1154: per-model capability verdicts, probed rather than declared.
--
-- An OpenAI-compatible /v1/models response carries no capability field, and
-- Ollama's capability data lives on native /api/show, which ADR-021 puts
-- off-limits ("the /v1 shim is not a separate protocol"). So capability is
-- established by sending a known image and checking the answer.
--
-- Keyed on (provider_id, model), not on the provider: one host commonly
-- serves both a vision model and a text-only one, and use-case assignments
-- pin provider+model.

CREATE TABLE IF NOT EXISTS llm_model_capabilities (
  provider_id UUID        NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
  model       TEXT        NOT NULL,
  -- NULL = probed but undetermined (network error, breaker open). Distinct
  -- from FALSE so a transient outage cannot permanently mark a capable model
  -- blind; the resolver treats NULL as "re-probe", and gating refuses it.
  vision      BOOLEAN     NULL,
  probed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  probe_error TEXT        NULL,
  PRIMARY KEY (provider_id, model)
);
