---
title: Nightly Postgres backup
tags: postgres, backup, restore
updated: 2026-10-01T00:00:00Z
---
The Postgres dump runs every night at 03:15 UTC and uploads to the bucket `ridgeline-backups`.
Retention is 21 days. To restore, use the wrapper `pgrestore-wrap <dump-name>`; never run raw pg_restore on production.
