# How Canary Analysis Decides to Promote or Halt

Each team's deployment runbook says to "watch the canary for ten minutes".
This page explains what the canary analyser is actually comparing, so that the
number is not a superstition.

## The comparison

The analyser holds two populations: the canary replicas on the new image and a
baseline group on the current image, both taking live traffic. It compares
error rate, p50 and p99 latency, and saturation, and it requires a minimum
sample before any verdict — on a low-traffic service the ten minutes may not
produce enough requests, and the analyser will say so rather than pass.

## Why it halts

A halt means a metric crossed its threshold with enough samples to be
confident. The analyser does not roll back on its own; it stops the promotion
and pages the on-call engineer, who decides.

## Tuning thresholds

Thresholds live with the service, not with the pipeline. Loosening them to get
a release out is the single most common cause of a bad change reaching the
full fleet.
