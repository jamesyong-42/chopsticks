# Chopsticks

Chopsticks hosts coding agents' native terminal interfaces while providing a
provider-neutral TypeScript runtime for lifecycle, observation, prompt control,
workspace isolation, and operational receipts.

The agent owns its terminal UI. Chopsticks owns the process environment around
that UI and derives semantic state from native hooks or structured protocols,
never by scraping terminal text.

## Packages

- `@vibecook/chopsticks-runtime` — unified runtime and built-in Claude, Codex,
  and Grok providers.
- `@vibecook/chopsticks-core` — zero-I/O event, state, session, and host
  contracts.
- `@vibecook/chopsticks-workspaces` — direct, exclusive, worktree, and copy
  workspace modes.
- `@vibecook/chopsticks-adapter-{claude,codex,acp,grok}` — provider-specific
  observation and control.
- `@vibecook/chopsticks-record` — append-only records of runtime-owned actions.
- `@vibecook/chopsticks-testing` — fake agent and adapter conformance helpers.

The private Electron workbench is a development application, not part of the
published package graph. Consumers supply an `AgentHost` backed by their own
terminal service.

## Install

```sh
pnpm add @vibecook/chopsticks-runtime@0.1.0
```

Node.js 22 or newer is required.

## Built-in launch options

The selected agent discriminates the available launch options:

```ts
await runtime.createSession({
  agent: 'claude',
  workspace: { mode: 'worktree', path: process.cwd() },
  agentOptions: {
    model: 'sonnet',
    permissionMode: 'plan',
  },
});

await runtime.createSession({
  agent: 'codex',
  agentOptions: {
    sandbox: 'read-only',
    approvalPolicy: 'never',
  },
});
```

Codex safety options apply when creating a fresh thread. Resumed threads retain
their existing configuration. Structured approval routing is intentionally not
part of these launch options; it requires a reattachable session-control
contract so daemon restarts do not lose callback closures.

## Development

```sh
pnpm install
pnpm test
pnpm build
pnpm pack:check
```

Live adapter probes are opt-in with `CODEX_LIVE=1`, `GROK_LIVE=1`, or
`CHOPSTICKS_REAL_CLAUDE=1`.

## Versioning

All public Chopsticks packages release in lockstep. Internal `workspace:*`
dependencies are rewritten by pnpm to that exact version in published
tarballs. Applications should pin `@vibecook/chopsticks-runtime` exactly and
upgrade it as a deliberate integration event.

The initial `0.1.0` publication is bootstrapped from the tagged release commit:

```sh
pnpm release:publish
pnpm release:trust
```

`release:publish` verifies, builds, and publishes the public packages in
dependency order, skipping versions already present in the registry.
`release:trust` configures each package to trust `jamesyong-42/chopsticks`'s
`release.yml` GitHub Actions workflow for `npm publish`; it requires npm 11.15
or newer, npm account 2FA, and an authenticated interactive npm session.

Afterward, release-please owns release PRs and tags, and the Release workflow
publishes through tokenless npm trusted publishing. Manually dispatch that
workflow at an existing release tag only when retrying a partial publication.
