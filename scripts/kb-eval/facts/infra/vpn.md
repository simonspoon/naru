---
title: Corporate VPN (WireGuard)
tags: vpn, wireguard, network
updated: 2026-10-01T00:00:00Z
---
The VPN client is WireGuard, profile name `hl-corp`, config in ~/.wg/hl-corp.conf. Internal DNS is 10.20.0.2.
If the tunnel comes up but no traffic flows (handshake stalls), restart it with `wg-quick down hl-corp && wg-quick up hl-corp`.
