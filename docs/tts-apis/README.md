# TTS API survey

A survey of speech-synthesis APIs that could become `dsh-whale-tts` providers,
compiled on **2026-11-03**, last re-checked **2026-11-09**. Each linked document is
self-contained: endpoint, authentication, request/response shape, limits, streaming
support and notes for wiring it into this plugin.

> Prices and quotas change; always confirm in the provider console. This folder
> documents APIs, including ones not wired in yet. The plugin now ships MiMo,
> SiliconFlow and MiniMax as selectable providers (OpenAI-compatible and SAPI
> adapters exist but stay off the primary-provider list).

## At a glance

| Provider | Endpoint family | Auth | Output | Streaming | Voice clone / design | Fit for this plugin |
| --- | --- | --- | --- | --- | --- | --- |
| [Qwen TTS](qwen-tts.md) | `dashscope.aliyuncs.com/api/v1/.../multimodal-generation/generation` | `Authorization: Bearer` | audio URL (24 h) or SSE base64 chunks | SSE (`X-DashScope-SSE`) + WebSocket realtime | Voice enrollment model + realtime VC model | Medium: JSON API, URL download, 600 chars per request |
| [Doubao TTS](doubao-tts.md) | V3 `openspeech.bytedance.com/api/v3/tts/unidirectional` (recommended) / V1 `api/v1/tts` (not recommended) | `X-Api-Key` + `X-Api-Resource-Id` (V3) or `Bearer;token` (V1) | V3 chunked/SSE base64; V1 base64 JSON | V3 chunked/SSE/WebSocket | ICL 1.0/2.0 with ICL resource IDs; V1 cannot use 2.0 voices | Medium: custom auth/resource IDs and base64 decode; strong Chinese voices |
| [MiniMax TTS](minimax-tts.md) | `api.minimax.io/v1/t2a_v2` | `Authorization: Bearer` | hex audio in JSON / SSE chunks | SSE | Voice clone API | High: implemented as non-streaming `minimax` adapter |
| [OpenAI TTS](openai-tts.md) | `api.openai.com/v1/audio/speech` | `Authorization: Bearer` | binary audio / SSE events | SSE (`stream_format=sse`) | No cloning; voice presets + `instructions` | Already supported through `openai-compatible` |
| [Azure Speech](azure-speech.md) | `{region}.tts.speech.microsoft.com/cognitiveservices/v1` | subscription key or 10-min bearer token | binary audio | SDK streaming; REST is one-shot | Custom Neural Voice (separate) | Medium: SSML body, not JSON |
| [ElevenLabs](elevenlabs-tts.md) | `api.elevenlabs.io/v1/text-to-speech/{voice_id}` | `xi-api-key` | binary audio | `/stream` endpoint | Instant/professional voice cloning | Medium: simple REST, but English-first and paid |
| [SiliconFlow](siliconflow-tts.md) | `api.siliconflow.cn/v1/audio/speech` | `Authorization: Bearer` | binary audio | OpenAI-style SSE | Depends on the hosted model | Wired as `siliconflow` provider |
| [Fish Audio](fish-audio.md) | `api.fish.audio/v1/tts` | `Authorization: Bearer` | binary audio | No (chunked response) | Voice-model cloning (`reference_id`) | Low: simple REST |

## Recommendation

1. **Cheapest integration:** SiliconFlow and OpenAI already speak the
   OpenAI-compatible `/audio/speech` shape; a base URL + model + voice mapping
   is enough.
2. **Best Chinese quality per engineering cost:** Qwen TTS (one JSON call,
   returns a URL) and Doubao large-model V3 (chunked JSON, better voices,
   slightly more auth work).
3. **If voice cloning matters:** MiniMax, Doubao ICL and ElevenLabs all expose
   cloning APIs; Qwen exposes voice enrollment plus a realtime VC model.
4. **Enterprise / SSML:** Azure is the choice when you need styles, roles,
   custom neural voices or Microsoft compliance.

## Common adapter shape

All of them fit the existing `ProviderAdapter` contract (`src/types.ts`):
`synthesize()` should resolve credentials, POST, decode the provider's audio
container/base64/hex/URL, and return `{ data, format, voice }`. The settings card
only needs new provider metadata (`id`, label, voices, formats, key refs); no RPC
channel change is required.
