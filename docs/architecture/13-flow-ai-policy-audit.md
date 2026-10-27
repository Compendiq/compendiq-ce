# 13. Article AI policy audit flow

```mermaid
flowchart TD
    admission["CE authoritative article/provider admission"] --> decision{"admitted or blocked"}
    decision --> typed["onAiDecision: one event per stage attempt"]
    decision --> dispatch["only admitted decisions may dispatch"]
    typed --> writer["EE strict shared-schema writer"]
    writer --> events["ai_governance_events v1<br/>complete JSON article associations"]
    writer -->|failure| warning["CE observer warning; denial unchanged"]
    cascade["EE owner-scoped cascade"] --> transaction["hierarchy/lifecycle/AIP transaction<br/>shared policy + labels + purge/requeue + revisions"]
    transaction --> held["persistAiPolicyChange on held client<br/>old/new policies and revisions; operation/cascade ID"]
    held --> events
    held -->|failure| rollback["caller rolls back mutation and evidence"]
    held --> commit["caller commits rows and evidence together"]
    ordinary["CE ordinary policy/label mutations"] --> transaction
    legacy["Retained legacy evidence"] --> old["ai_policy_enforcement_events<br/>legacy unknown operation/locality coverage"]
    events --> report["historical operations and stage attempts<br/>full association JSON in CSV"]
    old --> report
    pages["current nondeleted pages"] --> snapshot["generation-time policy snapshot"]
    snapshot --> report
    usage["llm_audit_log: usage counted once"] --> report
    report --> layout["Measured wrapping and paginated PDF<br/>all metadata and caveats; reserved footer band"]
    layout --> zip["ZIP: escaped CSV + unsigned PDF cover<br/>full CSV SHA-256 and report identity visible"]
```

Strict shared `AiDecisionEvent` and `AiPolicyChangeEvent` schemas contain no
content, endpoint or usage fields. JSON arrays preserve every article association,
including policy/content revisions. Captured locality is never reconstructed from
current settings. Exact event replay is idempotent; reusing an ID for different
evidence fails. The held-client sink never commits, opens another transaction,
uses the pool or swallows failures. The shared `applyAiPolicyOnClient` primitive
awaits this sink once for the complete change set. Ordinary mutations and EE
cascades use that same producer without duplicate legacy emission; EE supplies
its operation/cascade identity but does not persist a second event. Native
signed-license HTTP tests check the aggregate and sink-failure rollback. Retained
legacy evidence remains explicitly legacy. Cascade previews refuse unsafe bigint
revision tokens rather than rounding them into an unusable compare-and-swap set.

Decision delivery is best effort with surfaced observer warnings; failed delivery
never permits a denied dispatch. No automatic retention duration is configured
for the new table. Database administration, manual deletion and restores can
leave gaps. Schema installation and earliest retained rows are coverage bounds,
not completeness proofs. There is no browser execution observer. Provenance IDs
grant no page-read permission. Exported actor identifiers are pseudonymized.

> This report summarizes recorded application policy decisions. Locality is administrator-declared. It does not attest model execution, upstream forwarding, or absence of unrecorded/external egress.

See [enterprise hooks](./10-flow-enterprise-license.md),
[database schema](./06-data-model.md), and
[typed evidence schema](./14-ai-governance-evidence-schema.md).
License loss disables EE management, not enforcement of stored restrictions.
