# E2E plugin modules

Resource-watching E2E tests execute the official npm `dist/index.js` artifacts installed from
these exact dev dependencies:

- `@inlang/plugin-json@5.1.57`
- `@inlang/plugin-i18next@6.2.3`
- `@inlang/plugin-t-function-matcher@2.0.24`

`test/helpers/pluginFixtureServer.ts` serves the installed artifacts on loopback. The package
lock records their npm integrity hashes, so test execution is deterministic and does not contact
jsDelivr or another live module host after normal dependency installation.

## Refresh-count observability

VS Code exposes source-diagnostic changes to extension-host tests, but Sherlock does not expose a
public reconciliation-idle event. The post-reload E2E assertions therefore count diagnostic
changes until a one-second quiet period and assert that the observed count is one. This is the
strongest existing public contract, but it cannot mathematically exclude a second refresh that
arrives after that quiet period. Widening the production API solely for a test hook was deliberately
avoided. Deterministic barrier tests in `projectSession.test.ts` provide the complementary exact
guarantee: arbitrary events during an active reconciliation produce at most one trailing load, and
same-path handoff retains that bounded work without starting an unlimited reload chain.
