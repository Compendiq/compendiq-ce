# Notifications Service Deployment Runbook

> Owner: Notifications team · On-call: #notify-oncall · PagerDuty: notify-primary

This runbook describes how the Notifications team deploys **notify-gateway** to production. It
follows the standard platform deployment flow; only the service name, the
on-call rota and the dashboard links differ from other teams' copies.

## Before you deploy

1. Check the deployment freeze calendar. Do not deploy during a freeze window.
2. Confirm the change has an approved pull request and a green CI run.
3. Announce the deploy in #notify-oncall with the release tag.
4. Verify the staging soak has run for at least thirty minutes.

## Deploying

1. Tag the release: `git tag -a notify-gateway-vX.Y.Z -m "release"` and push the tag.
2. The pipeline builds the image and promotes it to the canary tier.
3. Watch the canary for ten minutes. Error rate must stay under 0.5%.
4. Promote to the full fleet with the pipeline's `promote` action.
5. Confirm the version endpoint reports the new tag on every replica.

## After deploying

- Post the release notes in #notify-oncall.
- Update the change record with the tag and the promotion timestamp.
- Leave the canary dashboard open for a further thirty minutes.

## If something looks wrong

Stop the promotion. Page the on-call engineer via PagerDuty: notify-primary. The detailed
recovery steps are **not** in this runbook — follow the platform rollback
procedure, which is maintained separately and applies to every service.

## Routine checks

- Weekly: confirm the pipeline credentials have not expired.
- Monthly: re-run the staging soak against the latest base image.
- Quarterly: review this runbook with the Notifications team and update the rota.
