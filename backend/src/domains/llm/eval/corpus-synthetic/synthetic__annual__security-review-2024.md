# 2024 Annual Security Review — Findings and Remediation

> Reviewed: 2024 · Status: closed

The annual security review examines authentication, secret handling, dependency
hygiene and access control across all production services. This is the 2024
edition; earlier editions are retained unchanged for audit purposes and should
not be edited.

## Scope

All production services, their CI pipelines and their data stores. Excluded:
developer laptops, and any pre-production environment holding no real data.

## Findings

1. **Secret rotation lag.** 6 services held credentials older than the
   90-day rotation policy. Remediation: automated rotation reminders.
2. **Dependency drift.** 22 direct dependencies were more than two minor
   versions behind. Remediation: scheduled upgrade window each month.
3. **Over-broad access grants.** 14 accounts retained write access to
   repositories they had not touched in six months. Remediation: quarterly
   access review with automatic expiry.

## Status of the previous year's actions

All prior actions completed; rotation automation shipped.

## Sign-off

Reviewed by the platform security group. The next review is scheduled for the
same period next year.
