# Providers

Every adapter implements the same interface (`src/types.ts`):

```ts
interface ProviderAdapter {
  id: string
  capabilities: {
    speech: boolean
    singing: boolean
    formats: Array<'wav' | 'mp3'>
    voices: Array<{ id: string; label?: string; description?: string }>
    requiresKey: boolean
    voiceDesign?: boolean
    voiceClone?: boolean
    platforms?: NodeJS.Platform[]
  }
  synthesize(request, config, runtime): Promise<{ data: Uint8Array; format; voice; meta? }>
}
```

`synthesize` receives an abortable `request.signal`, the merged provider config,
and a runtime object with an **injectable `fetch`**, the credential resolver,
the logger, the environment, the platform and the bundled script paths. The
adapters never call the global `fetch` directly and never fall back on their
own — retries and fallback live in `src/core/chain.ts`.

## Error classification

| Condition | `TtsError.kind` | Retried | Falls back |
|---|---|---|---|
| 400 / 404 / 422 (bad request from provider) | `provider` | no | yes |
| 401 / 403 | `auth` | no | yes |
| 402 | `quota` | no | yes |
| 429 | `rate-limit` | yes (1s, then 2s) | yes |
| 5xx | `server` | yes | yes |
| connection failure | `network` | yes | yes |
| timeout (AbortSignal.timeout) | `timeout` | yes | yes |
| provider content filter (`finish_reason: content_filter`) | `content-filter` | no | yes |
| caller aborted | `aborted` | no | no |
| input validation inside an adapter | `validation` | no | no |
| platform mismatch (SAPI on non-Windows) | `platform` | no | yes |
| stub provider | `not-implemented` | no | yes |

Messages never contain the API key or the synthesised text; provider echo is
redacted before it leaves the host.

## openai-compatible

```
POST {baseURL}/audio/speech
Authorization: Bearer <key>
Content-Type: application/json

{
  "model": "<model>",
  "voice": "<voice>",
  "input": "<text>",
  "response_format": "mp3" | "wav",
  "instructions": "<style>"        // only when a style is set
}
```

Response: raw audio bytes; the adapter validates the magic bytes and the
requested format. Works against OpenAI and compatible gateways; the format is
downgraded to `capabilities.formats[0]` when the configured format is
unsupported.

## mimo (Xiaomi MiMo V2.5 TTS)

```
POST {baseURL}/chat/completions
api-key: <key>
Content-Type: application/json

{
  "model": "mimo-v2.5-tts" | "mimo-v2.5-tts-voicedesign" | "mimo-v2.5-tts-voiceclone",
  "messages": [
    { "role": "user", "content": "<style description, may be empty>" },
    { "role": "assistant", "content": "<text>" }
  ],
  "audio": { "format": "wav" | "mp3", "voice": "<voice id or data: URL>",
             "optimize_text_preview": true },
  "stream": false
}
```

- The text **must** be the `assistant` message; the style description is the
  `user` message.
- Response: `choices[0].message.audio.data` is **base64**; the format is read
  from `audio.format` when present, else from the request.
- `finish_reason === 'content_filter'` (or an error payload that looks like a
  filter) maps to `content-filter`.
- Model ids per voice kind: `mimo-v2.5-tts` (preset),
  `mimo-v2.5-tts-voicedesign` (design), `mimo-v2.5-tts-voiceclone` (clone).
- Voice rules are per model, and the adapter enforces them:
  - preset: `audio.voice` = request voice, else `providers.<id>.voice`, else the
    adapter default (`苏打`);
  - design: **no `audio.voice` at all** — the voice comes from the `user`
    message. Sending a preset voice here makes the API ignore the design
    description, so a configured `voice` is deliberately dropped;
  - clone: `audio.voice` = the reference sample as `data:audio/wav;base64,…`
    (or `audio/mpeg`); it never falls back to a preset voice.
- Design requests also set `audio.optimize_text_preview` (default on): the demo
  sentence is polished to fit the designed voice. Disable per provider with
  `providers.<id>.designOptimizeText: false`.

Key families:

| Prefix | Billing | Default BaseURL |
|---|---|---|
| `sk-` | pay-as-you-go | `https://api.xiaomimimo.com/v1` |
| `tp-` | Token Plan (personal) | `https://token-plan-cn.xiaomimimo.com/v1` |
| `ttp-` | Token Plan (team) | `https://token-plan-cn.xiaomimimo.com/v1` |

The plugin resolves the key, reads the prefix on the host, and computes the
BaseURL from it unless `baseURLOverride` is set. Reusing
`XIAOMI_TOKEN_PLAN_CN_API_KEY` (the key DSH's own MiMo LLM provider uses) is
supported and recommended.

## sapi (offline, Windows only)

Windows ships `System.Speech`; the package bundles `scripts/sapi.ps1`.

- Non-Windows platforms: the adapter throws `platform` before touching the
  filesystem, and `tts_status` marks it unavailable.
- The adapter writes the text to a temporary UTF-8 file inside the plugin state
  directory, spawns
  `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/sapi.ps1 -TextFile … -OutFile … [-Voice …] [-Rate …]`,
  reads the produced WAV, validates the magic bytes and removes the temporary
  files in `finally`.
- The caller's `signal` kills the child process; the configured timeout kills it
  and reports `timeout`.
- Voice selection prefers `providers.sapi.voiceName` (a SAPI-specific switch)
  over `request.voice` (which usually carries a preset id from another
  provider).
- The script sets the output to 16 kHz / 16-bit / mono WAV; a missing voice name
  falls back to the system default and writes a warning to stderr.

## minimax (stub)

`capabilities.speech = true`, formats `['mp3']`, key required — but
`synthesize()` throws `TtsError('not-implemented')`. The configuration block and
the adapter registration exist so enabling it later is a self-contained change
(request shape is documented in the design documents).

## Writing another provider

Adapters are looked up from `src/providers/registry.ts`. An adapter that is not
in the built-in map can still be injected by tests through
`TtsService({ adapters })`. If you add a permanent provider:

1. create `src/providers/<id>.ts` exporting `<id>Adapter: ProviderAdapter`;
2. register it in `BUILTIN_ADAPTERS` and add its defaults to
   `BUILTIN_PROVIDER_DEFAULTS`;
3. add a `providers.<id>` block to `src/config.ts` defaults;
4. extend `providers.test.mjs` with a fake-fetch request/response test and the
   error-classification cases;
5. document it here and in the README provider table.
