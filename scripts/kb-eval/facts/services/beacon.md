---
title: Beacon notification service
tags: beacon, notifications, go
updated: 2026-10-01T00:00:00Z
---
Beacon is the notification service. It is written in Go, listens on port 8472 and reads its config from /etc/beacon/beacon.toml.
It depends on the Redis instance cache-3. Owned by the Platform team.
