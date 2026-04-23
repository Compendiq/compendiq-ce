# Compendiq Case Studies

Customer-sourced accounts of what Compendiq is being used for in production. Each study is written with the customer's explicit written consent and reviewed by them before publication.

**Published case studies** appear as peer files in this directory (`<customer-slug>.md`). The three template files prefixed with `_` are **not case studies** — they are the scaffolding used to produce one:

| File                                              | Purpose                                                                   |
|---------------------------------------------------|---------------------------------------------------------------------------|
| [`_template.md`](./_template.md)                  | Blank case-study body; founder + customer fill it in.                     |
| [`_consent-template.md`](./_consent-template.md)  | Legal text + signature block the customer signs before any interview.     |
| [`_interview-script.md`](./_interview-script.md)  | Founder-facing reference — the ~30-minute Q&A prompt list.                |

## How to publish a new case study

1. **Identify** a candidate customer. Preference: regulated industry, on-prem mandate, or a use case that's publicly defensible.
2. **Get consent** — send the customer the signed-consent template. Do **not** start drafting before the signed consent is received. (Consent is reversible; the customer can revoke at any time before publication, and we strip the study from the repo on request even after publication.)
3. **Interview** (~30 minutes, founder-conducted) following `_interview-script.md`. Record only if the consent explicitly permits recording.
4. **Draft** using `_template.md`. Founder reviews. Customer reviews — verbatim quotes require their sign-off. Compendiq does **not** publish concrete numbers (latency figures, user counts, contract-value figures) without customer approval.
5. **Commit** as `docs/case-studies/<customer-slug>.md` in a PR tagged `case-study`. Include a signed copy of the consent (redact PII as needed) as a committed attachment under `docs/case-studies/consent-records/<customer-slug>.signed.md`.
6. **Link** from the main README under "Who's using Compendiq?" if the customer consented to logo/name disclosure; otherwise list anonymously.

## Current status

- Phase A (templates) — ✅ shipped in v0.4.0 alongside this README.
- Phase B (at least one published case study) — ⏳ pending customer consent loop. May slip to v0.5 per the Phase 1.2 plan.

## Review lifecycle

- **First draft** by the founder (or Claude ghost-writing from the interview transcript).
- **Technical review** by the relevant Compendiq engineer — fact-check architecture sketch, deployment numbers, LLM stack details.
- **Customer review** — mandatory before merge. Customer signs off in writing (email or PR comment) that the text accurately represents them.
- **Post-publication**: any numbers cited should be tagged with `_as of YYYY-MM-DD_` so readers understand when the snapshot was taken.
