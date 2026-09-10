# Deployment Freeze Calendar and Exceptions

Deployment freezes exist so that changes do not land while the people who
would notice a problem are unavailable. Every service team's runbook tells you
to check this page before deploying; this is that page.

## Standing freeze windows

- Every Friday from 16:00 local time until Monday 09:00.
- The last two weeks of December.
- Any period a company-wide incident is open at severity 1 or 2.
- The 48 hours before and after a quarterly board demonstration.

## Requesting an exception

Exceptions are granted by the platform on-call lead, not by the requesting
team. Provide the change, the blast radius, who will watch it, and why it
cannot wait. Security patches with a published exploit are pre-approved and
need only an announcement.

## What a freeze does not block

Configuration changes behind an existing flag, documentation updates, and
rollbacks. A rollback is always permitted during a freeze — reversing a bad
change is never the thing a freeze is protecting against.
