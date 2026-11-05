# Changelog

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
