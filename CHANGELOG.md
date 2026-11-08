# Changelog

## Unreleased

- Reconnect diagnostics and edge hardening for flaky paths. The mux proxy now records *who* closed a mux
  socket (`status.mux.closedBy` = browser / upstream / failure / dispose) with the last close code in
  `status.mux.lastClose`, so a "reconnecting" banner can be attributed instead of guessed. cloudflared gains
  two optional knobs that default to cloudflared's own defaults (`edgeIpVersion` = auto, `tunnelRetries` = 5):
  pin `4` on hosts whose IPv6 route is black-holed, or raise the retry budget for connection/protocol errors.
  Remote pages also report every page WebSocket close (`status.wsRecent`), because the banner is usually caused by
  the unproxied sidebar socket that the mux counters never see.
  The managed mux heartbeat moves 15s -> 30s: a peer that misses pongs is now reaped after 60-90 s instead of
  30-45 s, so a frozen tab or a brief Wi-Fi stall is tolerated longer. This only takes effect after a Desktop
  restart, and a profile patched by an older installer needs `bin/install.mjs` re-run to pick up 30000. A
  network change (new NAT binding / 4-tuple) still kills the socket outright; nothing here can prevent that.
