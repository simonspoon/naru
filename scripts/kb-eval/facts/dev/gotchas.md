---
title: Dev gotchas
tags: gotcha, tests, lint, node
updated: 2026-10-01T00:00:00Z
---
The test `test_retry_budget` is flaky in any timezone other than UTC. Fix: `export TZ=UTC` before running the suite.
`make lint` requires Node 20; it breaks on Node 22.
