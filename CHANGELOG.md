# Changelog

## [0.1.1](https://github.com/jamesyong-42/chopsticks/compare/chopsticks-v0.1.0...chopsticks-v0.1.1) (2026-07-19)


### Features

* **adapter-acp:** generic ACP structured driver + normalizer (M6 A2-A4) ([68a2460](https://github.com/jamesyong-42/chopsticks/commit/68a2460e36cbbb1c9ad493afd7b4ddb6f606a5cd))
* **adapter-claude:** createClaudeSession driver — hub-side composition (M2) ([ac80e6f](https://github.com/jamesyong-42/chopsticks/commit/ac80e6f15d433f2c578b27ef0d23458ead973353))
* **adapter-claude:** detection probe, registry-driven settings gen, session prepare (M2-1/M2-3) ([c568aa7](https://github.com/jamesyong-42/chopsticks/commit/c568aa7fe07af684d1489e68723a5650159f2a41))
* **adapter-claude:** hook registry, loopback hook bridge, event normalizer (M2-1/M2-2/M2-4 core) ([744952e](https://github.com/jamesyong-42/chopsticks/commit/744952e2c97167ef446f5877bd5192d778961bf0))
* **adapter-claude:** transcript observer over spaghetti + guarded prompt injection (M2-5/M2-6) ([b98ce4e](https://github.com/jamesyong-42/chopsticks/commit/b98ce4e969eec2f794093df0fec109aee2f9ae7e))
* **adapter-codex:** app-server notification normalizer (M5 C2) ([a50d914](https://github.com/jamesyong-42/chopsticks/commit/a50d91427d8045547fbd10c0bf0f386b8d1e2e24))
* **adapter-codex:** createCodexObserver — attach + observe a TUI thread (M5 C6-2) ([10c85d7](https://github.com/jamesyong-42/chopsticks/commit/10c85d70e3ae219aab4926f1dc2bd14d2d8cdaec))
* **adapter-codex:** createCodexSession structured driver (M5 C4) ([0d59cb3](https://github.com/jamesyong-42/chopsticks/commit/0d59cb37d07bda77c00ed163898c478270b3b25e))
* **adapter-codex:** WebSocket-over-UDS transport + app-server spawn (M5 C6-1) ([fca95e8](https://github.com/jamesyong-42/chopsticks/commit/fca95e8deceb415e2f5076ba69493c1e55b74ddd))
* add agent launch options and release pipeline ([37dd9c5](https://github.com/jamesyong-42/chopsticks/commit/37dd9c5dd95fa16f3ecd4294823bff489bad9764))
* **core:** full AgentEvent union + session state reducer (M0-2, M0-3) ([d06c8cb](https://github.com/jamesyong-42/chopsticks/commit/d06c8cb04032ed3448af412ecff76e82e9ae0cfb))
* migrate workbench terminals to Ghosttea ([1eea6db](https://github.com/jamesyong-42/chopsticks/commit/1eea6dbf777014f859219e7d37a099ae6efa1b25))
* **node:** @xterm/headless mirror sink with serialize snapshots (M1-3) ([efa5dd1](https://github.com/jamesyong-42/chopsticks/commit/efa5dd1f065d861bd222bff24b03f65b6c36135d))
* **node:** PTY transport, process-tree ladder, ordered terminal distributor (M1-1..M1-3 core) ([5518204](https://github.com/jamesyong-42/chopsticks/commit/5518204cf27f0fa3428eb8acd7b8b1dbe11c0e90))
* **record,adapter-claude:** own-action record + native resume (M4) ([f371f75](https://github.com/jamesyong-42/chopsticks/commit/f371f7522d439e90be42c07357118b744294e508))
* **testing:** fake terminal agent + Phase 0 hook fixtures (M0-4) ([1be5bf4](https://github.com/jamesyong-42/chopsticks/commit/1be5bf4f94c8207b2e5c41799058229491e6d18e))
* **workbench:** Claude sessions in the workbench — driver wiring + activity panel (M2) ([ad3a37a](https://github.com/jamesyong-42/chopsticks/commit/ad3a37a1ae922cdcb53498f5473b02f71bd102ef))
* **workbench:** Codex sessions — native TUI tab + structured observer (M5 C6-3) ([c8d18fa](https://github.com/jamesyong-42/chopsticks/commit/c8d18facd1c0e647ef713e2271c0efe80bea42af))
* **workbench:** control Codex from the panel — bracketed-paste injection (M5 C6-4) ([93e4e0a](https://github.com/jamesyong-42/chopsticks/commit/93e4e0aa44a571a13aebb8d1c84dd054ba0443ec))
* **workbench:** Electron dev app with system-Node pty-host (M1-4) ([6b8d5c4](https://github.com/jamesyong-42/chopsticks/commit/6b8d5c40ec65610fe1a122d120de2709f8cff39b))
* **workbench:** Ghostty-fashion terminal UI via avocado TerminalSurface ([9a8b39a](https://github.com/jamesyong-42/chopsticks/commit/9a8b39ad2d54b01b3fe573a0186b176c68f698e9))
* **workbench:** Grok tab — native TUI + leader coexistence (M6 A6c) ([64b11b8](https://github.com/jamesyong-42/chopsticks/commit/64b11b89903ea6b5528246e9742c60b875f0478e))
* **workbench:** own-action record wiring + resume affordance (M4) ([0316ec2](https://github.com/jamesyong-42/chopsticks/commit/0316ec230a8e619e19d27340589436c3445c3441))
* **workbench:** redesign the agent panel as a proper chat UI ([63ea1f1](https://github.com/jamesyong-42/chopsticks/commit/63ea1f1e7b724d988bcf68934dd1f246ba01ec16))
* **workbench:** workspace isolation for Claude sessions (M3) ([54fb120](https://github.com/jamesyong-42/chopsticks/commit/54fb120d6799f2fd997607fa1f0023cd17258d53))
* **workspaces:** shared / git-worktree / copy isolation with final-diff metadata (M3) ([87c1cda](https://github.com/jamesyong-42/chopsticks/commit/87c1cda80b683fadceca4918f9af239d32744576))


### Bug Fixes

* **adapter-codex:** own thread at spawn so panel leaves preparing immediately ([601a067](https://github.com/jamesyong-42/chopsticks/commit/601a067c6d75680a615b2c30b9d1ba5567e352d3))
* **adapter-codex:** retry thread attach until it materializes ([8d3970d](https://github.com/jamesyong-42/chopsticks/commit/8d3970d575c6361d3aeb1d92b1c6f1886207acb2))
* **node:** CJS interop for @xterm/headless under real ESM ([f8f5c94](https://github.com/jamesyong-42/chopsticks/commit/f8f5c94886fcd6e8a3cbf04060199db2f0a4856b))
* preserve interactive auth during publish ([bfad194](https://github.com/jamesyong-42/chopsticks/commit/bfad194b13af15d8fa702301fa940e9059ff67be))
* skip immutable package versions during publish ([b5b83e7](https://github.com/jamesyong-42/chopsticks/commit/b5b83e78c4929eb1adddeff1fedce66c33dcb66d))
* **workbench:** Codex resume — reopen the thread, and gate the button (M5 C6-5) ([b6ad259](https://github.com/jamesyong-42/chopsticks/commit/b6ad2594604926f81aebad5cc271f93ad536ed97))
* **workbench:** Grok tab — TUI-first session creation, faster spawn ([a7dbf50](https://github.com/jamesyong-42/chopsticks/commit/a7dbf50ba8e0a7a06d6b7be12a4a9d9d6b900c47))
* **workbench:** Grok TUI needs --leader to share the session (inject) ([7002a75](https://github.com/jamesyong-42/chopsticks/commit/7002a758e0d181dcb12fbf538873c5ba0a71b41a))
* **workbench:** match avocado ghostty terminal parity ([9e75803](https://github.com/jamesyong-42/chopsticks/commit/9e7580309da8b08622e72916564f76be43e47cbf))
* **workbench:** render agent panel messages from a single source ([8d10432](https://github.com/jamesyong-42/chopsticks/commit/8d10432cd8bab876d0df6a13dda708e9e45440e4))
* **workbench:** use restty auto renderer like ghostty ([fb41cb1](https://github.com/jamesyong-42/chopsticks/commit/fb41cb133c6e035abf4b14b99a2059b3b2ddd19a))
