# &lt;Customer Name&gt; — &lt;one-line outcome&gt;

**Industry:** _[e.g. Financial services, Healthcare, Public sector, …]_
**Deployment:** _[CE / EE / EE multi-instance]_
**Scale:** _[N users, M Confluence spaces, K pages — numbers only with customer approval]_
**Time to first value:** _[e.g. "~3 weeks from kickoff to the first production RAG query"]_
**Published:** _[YYYY-MM-DD]_
**Customer-reviewed:** _[YYYY-MM-DD, reviewer name (with consent)]_

---

## The problem

_[2–3 paragraphs in the customer's voice. Focus on the business pain, not the technology. Avoid vendor-comparison hyperbole — a concrete "our incident runbooks were spread across 400 Confluence pages and new hires took 6 weeks to ramp" beats "we needed AI to modernise our knowledge base"._

_Include direct quotes only with customer sign-off. Quotes should be attributed by role, not name, unless the quoted person has separately consented.]_

> _"Representative pull quote from the interview, 1–2 sentences, sounds like a human."_
> — _Role, Department_

## Why Compendiq

_[What was evaluated (Confluence AI plugins, Glean, internal tools, status quo). What drove the decision (on-prem requirement, open-source audit trail, price, German data-residency, etc.). Where Compendiq was a weaker fit than alternatives if any — being honest here earns credibility.]_

## What they deployed

_[Architecture sketch. Single pod vs. multi-pod. Air-gapped or network-exposed. Which LLM stack (Ollama on-prem, Azure OpenAI, vLLM). Any notable integrations (OIDC, SCIM, SMTP host). Avoid a screenshot if it would reveal internal URLs; a prose description is fine.]_

## Results

_[Concrete numbers — only with customer sign-off. Examples (illustrative):_
- _Median time to answer a runbook question dropped from ~12 min to ~35 s._
- _N% of draft Confluence pages now go through the "improve with AI" flow before publication._
- _Zero prompt-injection incidents in the first X months (audited via `llm_audit_log`)._

_If no numbers are approved, focus on qualitative outcomes and explicitly note that numbers are withheld.]_

## What's next for them

_[Open asks, planned expansion, feedback that influenced the Compendiq roadmap. A pointer at a specific phase item on the public roadmap where relevant.]_

---

*Published with permission. Compendiq retains the right to remove this case study on customer request. For fact corrections, open a PR tagged `case-study`.*
