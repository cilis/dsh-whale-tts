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

## siliconflow

```
POST {baseURL}/audio/speech
Authorization: Bearer <key>
Content-Type: application/json

{
  "model": "FunAudioLLM/CosyVoice2-0.5B",
  "voice": "FunAudioLLM/CosyVoice2-0.5B:alex",
  "input": "<text>",
  "response_format": "mp3"
}
```

SiliconFlow exposes the OpenAI `/audio/speech` shape, so this adapter delegates
to the OpenAI-compatible implementation with its own defaults and voice
catalogue. `instructions` is deliberately not sent; SiliconFlow does not
document that field.

## minimax

```
POST {baseURL}/t2a_v2
Authorization: Bearer <key>
Content-Type: application/json

{
  "model": "speech-2.8-turbo",
  "text": "<text>",
  "stream": false,
  "voice_setting": { "voice_id": "<voice>", "speed": 1, "vol": 1, "pitch": 0 },
  "audio_setting": { "sample_rate": 32000, "bitrate": 128000, "format": "mp3", "channel": 1 },
  "output_format": "hex"
}
```

Response: `{ data: { audio: "<hex>" }, extra_info: ..., base_resp: { status_code, status_msg } }`.
`base_resp.status_code !== 0` is a provider failure; `data.audio` is hex, not
base64. Only the non-streaming path is implemented in this release.

## qwen

Hosted DashScope (`qwen3-tts-flash`):

```
POST {baseURL}/services/aigc/multimodal-generation/generation
Authorization: Bearer <DASHSCOPE_API_KEY>
Content-Type: application/json

{
  "model": "qwen3-tts-flash",
  "input": { "text": "<text>", "voice": "Cherry" }
}
```

Response contains `output.audio.url` (24-hour URL); the adapter downloads it and
returns raw WAV. It does not stream and does not support voice enrollment/clone.
For the open-weight local model, use `qwen-local` instead. Qwen cloud always
returns WAV; a requested MP3 is ignored for this provider.

## qwen-local

```
POST {baseURL}/audio/speech
Authorization: Bearer <key>   # optional
Content-Type: application/json

{
  "model": "Qwen/Qwen3-TTS-12Hz-0.6B",
  "voice": "Cherry",
  "input": "<text>",
  "response_format": "wav"
}
```

For a Qwen3-TTS sidecar (vLLM-Omni or a custom FastAPI wrapper). The response is
raw WAV/MP3 bytes. Unlike `openai-compatible`, the key is optional: a loopback
sidecar commonly runs without auth. Set `providers.qwen-local.apiKeyEnv` only
when the local gateway expects a token. The adapter does not start the sidecar;
see [qwen-local.md](qwen-local.md).

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

## Other TTS APIs

A separate survey of APIs not yet wired into this plugin (Qwen TTS, 豆包/Volcengine,
Azure Speech, ElevenLabs, Fish Audio) lives in
[`tts-apis/`](tts-apis/README.md). Each file has endpoint, auth, request/response
shape, limits and adapter notes, so a new provider can be implemented from it.
