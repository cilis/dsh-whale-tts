# dsh-whale-tts

> 这声音是育木的小鲸鱼的。

中文简介（默认）：[README.md](README.md) · 详细中文文档：[README.zh.md](README.zh.md)

Provider-agnostic text-to-speech tools for [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) agents.

The plugin does **one** thing: turn text into a local audio file and return its
path. It never plays, sends, uploads or streams audio — what happens to the file
is up to the consumer (a chat bridge, a video pipeline, a player, …).

- Three model-facing tools: `tts_synthesize`, `tts_list_voices`, `tts_status`.
- Four providers: `openai-compatible`, `mimo` (Xiaomi MiMo V2.5 TTS), `sapi`
  (offline Windows SAPI), and a `minimax` stub.
- Voice profiles: preset / cloned / designed voices, up to 50 profiles.
- Backup / restore from the settings card: one self-contained `.json` export of
  profiles, samples and design candidates (no credential values), merged or
  replaced on import with an automatic safety backup.
- A settings card in the DSH Plugins page (Chinese and English).
- API keys live in the DSH credential store; the plugin only keeps the
  reference name and never returns a secret value.

## Requirements

| Requirement | Notes |
|---|---|
| DeepSeek Harness `>= 0.2.1-rc.4 < 0.3.0-0` | `engines.dsh` is enforced at install time |
| Node.js `>= 24.9` | DSH runtime requirement |
| A profile that mounts `@deepseek-ai/dsh-base` | provides `ctx.tools`; all bundled profiles include it |
| A Web profile for the settings card | the host half works headless without it |

> Earlier design documents mentioned a `dsh-tool-executor-native` package. It
> does not exist in DSH 0.2.1: `@deepseek-ai/dsh-base` mounts `@deepseek-ai/dsh-tools`
> and `@deepseek-ai/dsh-agent-loop`, which is all the plugin needs.

## Install

### From a tarball (recommended for local/offline use)

```sh
npm pack                                     # or: pnpm pack
dsh plugin --profile <profile> add file:/abs/path/dsh-whale-tts-0.3.2.tgz
dsh --profile <profile> --dump-config | grep dsh-whale-tts   # layer must appear
```

`dsh plugin add` installs the dependency and appends the package to
`dsh.profile.bundles` automatically, because the package declares
`dsh.bundle.patch`. Then restart DSH.

### From npm

```sh
dsh plugin --profile <profile> add dsh-whale-tts
```

### From a local directory (development)

```sh
dsh plugin --profile <profile> add "link:/abs/path/dsh-whale-tts"   # this repository
```

### One-shot installer for CLI-managed profiles

The one-shot installer lives in the QQBot host tree (not in this package repository);
it backs up the profile,
builds, packs, installs, merges the config row and verifies `--dump-config`:

```powershell
powershell -ExecutionPolicy Bypass -File tools\install-whale-tts.ps1            # qqbot (default)
powershell -ExecutionPolicy Bypass -File tools\install-whale-tts.ps1 -Profiles desktop
powershell -ExecutionPolicy Bypass -File tools\install-whale-tts.ps1 -Rollback
```

**The `desktop` profile cannot be installed from the CLI.** DSH reserves it for
the Electron application (`error: profile "desktop" is managed exclusively by
the Electron application`), so with `-Profiles desktop` the script only backs it
up and merges its config row. Install the package itself from the app:

1. Sidebar **Plugins → Add plugin → local directory**:
   `<path to this repository>`
   (or a `file:` tarball spec), then restart the app if asked;
2. Or have an in-app agent install the tarball through the plugin manager.

The installer's `-Rollback` restores the backed-up `package.json` /
`cordis.patch.yml`; for `desktop` you still uninstall from the Plugins page.

## Configuration

Configuration is a Cordis patch row in the profile's `cordis.patch.yml`. The
bundle ships a default row (`id: whale-tts`, `name: dsh-whale-tts`); a profile
patch overrides it by id:

```yaml
- id: whale-tts
  name: dsh-whale-tts
  config:
    provider: mimo
    fallback: [sapi]
    providers:
      mimo:
        enabled: true
        apiKeyEnv: MIMO_API_KEY
        model: mimo-v2.5-tts
        designModel: mimo-v2.5-tts-voicedesign
        cloneModel: mimo-v2.5-tts-voiceclone
        voice: 苏打
        format: wav
        timeoutMs: 20000
      sapi:
        enabled: true
    output:
      dir: 'D:\tts-audio'
    cache:
      enabled: true
      dir: 'D:\tts-audio\.cache'
    limits:
      maxChars: 120
```

> **Patch rows replace the whole `config` value — there is no deep merge.** When
> you override the row, restate every key you rely on. In particular the
> `providers` dict replaces the bundled defaults; omitted provider blocks fall
> back to the adapter defaults, omitted keys inside a block fall back to the
> adapter defaults too.

### All configuration keys

| Key | Default | Meaning |
|---|---|---|
| `provider` | `mimo` | provider id used by default (only `mimo` is selectable) |
| `fallback` | `[sapi]` | providers tried in order after the primary fails |
| `providers.<id>.enabled` | per provider | master switch |
| `providers.<id>.baseURL` | per provider | API root |
| `providers.<id>.apiKeyEnv` | per provider | credential reference name |
| `providers.<id>.model` | per provider | speech model id |
| `providers.<id>.designModel` | mimo only | voice-design model id |
| `providers.<id>.cloneModel` | mimo only | voice-clone model id |
| `providers.<id>.voice` | per provider | default voice id |
| `providers.<id>.format` | per provider | default output format |
| `providers.<id>.timeoutMs` | `30000` | per-request timeout |
| `providers.<id>.retry` | `1` | retries for retryable failures |
| `providers.<id>.style` | `''` | default style instruction |
| `providers.<id>.headers` | `{}` | extra HTTP headers |
| `providers.<id>.voiceName` | `''` | SAPI voice name |
| `providers.<id>.scriptPath` | `''` | SAPI script override (templates allowed) |
| `providers.<id>.rate` | `0` | SAPI speaking rate (-10..10) |
| `output.dir` | `${DSH_HOME}/whale-tts` | output directory template |
| `output.filename` | `tts-{timestamp}-{rand}` | file name template (no extension) |
| `output.format` | `auto` | `auto` follows the provider default |
| `output.overwrite` | `false` | allow replacing an existing file |
| `cache.enabled` | `true` | content-addressed cache |
| `cache.dir` | `${DSH_HOME}/whale-tts/.cache` | cache directory template |
| `cache.maxAgeDays` | `30` | lazy cache cleanup age |
| `limits.maxChars` | `2000` | hard cap per request |
| `log.text` | `false` | log synthesised text (off for privacy) |
| `activeProfileId` | `''` | voice-profile pointer (the store is authoritative) |
| `studioMode` | `preset` | settings-card parameter area |
| `presetVoiceId` | `苏打` | preset voice used with no active profile |
| `customVoiceId` | `''` | free-form voice id |
| `designDescription` | `''` | voice-design description |
| `designCandidateCount` | `3` | candidates per generation (2–5 in the card) |
| `sampleText` | `你好，我是魈。` | sentence spoken by design candidates |
| `previewText` | `你好，我是魈。` | sentence used by Preview / Test connection |
| `apiKeyEnv` | `''` | credential ref override for the active provider |
| `keySource` | `reuse` | card hint: reuse a DSH credential or manual input |
| `baseURLOverride` | `''` | overrides the computed BaseURL |
| `keyType` | `auto` | key family override (`sk-` / `tp-` / `ttp-`) |

Path templates support `${DSH_HOME}`, `${HOME}`, `${USERPROFILE}`, `${TMP}`,
`${TEMP}`; the expanded path must be absolute.

Every one of these fields is a **volatile** config field, so the settings card
can change it without remounting the plugin.

## Providers

> **Only `mimo` is selectable for now.** The card offers just MiMo as the
> primary provider; `openai-compatible` / `minimax` are disabled defaults and
> offline `sapi` stays available as a fallback. The other adapters are kept for
> future work and are rejected (`provider "..." is not available yet`) when
> chosen as the primary provider.

| id | Protocol | Key | Formats | Voice design / clone |
|---|---|---|---|---|
| `openai-compatible` | `POST {baseURL}/audio/speech` (Bearer, raw bytes) | required | mp3, wav | no |
| `mimo` | `POST {baseURL}/chat/completions` (`api-key` header, base64 audio) | required | wav, mp3 | yes / yes |
| `sapi` | local PowerShell `System.Speech`, offline | not needed | wav | no |
| `minimax` | stub: throws `not implemented` | required | mp3 | no |

`openai-compatible` covers OpenAI and any compatible gateway (SiliconFlow,
self-hosted proxies, …); see `docs/providers.md` for request/response details
and `docs/self-hosting.md` for gateway recipes.

### Fallback behaviour

```
primary provider
  ├─ validation error        → fail immediately (no retry, no fallback)
  ├─ retryable error         → retry (per-provider `retry`), then fallback
  │    (timeout / network / 429 / 5xx)
  ├─ auth / quota / filter   → fallback directly
  └─ success                 → done
fallback providers are tried in order; disabled/platform-incompatible/unknown
providers are skipped; when everything fails one aggregate error names each
provider's reason.
```

## Voice profiles

Three kinds, one active profile at a time:

| Kind | Stores | Can synthesise | Used as |
|---|---|---|---|
| `preset` | `presetVoiceId` | yes | provider speech model + preset voice |
| `clone` | reference audio in `voices/` | yes | provider clone model + `data:` URL sample |
| `design` | description + candidate history | no (workshop record) | generates candidates which are frozen into a clone profile |

Storage (under the DSH home):

```
$DSH_HOME/whale-tts/
├── voices.json          # { version: 1, activeProfileId, profiles[] }
├── voices/<file>        # clone samples (wav/mp3)
├── design/<file>        # design candidates (temporary)
├── preview/<file>       # settings-card previews (self-cleaning)
└── .cache/              # synthesis cache (when cache.dir is not set explicitly)
```

Limits: at most 50 profiles, at most 10 MB per reference sample. Deleting a
profile deletes its sample file and falls back to the provider default voice.

Voice design follows design option A: describe a voice → generate 2–5
candidates → listen → adopt one, which freezes it into a clone profile. The
plugin never re-designs a voice per sentence (that would make the voice drift).

## Credentials

The plugin stores a credential **reference name**, never the secret:

```yaml
providers:
  mimo:
    apiKeyEnv: MIMO_API_KEY        # or XIAOMI_TOKEN_PLAN_CN_API_KEY to reuse DSH's own key
```

Resolution order (through `ctx.credentials`, then `process.env`):

1. the DSH credential store (`$DSH_HOME/.credentials.yaml`)
2. the process environment
3. `<cwd>/.env`
4. `$DSH_HOME/.env`

The settings card writes a key through `ctx.credentials.set()` and afterwards
only shows *configured / not configured* — never a value, never a suffix, never
in logs, error messages, tool results or the browser bundle.

**Key typing** (Xiaomi MiMo, host-side only; only the type string leaves the host):

| Prefix | Family | Default BaseURL |
|---|---|---|
| `sk-` | pay-as-you-go | `https://api.xiaomimimo.com/v1` |
| `tp-` | Token Plan | `https://token-plan-cn.xiaomimimo.com/v1` |
| `ttp-` | Token Plan (team) | `https://token-plan-cn.xiaomimimo.com/v1` |
| other | custom | provider `baseURL` |

**Security boundary, stated honestly:** DSH stores credentials in
`$DSH_HOME/.credentials.yaml` with directory mode 0700 / file mode 0600. That is
filesystem permission, **not encryption**. It keeps other OS users out; it does
not stop tool calls running as the same user. For a stricter setup, inject the
key from the environment at launch and leave the credential store empty.

## Tools

### `tts_synthesize`

| Parameter | Type | Required | Meaning |
|---|---|---|---|
| `text` | string | yes | text to synthesise (capped by `limits.maxChars`) |
| `provider` | string | no | override the default provider |
| `voice` | string | no | override the voice (presets only) |
| `format` | `wav` / `mp3` | no | override the output format |
| `style` | string | no | natural-language style instruction |
| `filename` | string | no | file-name template without extension |

Canonical result:

```json
{
  "ok": true,
  "path": "E:\\…\\audio\\tts-20261031-221500-a1b2c3.wav",
  "relativePath": "tts-20261031-221500-a1b2c3.wav",
  "file": "tts-20261031-221500-a1b2c3.wav",
  "format": "wav",
  "provider": "mimo",
  "voice": "苏打",
  "cached": false,
  "bytes": 482133,
  "elapsedMs": 1830
}
```

Three path fields for three consumer shapes: `path` (absolute), `relativePath`
(relative to `output.dir`, POSIX separators — use this when the consumer only
accepts files inside a library directory) and `file` (name only). A cache hit
returns `cached: true`; if `cache.dir` is a subdirectory of `output.dir` the
relative path may contain that subdirectory, otherwise turn the cache off.

### `tts_list_voices`

Returns `{ providers: [{ id, capabilities, voices }], profiles, activeProfileId }`
without a network call and without reading any key.

### `tts_status`

Returns `{ provider, fallback, providers: {…}, activeProfileId, activeVoice,
cache, outputDir, platform }`. Per provider it reports `configured`, `enabled`,
`keyRequired`, `keyConfigured`, `keyType`, `available`, `model`, `voice`,
`baseURL`, `lastError`. It never contains a secret or synthesised text — use it
first when troubleshooting.

## Settings card

The browser half registers a card on the DSH **Plugins** page under the
`dsh-whale-tts` package (`plugins.bundle.config`, key = package name). It
contains four sections:

1. **Current voice** — active profile / provider default, preview sentence, preview.
2. **Synthesis model** — preset / design / clone selector with a parameter area
   that swaps with the choice:
   - preset: 9 MiMo voices plus a custom voice id, sample sentence, save-as-profile;
   - design: description, candidate count, sample sentence, generate + candidate
     list with play / adopt, discard;
   - clone: file upload (mp3/wav ≤ 10 MB) or an existing sample file name,
     save-as-profile.
3. **Voice library** — play / activate / rename / duplicate / delete.
4. **Output & interface** — output directory, format, cache, max chars,
   provider, credential source (reuse / manual), key entry, key type, BaseURL
   override, test connection.

The card's language follows the DSH UI language (Chinese and English
dictionaries are bundled).

## Development

```sh
cd dsh-whale-tts

npm ci --ignore-scripts            # sandboxed environment: scripts need spawn
npm run build                     # tsc (host) + rollup (client)
npm run typecheck                 # host + client
node --test --test-isolation=none test/   # unit tests
node scripts/smoke.mjs            # offline pipeline smoke (no network)
npm pack --dry-run --ignore-scripts
```

The host half is compiled file-per-file with `tsc` into `lib/`; the browser half
is bundled by Rollup + Sucrase into the lazy-CJS factory DSH loads from
`/plugins`. Both are pure-JavaScript toolchains — native esbuild is deliberately
avoided because it spawns a binary.

## Known limitations

- **Singing is not implemented.** The capability table keeps a `singing` field,
  but no tool exposes a `mode` argument and no `sing` tool is registered.
- **`minimax` is a stub**: configuration exists, synthesis throws
  `not implemented`.
- **No per-sentence voice design.** Design is a one-time workshop that freezes
  into a clone profile.
- **The card lives on the Plugins page**, not in Settings; DSH 0.2.1 exposes
  plugin configuration pages there. The registration slot
  (`settings.plugin.item`) named in the original design does not exist in
  0.2.1-rc.5.
- **The card needs the Web profile.** Headless profiles still get the tools and
  read the YAML config.
- **Preview/audio transfer goes through the connection RPC** as base64; very
  large reference samples make the preview payload large (bounded by the 10 MB
  sample limit).

## Implementation deviations from the design documents

| Design | Implementation | Why |
|---|---|---|
| Client card at `settings.plugin.item` | `plugins.bundle.config` (key = package name) | the slot does not exist in DSH 0.2.1-rc.5; plugin configuration pages moved to the Plugins page (`dsh-client-ui-plugin-manager`) |
| `TypertRemoteService` + `@Remote` as the card's transport | DSH connection RPC channel (`ctx.connection.rpc.handle` / `rpc.call`) | a third-party package cannot generate the strict client codec `ctx.remote` requires; the RPC channel is the production-proven path (dsh-mnemon uses it on the same runtime) and is authenticated by the DSH connection service |
| `Config` fields marked `.volatile()` | `.extra('volatile', true)` via a helper that prefers `.volatile()` when present | the `^3.18.1` schemastery range may resolve to a build without the sugar |
| Client bundle built with esbuild | Rollup + Sucrase | esbuild's native binary is spawned as a child process, which restricted sandboxes refuse; output format is identical |
| Host sources bundled by esbuild | `tsc` file-per-file into `lib/` (with `.d.ts`) | no bundler needed for the host; types ship for consumers |
| `sapi` script at `src/scripts/sapi.ps1` | `scripts/sapi.ps1` | tsc does not copy assets; the package ships it next to `lib/` |
| Fallback defaults `['sapi']`, `maxChars: 2000` | unchanged defaults; deployment rows override them | keep the generic package safe by default |
| Credential priority "env > credentials file" | the DSH credentials service order (stored file > launch env > project `.env` > home `.env`); the plugin adds a `process.env` fallback only when the service is absent | 0.2.1 changed the priority (`stored` is writable and wins) |
| `dsh-tool-executor-native` in the profile | `@deepseek-ai/dsh-base` | that package does not exist in 0.2.1 |

## License

MIT. See [LICENSE](./LICENSE).
