# Article-stage model selection

```mermaid
sequenceDiagram
    participant T as Queued transport
    participant A as Article admission transaction
    participant R as Held-client resolver
    participant DB as PostgreSQL
    T->>A: Exact transport, model and server provenance
    A->>R: Assigned or explicit model intent
    R->>DB: SHARE assignment and provider tables
    Note over R,DB: Conflicts with SQL INSERT, UPDATE and DELETE, including absent assignments
    R->>R: Resolve saved assignment/default and held-client enterprise hook
    R->>R: Honor explicit text model unless a binding EE override applies
    A->>DB: Validate article and concrete transport revisions
    A->>DB: COMMIT
    A-->>T: Admitted
    T->>T: HTTP outside transaction
```

The CE dispatch resolver bypasses process caches and uses only the held
admission client. Table fences precede page/provider row locks and cover default
and assignment insertion/deletion as well as updates. They serialize with native
SQL writers, including writers that do not use advisory locks. Explicit model
intent cannot change the resolved provider. Existing text routes may choose a
model on that provider; saved assignments are defaults, not model allow-lists.
Vector and vision stages cannot use this text override. Non-inheriting stages
remain disabled when not assigned. An enterprise override, when present, pins the model as well as provider.

The new optional `resolveUsecaseOverrideOnClient` seam must read and fence EE
policy/department state on this same transaction. An installed legacy override
without that seam fails closed; it is never silently replaced by CE defaults.
The genuine overlay suite covers held-client policy and quota resolution,
including quota-writer fencing. Passing that suite does not establish that all
backend consumers have completed the mandatory transport-context migration.
Restrictive activation remains closed. The schema/API does not establish full
producer enforcement or universal data-loss prevention.
