# Platform Rollback Procedure for Failed Deployments

This is the single authoritative procedure for reversing a deployment that has
gone wrong. Every service team's deployment runbook defers to this document
rather than repeating it, so that the recovery steps cannot drift per team.

## Decide whether to roll back

Roll back immediately if any of the following holds after promotion:

- error rate above 2% sustained for five minutes
- p99 latency more than double the pre-deploy baseline
- any data-corruption signal, however small
- the on-call engineer is unsure and the change is not urgent

Do not attempt a forward fix under pressure. Roll back first, diagnose after.

## Perform the rollback

1. Halt any in-flight promotion in the pipeline.
2. Select the previous known-good image digest from the release ledger.
3. Run the pipeline's `rollback` action against that digest.
4. Watch replicas cycle back. A full fleet reversal takes about four minutes.
5. Confirm the version endpoint reports the previous tag everywhere.

## Database changes make rollback harder

If the release included a migration, the image rollback alone is not enough.
Additive migrations are safe to leave in place. Destructive migrations must be
reversed with the paired down-migration before the old image will start, and a
migration that dropped a column cannot be reversed without a restore.

## After the rollback

Open an incident record, attach the canary dashboard screenshots, and schedule
a postmortem within two working days.
