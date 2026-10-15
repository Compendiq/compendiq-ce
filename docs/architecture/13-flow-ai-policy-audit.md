# 13. Article AI policy audit flow

```mermaid
flowchart TD
    admission["CE authoritative article/provider admission"] --> decision{"admitted or blocked"}
    decision --> hook["typed onAiPolicyEvent observer"]
    decision --> dispatch["only admitted decisions may dispatch"]
    cascade["EE exact owner-scoped cascade"] --> transaction["hierarchy/lifecycle/AIP transaction<br/>shared policy mutation + content revision"]
    transaction --> evidence["cascade_committed from actual shared changes"]
    evidence --> commit["COMMIT rows and evidence together"]
    transaction -->|refusal| rollback["ROLLBACK all rows and evidence"]
    commit --> changes["emitAiPolicyChanges after COMMIT"]
    ordinary["ordinary committed CE policy changes"] --> changes
    changes --> hook
    hook --> writer["EE recordAiPolicyEvent"]
    writer -->|success| events["ai_policy_enforcement_events"]
    writer -->|failure| warning["warning; missing evidence<br/>never changes admission result"]
    commit --> events
    events --> report["Model Governance Evidence cover<br/>historical event-row counts"]
    pages["current nondeleted pages"] --> snapshot["generation-time policy snapshot<br/>not historical reconstruction"]
    snapshot --> report
    audit["retained llm_audit_log"] --> csv["existing escaped CSV<br/>single token/cost accounting"]
    csv --> zip["ZIP: CSV + unsigned PDF cover<br/>CSV SHA-256 on cover"]
    report --> zip
```

The typed decision records store article/provider identifiers and available
revisions, never titles, prompts, completions, attachment bytes, credentials
or endpoint URLs. The policy observer does not create successful inference
rows or charge usage. Provenance identifiers grant no page-read permission.

Cascade records are transactional; normal policy/decision recording is a
best-effort asynchronous observer, not a durable retry system. These are
application records subject to database administration and retention, not
immutable or cryptographically attested logs. Missing locality, blocked-event
revisions, operation identities and complete mixed-article associations are
unknown. Counts are event rows, not distinct requests. No browser execution
observer exists. Retained gaps are not reconstructed from current settings.
Unreadable event/page sections are explicitly unavailable, not zero.

The report carries this exact limitation:

> This report summarizes recorded application policy decisions. Locality is administrator-declared. It does not attest model execution, upstream forwarding, or absence of unrecorded/external egress.

See [enterprise hooks](./10-flow-enterprise-license.md) and
[database schema](./06-data-model.md). CE hooks remain inert without EE; stored
article restrictions remain enforced after license loss.
