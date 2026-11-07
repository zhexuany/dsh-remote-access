# Changelog

## Unreleased

- Downlink mux frames now carry a much smaller payload: the Host neutralises replayed
  `assistant/message.data.stream` events (≈48% of a real window; `data.stream` becomes `[]`, because client
  trace folding iterates it), deflates the result, and splits it into bounded `DSHD1 <idx> <total>` chunks
  (`muxChunkBytes`, default 256 KiB). A 2.6 MB sample frame goes 2.6 MB → 1.3 MB after stripping → 266 KB on
  the wire (≈90% smaller), and the client reassembles chunks before one `DecompressionStream` inflate, so a
  single giant frame no longer stalls the tunnel. `stripStreamingReplay` (true) and `muxChunkBytes` are new
  knobs; chunk reassembly is verified end-to-end through a quick tunnel.
- The client half memoises read-only startup RPCs (`skills/list`, `commands/list`, `agentPresets/list`,
  `settings/describe`, `session/modelCatalog`, `llm/listProviders`) behind `rpcCacheMs` (default 30s, `0`
  disables), keyed by channel + endpoint + payload and invalidated by namespace, so a switch no longer pays
  5–6 serial HTTP round trips. Keep-warm session retention was evaluated and rejected: releasing the main
  view tears down its scope/event stream and holding an extra reference leaks Host activation and unbounded
  windows (design note in the development notes).
- Conversation switches over a tunnel no longer ship the whole history window as plain JSON. Cloudflare's
  edge strips `Sec-WebSocket-Extensions` from the gateway's `101`, so the origin's permessage-deflate never
  negotiates (4× left on the table). The Host now registers an upgrade route `/remote-access/mux`; the web
  client reroutes its mux socket there with `?deflate=1`, the proxy authenticates upstream with the browser's
  cookie, and downlink text frames at or above `muxCompressionThresholdBytes` (default 1 KB) are sent as
  deflate-raw binary frames that the browser inflates with `DecompressionStream`. Loopback access and browsers
  without `DecompressionStream` keep the direct path; failures fall back to it. Measured on a 700 KB/s,
  80 ms link: a 1.1 MB window became ~0.22 MB and the slowest sampled switch went from 4.0s to 1.8s.
- The client half also narrows the initial history window: `follow`/`loadOlder` request
  `initialWindowMessages` (default 60) instead of the controller's 500, so a switch pays for the last
  screenful rather than the whole session. Older history is fetched page by page on scroll-up. Set it to `0`
  to keep DSH's own window, or pair `muxCompression: false` with it if only one of the two changes is wanted.
- `status` gained a `mux` counter block (`connections`, `downlinkRawBytes`, `compressedBytes`,
  `compressedFrames`, `recentFrames`, …) plus `muxCompression` and `initialWindowMessages`, so the panel, CLI
  and tests can tell whether compression actually engaged.
- New transport knobs: `muxCompression` (true), `muxCompressionLevel` (4, 1–9),
  `muxCompressionThresholdBytes` (1024), `muxHandshakeTimeoutMs` (8000). The proxy and a dependency-free
  RFC 6455 codec live in `lib/mux-proxy.js` / `lib/ws.js`; both have offline unit tests (`ws-unit`,
  `mux-proxy-unit`) wired into `test/run-tests.sh`.
- Added a public-URL watchdog. A dead edge connection — typically a quick tunnel whose server-side record is
  gone (`Unauthorized: Tunnel not found`) — makes cloudflared retry forever without exiting, so the supervisor
  used to keep reporting `ready` while the share link answered 502/530/1033. It now probes the public URL every
  `healthCheckMs` (default 15s, `0` disables), accepts only answers that came from this Host (200/303/401/403),
  and restarts cloudflared after `healthFailures` (default 3) consecutive misses, which mints a fresh quick
  tunnel and link. `status` gained `health: { checkedAt, ok, failures, restarts }`, `healthCheckMs` and
  `healthFailures`; `healthCheckTimeoutMs` (default 8s) bounds one probe. Resolution failures during the first
  `healthDnsGraceMs` (default 120s) of a fresh quick tunnel are treated as inconclusive instead of unhealthy: a
  brand-new trycloudflare hostname can take a minute to resolve, and restarting cannot fix DNS.

## 0.2.0 — 2026-10-30

- DSH Desktop `0.2.1-rc.3` removed the host browser-access gate: `webServer.setBrowserAccess()` no longer
  exists and nothing reads `desktop-preferences.json → browserAccess`. The plugin no longer calls it, and it
  no longer latches the failure into `status.error` (that single stale line is what the panel and CLI kept
  showing long after the one failed attempt).
- `status` now reports `access: { mode: 'token-link', state, checkedAt, gate: 'absent' }` instead of
  `browserAccess` / `temporaryBrowserAccess` / `savedBrowserAccess` / `supportsBrowserSwitch`.
  `state` is `token-required` (401 — healthy), `open` (200/303), `refused` (403 — the tunnel authority is
  missing from `trustedHosts`) or `unknown`. The probe never throws and never writes an error.
- The settings panel lost the "temporary switch" buttons (they could not work on this Host): it now shows a
  permanent note that the Desktop toggle is gone, plus a red hint when the probe is refused.
  `browser-access` stays as a compatibility endpoint and answers `unsupported: true` with a reason.
- README, CLI help and the installer's `--enable-browser-access` flag reworded: the tokenised share link
  plus `trustedHosts` is the whole access story; there is no Desktop toggle left to flip.
- Tests: `service-unit`, `client-smoke` and `client-react` (modes `ready` / `refused` / `unknown`) rewritten
  for the new contract; the panel smoke test no longer requires a resolvable `node_modules/react` inside the
  installed app (React is bundled into the renderer assets).

## 0.1.0 — 2026-10-20

- Initial public release.
- DSH bundle: host tunnel service plus a Web settings panel.
- Supports Cloudflare Quick/Named tunnels, SSH reverse tunnels, and custom commands.
- Publishes the tunnel authority into `connection.trustedHosts` at runtime.
- Compatible with DSH Desktop `0.2.1-rc.2` (official Desktop).
- `autoStart` now defaults to `false`; start the tunnel explicitly from the panel.
- `cloudflared` is resolved from configuration, `<DSH_HOME>/remote-access/bin`,
  the package `vendor/` directory used by local installs, or `PATH`.
