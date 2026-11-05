# Changelog

All notable changes to `dsh-whale-tts` are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.3] - 2026-11-05

### Changed

- DSH compatibility is now `>= 0.2.1-rc.5` (the current harness release) with no
  upper cap; earlier `>= 0.2.1-rc.4 < 0.3.0-0` range removed.
- Listed in the awesome-dsh-plugin directory under `voice`.

## [0.4.2] - 2026-11-03

### Changed

- The read-aloud action now uses DSH's own action-row icons —
  `IconPlayOutlineRegular`, `IconPauseOutlineRegular` and
  `IconWarningOutlineRegular` — resolved from
  `@deepseek-ai/dsh-client-ui-primitives` through the Module Loader require.
  Missing/older primitives fall back to the inline outline glyphs, so the slot
  never crashes.

## [0.4.1] - 2026-11-03

### Changed

- Read-aloud action icon now matches the DSH action-row icon style: a thin
  outline volume icon (plus outline pause / warning), 16px, no native button
  box or background.
- Inline code is no longer dropped from speech. File names, flags and dotted
  identifiers are normalized into words (`src/core/read-aloud.ts` →
  "src core read aloud ts", `ctx.sessions` → "ctx sessions"); fenced code
  blocks are still skipped, and URLs / 120+ character snippets are omitted.

## [0.4.0] - 2026-11-03

### Added

- **Read aloud** in DSH: every finalized assistant reply gets a speaker action
  in its message action row. Click to synthesize with the active voice and play;
  click again to pause/resume; starting another reply stops the previous one.
- The settings card gained a Read aloud section: auto-read new replies (off by
  default), skip code blocks, segment length, and playback speed.
- Host endpoints `read-aloud/config` and `read-aloud/prepare` resolve the
  assistant text from the live session log, sanitize Markdown, and split it into
  provider-sized segments. Auto mode only reads the closing reply of a turn.
- Long replies are synthesized and played segment by segment with one segment
  prefetched; browser autoplay rejection degrades to a click-to-play button.

## [0.3.5] - 2026-11-02

### Changed

- Voice clone: the reference-audio picker now uses the same drag-and-drop
  dropzone as backup import (click or drop a wav/mp3, ≤10 MB; same validation
  and upload path as before).

## [0.3.4] - 2026-11-02

### Changed

- Backup import: replaced the native `<input type="file">` ("Choose file / no
  file chosen") with a themed dropzone that shows the action and accepts a
  `.json` file from the file picker or by drag-and-drop.

## [0.3.3] - 2026-11-02

### Changed

- **Settings card visual refresh** (no behaviour or RPC changes):
  - styled with DSH theme tokens (`--dsw-alias-*`, `--dsw-radius-*`,
    `--dsw-focus-ring-color`) so it follows light/dark themes; no more hardcoded
    grey fallbacks;
  - hero summary with provider / credential / active-voice chips;
  - three tabs — Voices, Interface, Backup — instead of one long form;
  - section cards with titles and one-line descriptions, unified 32px controls,
    hover/focus/disabled states, skeleton loading and empty states;
  - responsive single column on narrow widths; tabs support arrow keys.

## [0.3.2] - 2026-11-01

### Changed

- **Only `mimo` may be chosen as the primary provider for now** (it is the only
  adapter validated end-to-end for preset, voice design and voice clone):
  - the settings card lists MiMo only and shows how many providers are not
    available yet; a stale non-selectable value is shown as `not available yet`;
  - `openai-compatible` is now disabled by default and the bundled default row
    uses `provider: mimo`;
  - selecting another built-in provider as the primary now fails fast with
    `provider "..." is not available yet; choose "mimo"` instead of trying an
    unfinished integration. Offline `sapi` remains available as a fallback, and
    unknown/custom adapter ids (tests, third-party adapters) stay selectable.

## [0.3.1] - 2026-11-01

### Fixed

- `tts_list_voices` failed with
  `"value.profiles[0].styleInstruction" is not a declared property`: the
  tool's output schema did not declare `styleInstruction` even though profiles
  have carried it since 0.1.7. The schema now includes it.


## [0.3.0] - 2026-11-01

### Added

- **Backup / restore** (settings card → 备份与恢复):
  - export writes one self-contained `.json` document (voice profiles, samples,
    design candidates, active pointer, a non-secret config snapshot and the
    owned-key refs) to `<state>/backups/whale-tts-backup-*.json`; credential
    values are never included;
  - import from a `.json` upload (base64 over RPC) or a host-side path, in
    `merge` (append) or `replace` (clear first) mode;
  - the current state is exported to a safety backup before every import, so a
    failed or regretted import can be restored;
  - the latest 10 backup documents are kept; `backup/export`, `backup/list` and
    `backup/import` are the new RPC endpoints.
  - imported profiles always get fresh ids/sample files, so backups move safely
    between machines.

### Changed

- **Renamed the remaining `feiyu` identifiers**: loader entry id and settings
  namespace `whale-tts`, state directory `$DSH_HOME/whale-tts`, locale namespace
  `settings.whaleTts`, config defaults (`${DSH_HOME}/whale-tts`), repository
  directory `qq-bridge/plugins/dsh-whale-tts`, installer script
  `tools/install-whale-tts.ps1` and all docs. Existing `$DSH_HOME/feiyu-tts`
  data is copied to the new directory by the installer (nothing is deleted).

## [0.2.0] - 2026-11-01

### Changed

- **Renamed the plugin to `dsh-whale-tts`** (package, bundle/display name, client
  module id, settings-card slot key, and the RPC channel
  `/dsh-whale-tts`). Kept for data compatibility:
  - loader entry id and settings namespace `whale-tts` (existing `cordis.patch.yml`
    rows and stored settings keep working),
  - state directory `$DSH_HOME/whale-tts` (voice profiles, design candidates,
    owned-key record),
  - tool names (`tts_synthesize`, `tts_list_voices`, `tts_status`) and the
    `settings.whaleTts` locale namespace.
  Migration: the profile dependency and the patch-row `name:` must use the new
  package name; `tools/install-whale-tts.ps1` removes the legacy
  `dsh-whale-tts` dependency automatically before installing.
- `design/adopt` now falls back to the configured `designDescription` when the
  client does not send one, so a frozen clone profile always keeps the design
  prompt as its style instruction.

## [0.1.9] - 2026-11-01

### Fixed

- **Clear-key became clickable again after switching back to a shared DSH
  credential**: ownership was inferred from the `keySource` mode, so after saving
  and clearing a temporary key the card stayed in `manual` mode and offered to
  clear `XIAOMI_TOKEN_PLAN_CN_API_KEY` again. Ownership is now recorded per
  credential ref (`$DSH_HOME/whale-tts/keys-owned.json`):
  - only refs this plugin wrote through the card may be cleared; the host refuses
    everything else with `tts/bad-request` (and never calls `credentials.unset`);
  - `credentials/candidates` reports `owned`, and the card enables the clear
    button only for owned refs, showing why it is disabled otherwise;
  - saving a key marks it owned; clearing removes the mark.
- Keys saved before 0.1.9 are not in the record yet; saving them once through the
  card makes them clearable again.
- Tests: service ownership lifecycle (set → candidates.owned → clear → file),
  remote refusal for unowned refs, plus the manual-clear path.

## [0.1.8] - 2026-11-01

### Changed

- **Clearing a reused DSH credential is now refused.** The card's "clear key"
  called `ctx.credentials.unset(ref)`, so in reuse mode it would delete the
  shared DSH credential (`XIAOMI_TOKEN_PLAN_CN_API_KEY`) for every component that
  reads it. Now:
  - reuse mode: the button is disabled with an explanation; the host endpoint
    also rejects the request (`tts/bad-request`) even if called directly;
  - manual mode: clearing still works, behind an inline two-step confirmation.
- **Unified control styling in the card**: every input/select/button shares one
  height (28px), padding, radius and font; rows use one 88px label column; badges
  are one pill style; radio/checkbox groups no longer inherit row margins; the
  interface section is split into one field per row (provider, key source,
  credential ref, key entry, key type, base URL, test) instead of cramped
  mixed rows.
- Tests: `credentials/clear` refuses reuse mode and performs manual clears.

## [0.1.7] - 2026-11-01

### Added

- **Per-profile style instruction** (`styleInstruction`): the design prompt
  defines delivery (tone, emotion, pace), not just timbre, so freezing a design
  candidate into a clone profile used to lose it. Now:
  - adopting a design candidate stores the design description as the profile's
    style instruction automatically;
  - synthesising or previewing with that profile active sends the instruction as
    the provider's `user` message (`mimo` style prompt), so the designed feeling
    survives text changes;
  - the profile library has a `风格指令` / `Style instruction` inline editor to
    set, change or clear it for any preset/clone profile;
  - `tts_synthesize(style=…)` still overrides it per call;
  - duplicates carry the instruction over; cache keys include it, so changing
    the style invalidates cached audio naturally.
- Tests: profile store (adopt/save/duplicate/resolveVoice) and service
  (request style = profile instruction, per-call override wins).

## [0.1.6] - 2026-11-01

### Fixed

- **Rename / Duplicate / Delete buttons did nothing in the DSH desktop app**:
  the card used `window.prompt()` and `window.confirm()`, which Electron does
  not implement (prompt returns `null`, confirm returns `false`), so every
  handler returned before calling the host. The card now uses inline editors:
  - Rename opens an inline input (Enter saves, Escape cancels);
  - Duplicate asks the host for the built-in copy name (`<name> 副本`);
  - Delete opens a two-step inline confirmation.
- `scripts/client-bundle-smoke.mjs` (new `npm run smoke:client`) loads the built
  bundle through the web module loader, asserts the slot/RPC contract, and fails
  if `window.prompt` / `window.confirm` ever come back.

## [0.1.5] - 2026-11-01

### Fixed

- **Voice design ignored the description**: the `mimo` adapter applied the
  preset-voice fallback (`providers.mimo.voice`, default `苏打`) to *design*
  requests too, sending `audio.voice` with the `mimo-v2.5-tts-voicedesign`
  model. Per the MiMo TTS docs that model takes no voice at all and reads the
  design prompt from the `user` message, so the preset voice shadowed it. Voice
  selection is now model-aware:
  - preset → request voice, else configured voice, else adapter default;
  - design → **no `audio.voice` at all** (the configured voice is dropped);
  - clone → the sample `data:` URL only, never a preset fallback.
- **Design and clone synthesis silently fell back to another provider**: a
  failing design request could fall back to the offline SAPI provider, producing
  a candidate that ignored the description (and a cloned voice could be replaced
  by a preset one). Design candidates and clone-voiced synthesis now run the
  primary provider only; failures surface as `tts/provider` instead of a wrong
  voice.
- Design requests now set `audio.optimize_text_preview: true` (official example
  behaviour) so the demo sentence is polished to match the designed voice. New
  per-provider knob `providers.<id>.designOptimizeText` (default `true`).
- Tests: adapter request shapes for design/clone, and a service test proving
  design candidates never use a fallback provider (110 tests).

## [0.1.4] - 2026-11-01

### Fixed

- **`provider "mimo" has no designModel configured`**: the Config schema gives
  every provider field a `''` default, so a `cordis.patch.yml` row that only sets
  `enabled` / `apiKeyEnv` reaches the service as "present but empty". The
  `providerConfigFor()` merge then let those empty strings shadow the adapter's
  non-empty built-in defaults (`designModel`, `cloneModel`, `model`, `baseURL`,
  `voice`), silently breaking voice design and cloning. Empty configured strings
  no longer override non-empty built-in defaults; an explicit non-empty value
  still wins, and empty-vs-empty keys (for example `sapi.model`) stay empty.
- Regression test: schema-shaped empty provider blocks resolve to the adapter's
  design/clone models, explicit values still win.

## [0.1.3] - 2026-11-01

### Fixed

- **Card refresh always failed with `design description is empty`**: the browser
  half used `design/candidates` both to list already-saved candidates and to
  generate new ones. Listing sent no payload, so the host fell back to the
  (empty) configured description and raised a validation error, which aborted
  the whole `Promise.all` refresh. Added a dedicated `design/list` endpoint
  (returns on-disk candidates, never calls the network) and switched the card's
  refresh to it; `design/candidates` remains generation-only and still requires
  a non-empty description.
- Regression tests: `design/list` returns rows without touching the service's
  generation path, and `design/candidates` with a blank description maps to
  `tts/bad-request`.

## [0.1.2] - 2026-11-01

### Fixed

- **Settings card got `transport failure …: HTTP 405`**: the RPC channel route was
  never registered. The host registers the route through
  `connection.rpc.handle()`, whose `owner` is a cordis *shadow* of the consumer
  context; it calls `owner.webServer.register(route)`, so a child context that
  only injected `connection` threw `cannot get property "webServer" without
  inject` and the failed child fiber was invisible (the parent plugin stayed
  active). The registration child now injects `['connection', 'webServer']` and
  seeds `webServer` as a direct property, mirroring the in-tree registration
  helper.
- The service is disposed from a plugin-level `ctx.effect`, so it is cleaned up
  even in profiles where the RPC child never activates.
- `scripts/host-apply-smoke.mjs` now reproduces the runtime's `webServer` lookup
  and fails if the inject set regresses.

## [0.1.1] - 2026-11-01

### Fixed

- **Settings card could not reach the host** (`cannot get property "rpc" without
  inject`): the browser half passed the Cordis context proxy to the RPC client,
  and reading `ctx.rpc` on that proxy is rejected because `rpc` is not a declared
  service. The card now hands the client the **connection service instance**
  (`ctx.connection`), so `connection.rpc.call('/dsh-whale-tts', …)` works.
- The host's settings bridge is now late-bound and always present: a settings
  service that mounts after the plugin is picked up on first use instead of
  leaving the card permanently read-only.

## [0.1.0] - 2026-10-31

Initial release.

### Added

- Host plugin (`whale-tts`) with a Schemastery `Config` whose editable fields are
  marked volatile, so the settings card can write them.
- Model-facing tools: `tts_synthesize`, `tts_list_voices`, `tts_status`.
- Provider adapters: `openai-compatible` (generic `/audio/speech`), `mimo`
  (Xiaomi MiMo V2.5 chat-completions audio), `sapi` (offline Windows SAPI via a
  bundled PowerShell script), and a `minimax` adapter stub that reports
  "not implemented" while keeping its configuration slot.
- Provider registry, capability table, retry policy and fallback chain
  (timeout / network / 429 / 5xx retried once, then fallback; validation errors
  never retried).
- Voice profile store in `$DSH_HOME/whale-tts` (`voices.json`, `voices/`,
  `design/`, `cache/`) with atomic writes, a single active-profile pointer,
  clone-sample files, design candidates, and cleanup.
- Credential resolution through `ctx.credentials` with `process.env` fallback,
  key-type detection (`sk-` pay-as-you-go vs `tp-` / `ttp-` Token Plan) and the
  matching default BaseURL.
- Host ↔ client transport over the DSH connection RPC channel
  (`ctx.connection.rpc.handle('/dsh-whale-tts', …)` on the host,
  `ctx.connection.rpc.call(…)` in the browser), with a stable `tts/…` failure
  code table (`bad-request`, `not-found`, `conflict`, `key-missing`, `provider`,
  `unsupported`, `not-implemented`, `aborted`, `internal`) and input redaction.
- Remote endpoints for the settings card: `status`, `config/get`,
  `config/mutate`, profile CRUD (`profiles/list|save|delete|activate|duplicate`),
  `samples/upload`, design (`design/candidates|adopt|discard`), `preview`,
  `audio/read`, `credentials/candidates|set|clear|test`, `providers/list`.
- Web settings card (client half) with model switching, per-model parameter
  areas, voice profile library, output/interface sections, key source handling
  and connection test.
- Chinese and English UI: `locale/zh.json` and `locale/en.json` for the plugin
  metadata, plus bundled zh/en dictionaries for the card; the card follows the
  DSH language by default.
- Unit tests (`node --test`) for adapters with an injectable `fetch`, the
  fallback chain, cache keys, path templates, voice profiles, credential typing,
  the RPC code table and the synthesis pipeline.
- Installer script `tools/install-whale-tts.ps1` (backup, `npm pack`, add to the
  `qqbot` and `desktop` profiles, merge config rows, print restart instructions,
  rollback).

### Implementation deviations from the design documents

- The settings card registers on the DSH **Plugins** page (`plugins.bundle.config`,
  key = package name). The `settings.plugin.item` slot named in the design does
  not exist in DSH 0.2.1-rc.5.
- The card talks over the DSH **connection RPC channel** instead of
  `TypertRemoteService` + `@Remote`: a third-party package cannot generate the
  strict client codec `ctx.remote` requires. The failure code table is kept.
- `Config` volatile fields use `.extra('volatile', true)` when the resolved
  schemastery build lacks the `.volatile()` sugar.
- The browser bundle is built with **Rollup + Sucrase** (pure JS); native esbuild
  spawns a child process that restricted sandboxes refuse. The host half is
  compiled file-per-file with `tsc` (with `.d.ts`) instead of being bundled.
- The bundled SAPI script lives at `scripts/sapi.ps1` (not `src/scripts/`) so the
  package ships it next to `lib/`.
- Credentials follow the DSH 0.2.1 order (stored credential file first, then the
  launch environment) instead of the older "env first" description.
- The README requires `@deepseek-ai/dsh-base` in the profile; the design's
  `dsh-tool-executor-native` package does not exist in 0.2.1.

### Known limitations

- `minimax` is a stub: its configuration exists but synthesis throws
  `not implemented`.
- Singing is out of scope for this release. The provider capability table keeps
  a `singing` field for a future release, but no tool exposes a `mode` argument.
- Voice design follows "create a voice once, then freeze it as a clone profile":
  the model `mimo-v2.5-tts-voicedesign` is not used for per-sentence synthesis.
- Secrets are stored by the DSH credential service in
  `$DSH_HOME/.credentials.yaml` with file permissions (0700/0600); that is
  filesystem permission, not encryption.
