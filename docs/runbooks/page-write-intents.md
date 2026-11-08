# Runbook — pending page-write intents and the first-publication fence (#281)

An app-side Confluence create dispatches the remote write only after its
intent (`page_write_intents`, kind `pages.create.confluence`) has stored the
page's stated initial AI policy and canonical labels. The remote id is bound
on the intent (`remote_terminal_result.confluenceId`) when Confluence
acknowledges. If that reply is lost, the intent stays `pending` **forever** —
nothing expires it — and while it is unbound it fences the sync walker: every
fresh Confluence import, in every space and for every principal, whose
resolved policy is WEAKER than the unbound statement is deferred, and the
affected spaces' `last_synced` cursor does not advance.

That cost is deliberate: the acknowledged page may have been moved or renamed
before the reply was lost, so no heuristic short of the exact id may clear it.

## Symptoms

- Sync runs report `pagesDeferred > 0` and never emit `sync.completed`; the
  log warns `Space sync did not complete: an outbound Confluence publication
  is awaiting its identity, cursor held (#281)`.
- `spaces.last_synced` stays unchanged for every walked space.
- New Confluence pages do not appear locally although the walk lists them.

## Diagnose

```sql
SELECT id, actor_id, created_at, remote_effect_started_at,
       effect->>'spaceKey'       AS space_key,
       effect->>'initialPolicy'  AS stated_policy,
       effect->'initialLabels'   AS stated_labels
  FROM page_write_intents
 WHERE kind = 'pages.create.confluence'
   AND status = 'pending'
   AND remote_effect_started_at IS NOT NULL
   AND COALESCE(remote_terminal_result->>'confluenceId', '') = '';
```

Each row is one unbound statement. Only rows whose `stated_policy` is
stricter than the ingestion default fence anything (`all` fences nothing).

## Settle

1. Find the page in Confluence by the author, space and time of
   `remote_effect_started_at` (the title hash is in `effect->>'titleSha256'`;
   the author knows the title). Confirm whether the create landed.
2. **Landed:** bind the id. The sync's next walk seeds the row with the
   stated policy and canonical labels.

   ```sql
   UPDATE page_write_intents
      SET remote_effects_completed_at = NOW(),
          remote_terminal_result = jsonb_build_object('confluenceId', '<id>', 'accepted', TRUE)
    WHERE id = '<intent id>' AND status = 'pending';
   ```

3. **Did not land:** record the terminal failure so the intent stops fencing.

   ```sql
   UPDATE page_write_intents
      SET remote_effects_completed_at = NOW(),
          remote_terminal_result = jsonb_build_object('accepted', FALSE, 'reason', 'operator_confirmed_absent'),
          status = 'failed'
    WHERE id = '<intent id>' AND status = 'pending';
   ```

4. Re-run the sync. `pagesDeferred` returns to 0 and the cursor advances.

Never seed a transient row for the page, and never bind an id you have not
read from Confluence: the binding is what the policy seeding trusts.
