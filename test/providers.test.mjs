/**
 * Provider adapter unit tests (M3).
 *
 * Everything runs against the compiled output in `lib/` and a fake `fetch`, so
 * these tests never touch the network, the credential store or the file system.
 *
 * Run after building:
 *   npm run build:host && node --test test/providers.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { openaiAdapter } from '../lib/providers/openai.js'
import { mimoAdapter } from '../lib/providers/mimo.js'
import { sapiAdapter, buildSapiInvocation } from '../lib/providers/sapi.js'
import { minimaxAdapter } from '../lib/providers/minimax.js'
import { siliconflowAdapter } from '../lib/providers/siliconflow.js'
import { qwenLocalAdapter } from '../lib/providers/qwen-local.js'
import { qwenAdapter } from '../lib/providers/qwen.js'
import { doubaoAdapter } from '../lib/providers/doubao.js'
import {
  BUILTIN_ADAPTERS,
  BUILTIN_PROVIDER_DEFAULTS,
  getAdapter,
  isProviderSelectable,
  providerConfigFor,
} from '../lib/providers/registry.js'
import { DEFAULT_PROVIDERS } from '../lib/config.js'
import { TtsError } from '../lib/types.js'

/** Fake credential. Assertions make sure it never reaches an error message. */
const TEST_KEY = 'sk-test-0123456789abcdefSECRET'

/** Fake synthesis text. Also must never be echoed in an error message. */
const TEST_TEXT = '这段话不应出现在错误消息里'

/** A quiet logger that records calls instead of printing. */
function makeLogger() {
  const entries = []
  const push = (level) => (message, ...args) => entries.push({ level, message, args })
  return {
    entries,
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    debug: push('debug'),
  }
}

/** Minimal runtime stub; every field can be overridden per test. */
function makeRuntime(overrides = {}) {
  const logger = overrides.logger ?? makeLogger()
  const runtime = {
    fetch: async () => {
      throw new Error('fetch must not be called by this test')
    },
    resolveKey: async () => TEST_KEY,
    logger,
    env: {},
    platform: 'win32',
    paths: {
      sapiScript: 'C:\\stub\\scripts\\sapi.ps1',
      stateDir: 'C:\\stub\\state',
    },
  }
  return { ...runtime, ...overrides, logger }
}

/** Fake fetch that records url/init and delegates to `handler`. */
function makeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler({ url: String(url), init, index: calls.length })
  }
  return { calls, fetchImpl }
}

/** WAV payload whose magic bytes satisfy validateAudio. */
function wavBytes() {
  const bytes = new Uint8Array(24)
  bytes.set([0x52, 0x49, 0x46, 0x46], 0) // "RIFF"
  bytes.set([0x57, 0x41, 0x56, 0x45], 8) // "WAVE"
  return bytes
}

/** MP3 payload (ID3 header) whose magic bytes satisfy validateAudio. */
function mp3Bytes() {
  const bytes = new Uint8Array(24)
  bytes.set([0x49, 0x44, 0x33], 0) // "ID3"
  return bytes
}

/** The same MP3 payload as the hex string MiniMax returns. */
function mp3Hex() {
  return Buffer.from(mp3Bytes()).toString('hex')
}

/** Build a JSON response for a fake fetch. */
function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Build a raw audio response for a fake fetch. */
function audioResponse(bytes, status = 200) {
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'application/octet-stream' },
  })
}

/** A signal that never aborts. */
function idleSignal() {
  return new AbortController().signal
}

/** Base OpenAI-compatible config used by most tests. */
function openaiConfig(overrides = {}) {
  return {
    baseURL: 'https://api.openai.test/v1/',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    format: 'wav',
    timeoutMs: 5_000,
    ...overrides,
  }
}

/** Base MiMo config used by most tests. */
function mimoConfig(overrides = {}) {
  return {
    baseURL: 'https://api.mimo.test/v1',
    apiKeyEnv: 'MIMO_API_KEY',
    voice: '苏打',
    format: 'wav',
    timeoutMs: 5_000,
    ...overrides,
  }
}

/** Assert a rejection is a TtsError with the expected classification. */
async function expectTtsError(promise, expected) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof TtsError, `expected TtsError, got ${error?.constructor?.name}`)
    if (expected.kind !== undefined) assert.equal(error.kind, expected.kind)
    if (expected.status !== undefined) assert.equal(error.status, expected.status)
    if (expected.provider !== undefined) assert.equal(error.provider, expected.provider)
    if (expected.retryable !== undefined) assert.equal(error.retryable, expected.retryable)
    if (expected.messageIncludes !== undefined) {
      assert.ok(
        error.message.includes(expected.messageIncludes),
        `expected message to include "${expected.messageIncludes}", got: ${error.message}`,
      )
    }
    if (expected.secrets !== undefined) {
      for (const secret of expected.secrets) {
        assert.ok(
          !error.message.includes(secret),
          `error message leaked a secret: ${error.message}`,
        )
      }
    }
    return true
  })
}

// ---------------------------------------------------------------------------
// Registry alignment
// ---------------------------------------------------------------------------

test('registry: built-in adapters and defaults line up with the eight ids', () => {
  const ids = [
    'openai-compatible',
    'mimo',
    'minimax',
    'siliconflow',
    'qwen',
    'doubao',
    'qwen-local',
    'sapi',
  ]
  assert.equal(BUILTIN_ADAPTERS.size, 8)
  for (const id of ids) {
    assert.ok(BUILTIN_ADAPTERS.has(id), `missing adapter ${id}`)
    assert.ok(BUILTIN_PROVIDER_DEFAULTS[id], `missing defaults for ${id}`)
    assert.equal(getAdapter(id)?.id, id)
  }
  assert.equal(getAdapter('openai-compatible'), openaiAdapter)
  assert.equal(getAdapter('mimo'), mimoAdapter)
  assert.equal(getAdapter('minimax'), minimaxAdapter)
  assert.equal(getAdapter('siliconflow'), siliconflowAdapter)
  assert.equal(getAdapter('qwen'), qwenAdapter)
  assert.equal(getAdapter('doubao'), doubaoAdapter)
  assert.equal(getAdapter('qwen-local'), qwenLocalAdapter)
  assert.equal(getAdapter('sapi'), sapiAdapter)

  // The merged provider config keeps adapter defaults for omitted keys.
  const merged = providerConfigFor('mimo', {})
  assert.equal(merged.model, 'mimo-v2.5-tts')
  assert.equal(merged.designModel, 'mimo-v2.5-tts-voicedesign')
  assert.equal(merged.cloneModel, 'mimo-v2.5-tts-voiceclone')
})

test('empty provider fields do not shadow non-empty built-in defaults', () => {
  // The Config schema fills provider fields with '' defaults, so a patch that
  // only sets enabled/apiKeyEnv arrives as "present but empty". Those values
  // must not disable the adapter's own model defaults.
  const configured = {
    mimo: { enabled: true, apiKeyEnv: 'XIAOMI_TOKEN_PLAN_CN_API_KEY', model: '', designModel: '', cloneModel: '', voice: '' },
  }
  const merged = providerConfigFor('mimo', configured)
  assert.equal(merged.designModel, 'mimo-v2.5-tts-voicedesign')
  assert.equal(merged.cloneModel, 'mimo-v2.5-tts-voiceclone')
  assert.equal(merged.model, 'mimo-v2.5-tts')
  assert.equal(merged.voice, '苏打')
  assert.equal(merged.apiKeyEnv, 'XIAOMI_TOKEN_PLAN_CN_API_KEY')

  // An explicit non-empty value always wins.
  const explicit = providerConfigFor('mimo', {
    mimo: { designModel: 'mimo-v2.5-tts-voicedesign-custom' },
  })
  assert.equal(explicit.designModel, 'mimo-v2.5-tts-voicedesign-custom')

  // When the built-in default is empty too, '' is preserved (sapi has no model).
  const sapi = providerConfigFor('sapi', { sapi: { model: '', voiceName: '' } })
  assert.equal(sapi.model, '')
  assert.equal(sapi.voiceName, '')
})

// ---------------------------------------------------------------------------
// Capability table
// ---------------------------------------------------------------------------

test('capabilities: openai-compatible', () => {
  assert.equal(openaiAdapter.id, 'openai-compatible')
  assert.equal(openaiAdapter.capabilities.speech, true)
  assert.equal(openaiAdapter.capabilities.singing, false)
  assert.deepEqual([...openaiAdapter.capabilities.formats], ['mp3', 'wav'])
  assert.equal(openaiAdapter.capabilities.requiresKey, true)
  assert.equal(openaiAdapter.capabilities.voiceDesign, false)
  assert.equal(openaiAdapter.capabilities.voiceClone, false)
  assert.equal(openaiAdapter.capabilities.platforms, undefined)
  const voiceIds = openaiAdapter.capabilities.voices.map((voice) => voice.id)
  for (const id of ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']) {
    assert.ok(voiceIds.includes(id), `missing openai voice ${id}`)
  }
})

test('capabilities: mimo exposes nine voices, singing and design/clone flags', () => {
  assert.equal(mimoAdapter.id, 'mimo')
  assert.equal(mimoAdapter.capabilities.speech, true)
  assert.equal(mimoAdapter.capabilities.singing, true)
  assert.deepEqual([...mimoAdapter.capabilities.formats], ['wav', 'mp3'])
  assert.equal(mimoAdapter.capabilities.requiresKey, true)
  assert.equal(mimoAdapter.capabilities.voiceDesign, true)
  assert.equal(mimoAdapter.capabilities.voiceClone, true)
  const voices = mimoAdapter.capabilities.voices
  assert.equal(voices.length, 9)
  const ids = voices.map((voice) => voice.id)
  for (const id of ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean']) {
    assert.ok(ids.includes(id), `missing mimo voice ${id}`)
  }
  const bingtang = voices.find((voice) => voice.id === '冰糖')
  assert.equal(bingtang.description, '活泼少女（中文）')
  const soda = voices.find((voice) => voice.id === '苏打')
  assert.equal(soda.description, '阳光少年（中文）')
})

test('capabilities: sapi is Windows-only and needs no key', () => {
  assert.equal(sapiAdapter.id, 'sapi')
  assert.equal(sapiAdapter.capabilities.requiresKey, false)
  assert.deepEqual([...sapiAdapter.capabilities.formats], ['wav'])
  assert.deepEqual([...sapiAdapter.capabilities.platforms], ['win32'])
  assert.equal(sapiAdapter.capabilities.voiceDesign, false)
  assert.equal(sapiAdapter.capabilities.voiceClone, false)
})

test('capabilities: minimax supports mp3/wav and keeps a key requirement', () => {
  assert.equal(minimaxAdapter.id, 'minimax')
  assert.equal(minimaxAdapter.capabilities.speech, true)
  assert.deepEqual([...minimaxAdapter.capabilities.formats], ['mp3', 'wav'])
  assert.equal(minimaxAdapter.capabilities.requiresKey, true)
  assert.equal(minimaxAdapter.capabilities.voiceDesign, false)
  assert.equal(minimaxAdapter.capabilities.voiceClone, false)
})

test('capabilities: siliconflow exposes CosyVoice voices over OpenAI protocol', () => {
  assert.equal(siliconflowAdapter.id, 'siliconflow')
  assert.equal(siliconflowAdapter.capabilities.speech, true)
  assert.deepEqual([...siliconflowAdapter.capabilities.formats], ['mp3', 'wav'])
  assert.equal(siliconflowAdapter.capabilities.requiresKey, true)
  assert.equal(siliconflowAdapter.capabilities.voiceDesign, false)
  assert.equal(siliconflowAdapter.capabilities.voiceClone, false)
  const ids = siliconflowAdapter.capabilities.voices.map((voice) => voice.id)
  assert.ok(ids.includes('FunAudioLLM/CosyVoice2-0.5B:alex'))
  assert.ok(ids.includes('FunAudioLLM/CosyVoice2-0.5B:anna'))
})

// ---------------------------------------------------------------------------
// openai-compatible
// ---------------------------------------------------------------------------

test('openai: posts to {baseURL}/audio/speech with bearer auth and JSON body', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(wavBytes()))
  const runtime = makeRuntime({ fetch: fetchImpl })

  const result = await openaiAdapter.synthesize(
    {
      text: 'hello world',
      style: 'cheerful and bright',
      signal: idleSignal(),
    },
    openaiConfig(),
    runtime,
  )

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.url, 'https://api.openai.test/v1/audio/speech')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers.Authorization, `Bearer ${TEST_KEY}`)
  assert.equal(call.init.headers['Content-Type'], 'application/json')

  const body = JSON.parse(call.init.body)
  assert.deepEqual(body, {
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    input: 'hello world',
    response_format: 'wav',
    instructions: 'cheerful and bright',
  })

  assert.deepEqual([...result.data], [...wavBytes()])
  assert.equal(result.format, 'wav')
  assert.equal(result.voice, 'alloy')
})

test('openai: omits instructions when no style is configured', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(wavBytes()))
  const runtime = makeRuntime({ fetch: fetchImpl })

  await openaiAdapter.synthesize(
    { text: 'plain', signal: idleSignal() },
    openaiConfig({ style: '' }),
    runtime,
  )

  const body = JSON.parse(calls[0].init.body)
  assert.equal(Object.hasOwn(body, 'instructions'), false)
  assert.equal(body.input, 'plain')
})

test('openai: request.model/voice override the provider block', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(wavBytes()))
  const runtime = makeRuntime({ fetch: fetchImpl })

  await openaiAdapter.synthesize(
    { text: 'override', model: 'gpt-4o-audio-preview', voice: 'nova', signal: idleSignal() },
    openaiConfig(),
    runtime,
  )

  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'gpt-4o-audio-preview')
  assert.equal(body.voice, 'nova')
})

test('openai: falls back to the first supported format when the request format is unknown', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(mp3Bytes()))
  const runtime = makeRuntime({ fetch: fetchImpl })

  const result = await openaiAdapter.synthesize(
    { text: 'fallback', format: 'ogg', signal: idleSignal() },
    openaiConfig(),
    runtime,
  )

  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.response_format, 'mp3')
  assert.equal(result.format, 'mp3')
})

test('openai: default format is the provider default (mp3)', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(mp3Bytes()))
  const runtime = makeRuntime({ fetch: fetchImpl })

  const result = await openaiAdapter.synthesize(
    { text: 'default format', signal: idleSignal() },
    openaiConfig({ format: undefined }),
    runtime,
  )

  assert.equal(JSON.parse(calls[0].init.body).response_format, 'mp3')
  assert.equal(result.format, 'mp3')
})

test('openai: rejects non-audio bytes instead of returning them', async () => {
  const { fetchImpl } = makeFetch(
    () => audioResponse(new TextEncoder().encode('not audio at all'), 200),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    openaiAdapter.synthesize({ text: 'bad audio', signal: idleSignal() }, openaiConfig(), runtime),
    { kind: 'provider', provider: 'openai-compatible' },
  )
})

test('openai: missing credential is classified as auth (no key is sent)', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(wavBytes()))
  const runtime = makeRuntime({
    fetch: fetchImpl,
    resolveKey: async () => undefined,
  })

  await expectTtsError(
    openaiAdapter.synthesize({ text: 'no key', signal: idleSignal() }, openaiConfig(), runtime),
    { kind: 'auth', provider: 'openai-compatible', retryable: false },
  )
  assert.equal(calls.length, 0)
})

for (const [status, kind, retryable] of [
  [400, 'provider', false],
  [401, 'auth', false],
  [402, 'quota', false],
  [403, 'auth', false],
  [404, 'provider', false],
  [422, 'provider', false],
  [429, 'rate-limit', true],
  [500, 'server', true],
  [503, 'server', true],
]) {
  test(`openai: HTTP ${status} maps to ${kind}`, async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(
        {
          error: {
            message: `rejected key ${TEST_KEY} while reading ${TEST_TEXT}`,
            type: 'invalid_request_error',
          },
        },
        status,
      ),
    )
    const runtime = makeRuntime({ fetch: fetchImpl })

    await expectTtsError(
      openaiAdapter.synthesize(
        { text: TEST_TEXT, signal: idleSignal() },
        openaiConfig(),
        runtime,
      ),
      {
        kind,
        status,
        provider: 'openai-compatible',
        retryable,
        secrets: [TEST_KEY, TEST_TEXT],
      },
    )
  })
}

test('openai: a network failure is retryable', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed: ECONNREFUSED')
  }
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    openaiAdapter.synthesize({ text: 'network', signal: idleSignal() }, openaiConfig(), runtime),
    { kind: 'network', retryable: true, provider: 'openai-compatible' },
  )
})

test('openai: a fetch that throws synchronously is classified as network', async () => {
  const runtime = makeRuntime({
    fetch: () => {
      throw new TypeError('fetch failed: synchronous')
    },
  })

  await expectTtsError(
    openaiAdapter.synthesize({ text: 'sync', signal: idleSignal() }, openaiConfig(), runtime),
    { kind: 'network', retryable: true, provider: 'openai-compatible' },
  )
})

test('openai: a fetch that never settles hits the adapter timeout', async () => {
  const fetchImpl = () => new Promise(() => undefined)
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    openaiAdapter.synthesize(
      { text: 'slow', signal: idleSignal() },
      openaiConfig({ timeoutMs: 30 }),
      runtime,
    ),
    { kind: 'timeout', retryable: true, provider: 'openai-compatible' },
  )
})

test('openai: a DOMException TimeoutError is classified as timeout', async () => {
  const fetchImpl = async () => {
    throw new DOMException('the operation timed out', 'TimeoutError')
  }
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    openaiAdapter.synthesize({ text: 'timeout', signal: idleSignal() }, openaiConfig(), runtime),
    { kind: 'timeout', retryable: true, provider: 'openai-compatible' },
  )
})

test('openai: aborting request.signal aborts the call', async () => {
  const controller = new AbortController()
  const fetchImpl = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
  const runtime = makeRuntime({ fetch: fetchImpl })

  const pending = openaiAdapter.synthesize(
    { text: 'abort me', signal: controller.signal },
    openaiConfig({ timeoutMs: 60_000 }),
    runtime,
  )
  setTimeout(() => controller.abort(), 10)

  await expectTtsError(pending, { kind: 'aborted', provider: 'openai-compatible' })
})

test('openai: an already-aborted signal never calls fetch', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(wavBytes()))
  const runtime = makeRuntime({ fetch: fetchImpl })
  const controller = new AbortController()
  controller.abort()

  await expectTtsError(
    openaiAdapter.synthesize(
      { text: 'already aborted', signal: controller.signal },
      openaiConfig(),
      runtime,
    ),
    { kind: 'aborted', provider: 'openai-compatible' },
  )
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// mimo
// ---------------------------------------------------------------------------

test('mimo: uses the api-key header, chat messages and base64 audio', async () => {
  const audio = wavBytes()
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            audio: {
              data: Buffer.from(audio).toString('base64'),
              format: 'wav',
            },
          },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  const result = await mimoAdapter.synthesize(
    { text: '念这句话', style: '开心一点', signal: idleSignal() },
    mimoConfig(),
    runtime,
  )

  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.url, 'https://api.mimo.test/v1/chat/completions')
  assert.equal(call.init.method, 'POST')
  assert.equal(call.init.headers['api-key'], TEST_KEY)
  assert.equal(call.init.headers.Authorization, undefined)
  assert.equal(call.init.headers['Content-Type'], 'application/json')

  const body = JSON.parse(call.init.body)
  assert.equal(body.model, 'mimo-v2.5-tts')
  assert.equal(body.stream, false)
  assert.deepEqual(body.messages, [
    { role: 'user', content: '开心一点' },
    { role: 'assistant', content: '念这句话' },
  ])
  assert.deepEqual(body.audio, { format: 'wav', voice: '苏打' })

  assert.deepEqual([...result.data], [...audio])
  assert.equal(result.format, 'wav')
  assert.equal(result.voice, '苏打')
})

test('mimo: text is forwarded verbatim (no trimming inside the adapter)', async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { audio: { data: Buffer.from(wavBytes()).toString('base64'), format: 'wav' } },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  await mimoAdapter.synthesize(
    { text: '  前后有空格  ', style: '', signal: idleSignal() },
    mimoConfig(),
    runtime,
  )

  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.messages[1].content, '  前后有空格  ')
  assert.equal(body.messages[0].content, '')
})

test('mimo: request.voice wins over config.voice', async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { audio: { data: Buffer.from(wavBytes()).toString('base64'), format: 'wav' } },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  await mimoAdapter.synthesize(
    { text: 'voice override', voice: 'Chloe', signal: idleSignal() },
    mimoConfig({ voice: '苏打' }),
    runtime,
  )

  assert.equal(JSON.parse(calls[0].init.body).audio.voice, 'Chloe')
})

test('mimo: voicedesign (request.model override, no voice) omits audio.voice', async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { audio: { data: Buffer.from(wavBytes()).toString('base64'), format: 'wav' } },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  const result = await mimoAdapter.synthesize(
    {
      text: '设计音色的示例句',
      model: 'mimo-v2.5-tts-voicedesign',
      style: '年轻男性，声音清亮',
      signal: idleSignal(),
    },
    // A configured preset voice must NOT leak into a design request: the API
    // ignores the user-message description when audio.voice is present.
    mimoConfig({ voice: '苏打', designModel: 'mimo-v2.5-tts-voicedesign' }),
    runtime,
  )

  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'mimo-v2.5-tts-voicedesign')
  assert.equal(Object.hasOwn(body.audio, 'voice'), false)
  assert.equal(body.audio.format, 'wav')
  assert.equal(body.audio.optimize_text_preview, true)
  assert.deepEqual(body.messages[0], { role: 'user', content: '年轻男性，声音清亮' })
  assert.deepEqual(body.messages[1], { role: 'assistant', content: '设计音色的示例句' })
  assert.equal(result.format, 'wav')
})

test('mimo: voicedesign honours designOptimizeText=false', async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { audio: { data: Buffer.from(wavBytes()).toString('base64'), format: 'wav' } },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  await mimoAdapter.synthesize(
    {
      text: '示例句',
      model: 'mimo-v2.5-tts-voicedesign',
      style: '低沉男声',
      signal: idleSignal(),
    },
    mimoConfig({ designOptimizeText: false }),
    runtime,
  )

  const body = JSON.parse(calls[0].init.body)
  assert.equal(Object.hasOwn(body.audio, 'optimize_text_preview'), false)
  assert.equal(Object.hasOwn(body.audio, 'voice'), false)
})

test('mimo: voiceclone sends the sample data URL and never falls back to a preset voice', async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { audio: { data: Buffer.from(wavBytes()).toString('base64'), format: 'wav' } },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  const sample = 'data:audio/wav;base64,UklGRg=='
  await mimoAdapter.synthesize(
    {
      text: '克隆音色的示例句',
      model: 'mimo-v2.5-tts-voiceclone',
      voice: sample,
      signal: idleSignal(),
    },
    mimoConfig({ voice: '苏打', cloneModel: 'mimo-v2.5-tts-voiceclone' }),
    runtime,
  )

  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'mimo-v2.5-tts-voiceclone')
  assert.equal(body.audio.voice, sample)
})

test('mimo: voiceclone without a sample omits audio.voice instead of using a preset', async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { audio: { data: Buffer.from(wavBytes()).toString('base64'), format: 'wav' } },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  await mimoAdapter.synthesize(
    { text: '无样本', model: 'mimo-v2.5-tts-voiceclone', signal: idleSignal() },
    mimoConfig({ voice: '苏打' }),
    runtime,
  )

  const body = JSON.parse(calls[0].init.body)
  assert.equal(Object.hasOwn(body.audio, 'voice'), false)
})

test('mimo: a missing choices array is a provider error', async () => {
  const { fetchImpl } = makeFetch(() => jsonResponse({ id: 'x', object: 'chat.completion' }))
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    mimoAdapter.synthesize({ text: 'no choices', signal: idleSignal() }, mimoConfig(), runtime),
    { kind: 'provider', provider: 'mimo' },
  )
})

test('mimo: finish_reason content_filter is classified as content-filter', async () => {
  const { fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'content_filter',
          message: { audio: { data: '' } },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    mimoAdapter.synthesize({ text: TEST_TEXT, signal: idleSignal() }, mimoConfig(), runtime),
    {
      kind: 'content-filter',
      provider: 'mimo',
      retryable: false,
      secrets: [TEST_KEY, TEST_TEXT],
    },
  )
})

test('mimo: a 200 response carrying an error object is classified', async () => {
  const { fetchImpl } = makeFetch(() =>
    jsonResponse({ error: { code: 'content_filter', message: 'sensitive content' } }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    mimoAdapter.synthesize({ text: TEST_TEXT, signal: idleSignal() }, mimoConfig(), runtime),
    { kind: 'content-filter', provider: 'mimo', retryable: false },
  )
})

test('mimo: uses the format reported by the response when present', async () => {
  const audio = mp3Bytes()
  const { fetchImpl } = makeFetch(() =>
    jsonResponse({
      choices: [
        {
          finish_reason: 'stop',
          message: { audio: { data: Buffer.from(audio).toString('base64'), format: 'mp3' } },
        },
      ],
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  const result = await mimoAdapter.synthesize(
    { text: 'format from response', signal: idleSignal() },
    mimoConfig({ format: 'wav' }),
    runtime,
  )

  assert.equal(result.format, 'mp3')
  assert.deepEqual([...result.data], [...audio])
})

test('mimo: HTTP status mapping (401 auth, 429 rate-limit) without leaking secrets', async () => {
  const cases = [
    [401, 'auth', false],
    [402, 'quota', false],
    [429, 'rate-limit', true],
    [500, 'server', true],
  ]
  for (const [status, kind, retryable] of cases) {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse(
        { error: { message: `bad key ${TEST_KEY}; text ${TEST_TEXT}` } },
        status,
      ),
    )
    const runtime = makeRuntime({ fetch: fetchImpl })
    await expectTtsError(
      mimoAdapter.synthesize(
        { text: TEST_TEXT, signal: idleSignal() },
        mimoConfig(),
        runtime,
      ),
      { kind, status, provider: 'mimo', retryable, secrets: [TEST_KEY, TEST_TEXT] },
    )
  }
})

test('mimo: invalid JSON is a provider error', async () => {
  const { fetchImpl } = makeFetch(
    () => new Response('<html>gateway error</html>', { status: 200 }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    mimoAdapter.synthesize({ text: 'bad json', signal: idleSignal() }, mimoConfig(), runtime),
    { kind: 'provider', provider: 'mimo', retryable: false },
  )
})

test('mimo: a fetch that never settles hits the adapter timeout', async () => {
  const fetchImpl = () => new Promise(() => undefined)
  const runtime = makeRuntime({ fetch: fetchImpl })

  await expectTtsError(
    mimoAdapter.synthesize(
      { text: 'slow', signal: idleSignal() },
      mimoConfig({ timeoutMs: 30 }),
      runtime,
    ),
    { kind: 'timeout', retryable: true, provider: 'mimo' },
  )
})

// ---------------------------------------------------------------------------
// sapi
// ---------------------------------------------------------------------------

test('sapi: buildSapiInvocation is deterministic and omits voice/rate by default', () => {
  const invocation = buildSapiInvocation({
    scriptPath: 'C:\\plugin\\scripts\\sapi.ps1',
    textFile: 'C:\\state\\sapi-abc.txt',
    outFile: 'C:\\state\\sapi-abc.wav',
    env: { SystemRoot: 'C:\\Windows' },
  })

  assert.equal(
    invocation.command,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  )
  assert.deepEqual(invocation.args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\plugin\\scripts\\sapi.ps1',
    '-TextFile',
    'C:\\state\\sapi-abc.txt',
    '-OutFile',
    'C:\\state\\sapi-abc.wav',
  ])
  // Second call for the same input yields the same argv (no randomness).
  assert.deepEqual(
    buildSapiInvocation({
      scriptPath: 'C:\\plugin\\scripts\\sapi.ps1',
      textFile: 'C:\\state\\sapi-abc.txt',
      outFile: 'C:\\state\\sapi-abc.wav',
      env: { SystemRoot: 'C:\\Windows' },
    }),
    invocation,
  )
})

test('sapi: buildSapiInvocation appends -Voice and -Rate only when set', () => {
  const withValues = buildSapiInvocation({
    scriptPath: 'C:\\s\\sapi.ps1',
    textFile: 'C:\\t\\in.txt',
    outFile: 'C:\\t\\out.wav',
    voiceName: 'Microsoft Huihui Desktop',
    rate: 3,
    env: {},
  })
  assert.equal(withValues.command, 'powershell')
  assert.deepEqual(withValues.args.slice(-4), [
    '-Voice',
    'Microsoft Huihui Desktop',
    '-Rate',
    '3',
  ])

  // Empty voice and neutral rate produce no extra flags.
  const withoutValues = buildSapiInvocation({
    scriptPath: 'C:\\s\\sapi.ps1',
    textFile: 'C:\\t\\in.txt',
    outFile: 'C:\\t\\out.wav',
    voiceName: '   ',
    rate: 0,
    env: {},
  })
  assert.equal(withoutValues.args.includes('-Voice'), false)
  assert.equal(withoutValues.args.includes('-Rate'), false)

  // Out-of-range rates are clamped to the SAPI range.
  const clampedHigh = buildSapiInvocation({
    scriptPath: 'C:\\s\\sapi.ps1',
    textFile: 'C:\\t\\in.txt',
    outFile: 'C:\\t\\out.wav',
    rate: 99,
    env: {},
  })
  assert.deepEqual(clampedHigh.args.slice(-2), ['-Rate', '10'])
  const clampedLow = buildSapiInvocation({
    scriptPath: 'C:\\s\\sapi.ps1',
    textFile: 'C:\\t\\in.txt',
    outFile: 'C:\\t\\out.wav',
    rate: -99,
    env: {},
  })
  assert.deepEqual(clampedLow.args.slice(-2), ['-Rate', '-10'])
})

test('sapi: non-win32 platform is rejected before touching the file system', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(wavBytes()))
  const runtime = makeRuntime({ fetch: fetchImpl, platform: 'linux' })

  await expectTtsError(
    sapiAdapter.synthesize(
      { text: '你好', signal: idleSignal() },
      { format: 'wav' },
      runtime,
    ),
    { kind: 'platform', provider: 'sapi', retryable: false },
  )
  assert.equal(calls.length, 0)
})

// ---------------------------------------------------------------------------
// minimax
// ---------------------------------------------------------------------------

test('minimax: posts the t2a_v2 request and decodes hex audio', async () => {
  const { calls, fetchImpl } = makeFetch(() =>
    jsonResponse({
      data: { audio: mp3Hex(), status: 2 },
      extra_info: { audio_length: 1000, format: 'mp3' },
      base_resp: { status_code: 0, status_msg: 'success' },
    }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl })

  const result = await minimaxAdapter.synthesize(
    { text: 'hello minimax', signal: idleSignal() },
    {
      baseURL: 'https://api.minimax.test/v1/',
      apiKeyEnv: 'MINIMAX_API_KEY',
      model: 'speech-2.8-hd',
      voice: 'female-shaonv',
      format: 'mp3',
      timeoutMs: 5_000,
    },
    runtime,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.minimax.test/v1/t2a_v2')
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TEST_KEY}`)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'speech-2.8-hd')
  assert.equal(body.text, 'hello minimax')
  assert.equal(body.stream, false)
  assert.deepEqual(body.voice_setting, { voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0 })
  assert.deepEqual(body.audio_setting, {
    sample_rate: 32_000,
    bitrate: 128_000,
    format: 'mp3',
    channel: 1,
  })
  assert.equal(body.output_format, 'hex')
  assert.deepEqual([...result.data], [...mp3Bytes()])
  assert.equal(result.format, 'mp3')
  assert.equal(result.voice, 'female-shaonv')
})

test('minimax: missing credential is auth and never calls fetch', async () => {
  const { calls, fetchImpl } = makeFetch(() => jsonResponse({ data: { audio: mp3Hex() } }))
  const runtime = makeRuntime({ fetch: fetchImpl, resolveKey: async () => undefined })

  await expectTtsError(
    minimaxAdapter.synthesize(
      { text: 'no key', signal: idleSignal() },
      { baseURL: 'https://api.minimax.test/v1', apiKeyEnv: 'MINIMAX_API_KEY' },
      runtime,
    ),
    { kind: 'auth', provider: 'minimax', retryable: false },
  )
  assert.equal(calls.length, 0)
})

test('minimax: base_resp 1004 maps to auth, 1002 to rate-limit', async () => {
  for (const [code, kind, retryable] of [
    [1004, 'auth', false],
    [1002, 'rate-limit', true],
  ]) {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        data: { audio: '' },
        base_resp: { status_code: code, status_msg: 'provider says no' },
      }),
    )
    await expectTtsError(
      minimaxAdapter.synthesize(
        { text: 'error case', signal: idleSignal() },
        { baseURL: 'https://api.minimax.test/v1', apiKeyEnv: 'MINIMAX_API_KEY' },
        makeRuntime({ fetch: fetchImpl }),
      ),
      { kind, provider: 'minimax', retryable },
    )
  }
})

test('minimax: invalid hex is a provider error', async () => {
  const { fetchImpl } = makeFetch(() =>
    jsonResponse({
      data: { audio: 'not-hex' },
      base_resp: { status_code: 0, status_msg: 'success' },
    }),
  )
  await expectTtsError(
    minimaxAdapter.synthesize(
      { text: 'bad audio', signal: idleSignal() },
      { baseURL: 'https://api.minimax.test/v1', apiKeyEnv: 'MINIMAX_API_KEY' },
      makeRuntime({ fetch: fetchImpl }),
    ),
    { kind: 'provider', provider: 'minimax', retryable: false },
  )
})

test('siliconflow: reuses the OpenAI speech protocol with its own defaults', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(mp3Bytes()))
  const runtime = makeRuntime({ fetch: fetchImpl })

  const result = await siliconflowAdapter.synthesize(
    { text: 'hello siliconflow', signal: idleSignal() },
    {
      baseURL: 'https://api.siliconflow.test/v1',
      apiKeyEnv: 'SILICONFLOW_API_KEY',
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
      format: 'mp3',
      timeoutMs: 5_000,
    },
    runtime,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.siliconflow.test/v1/audio/speech')
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TEST_KEY}`)
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.model, 'FunAudioLLM/CosyVoice2-0.5B')
  assert.equal(body.voice, 'FunAudioLLM/CosyVoice2-0.5B:alex')
  assert.equal(body.input, 'hello siliconflow')
  assert.equal(body.response_format, 'mp3')
  assert.deepEqual([...result.data], [...mp3Bytes()])
  assert.equal(result.format, 'mp3')
})

test('siliconflow: errors are labelled siliconflow, not openai-compatible', async () => {
  const { fetchImpl } = makeFetch(() => jsonResponse({ error: { message: 'bad key' } }, 401))
  await expectTtsError(
    siliconflowAdapter.synthesize(
      { text: 'auth', signal: idleSignal() },
      { baseURL: 'https://api.siliconflow.test/v1', apiKeyEnv: 'SILICONFLOW_API_KEY' },
      makeRuntime({ fetch: fetchImpl }),
    ),
    { kind: 'auth', provider: 'siliconflow', retryable: false },
  )
})

test('qwen: posts to DashScope, downloads the audio URL and returns WAV', async () => {
  const { calls, fetchImpl } = makeFetch(({ index }) => {
    if (index === 1) {
      return jsonResponse({
        status_code: 200,
        request_id: 'req-qwen-1',
        output: { audio: { url: 'https://audio.test/qwen.wav' } },
      })
    }
    return audioResponse(wavBytes())
  })
  const runtime = makeRuntime({ fetch: fetchImpl, resolveKey: async () => TEST_KEY })

  const result = await qwenAdapter.synthesize(
    { text: '你好，云端 Qwen。', signal: idleSignal() },
    {
      enabled: true,
      baseURL: 'https://dashscope.test/api/v1',
      apiKeyEnv: 'DASHSCOPE_API_KEY',
      model: 'qwen3-tts-flash',
      voice: 'Cherry',
      format: 'wav',
    },
    runtime,
  )

  assert.equal(calls.length, 2)
  assert.equal(
    calls[0].url,
    'https://dashscope.test/api/v1/services/aigc/multimodal-generation/generation',
  )
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TEST_KEY}`)
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'qwen3-tts-flash',
    input: { text: '你好，云端 Qwen。', voice: 'Cherry' },
  })
  assert.equal(calls[1].url, 'https://audio.test/qwen.wav')
  assert.equal(result.format, 'wav')
  assert.equal(result.voice, 'Cherry')
  assert.equal(result.meta.requestId, 'req-qwen-1')
  assert.deepEqual([...result.data], [...wavBytes()])
})

test('qwen: an API error is a provider error, not a successful empty file', async () => {
  const { fetchImpl } = makeFetch(() =>
    jsonResponse({ status_code: 400, code: 'InvalidParameter', message: 'text too long' }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl, resolveKey: async () => TEST_KEY })

  await expectTtsError(
    qwenAdapter.synthesize(
      { text: 'bad', signal: idleSignal() },
      { enabled: true, apiKeyEnv: 'DASHSCOPE_API_KEY', model: 'qwen3-tts-flash', voice: 'Cherry' },
      runtime,
    ),
    'provider',
  )
})

/* -------------------------------------------------------------------------- */
/* doubao                                                                      */
/* -------------------------------------------------------------------------- */

const MP3_BYTES = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00])

test('doubao: parses V3 SSE audio chunks and sends the new-console headers', async () => {
  const first = MP3_BYTES.slice(0, 4)
  const second = MP3_BYTES.slice(4)
  const body = [
    `event: 352\ndata: ${JSON.stringify({ code: 0, data: Buffer.from(first).toString('base64') })}`,
    `event: 352\ndata: ${JSON.stringify({ code: 0, data: Buffer.from(second).toString('base64') })}`,
    'event: 152\ndata: {"code":20000000,"message":"OK","data":null}',
    '',
  ]
    .join('\n\n')
    .replace(/\n/g, '\r\n')
  const { calls, fetchImpl } = makeFetch(
    () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl, resolveKey: async () => TEST_KEY })

  const result = await doubaoAdapter.synthesize(
    { text: '你好，豆包。', signal: idleSignal() },
    {
      enabled: true,
      baseURL: 'https://openspeech.test/api/v3',
      resourceId: 'seed-tts-2.0',
      apiKeyEnv: 'DOUBAO_API_KEY',
      voice: 'zh_female_vv_uranus_bigtts',
      format: 'mp3',
    },
    runtime,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://openspeech.test/api/v3/tts/unidirectional/sse')
  assert.equal(calls[0].init.headers['X-Api-Key'], TEST_KEY)
  assert.equal(calls[0].init.headers['X-Api-Resource-Id'], 'seed-tts-2.0')
  assert.match(calls[0].init.headers['X-Api-Request-Id'], /^[0-9a-f-]{36}$/)
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    user: { uid: 'dsh-whale-tts' },
    req_params: {
      text: '你好，豆包。',
      speaker: 'zh_female_vv_uranus_bigtts',
      audio_params: { format: 'mp3', sample_rate: 24000 },
    },
  })
  assert.equal(result.format, 'mp3')
  assert.deepEqual([...result.data], [...MP3_BYTES])
})

test('doubao: a 45000000 SSE failure is an auth error', async () => {
  const body =
    'event: 153\ndata: {"code":45000000,"message":"speaker permission denied"}\n\n'
  const { fetchImpl } = makeFetch(
    () =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  )
  const runtime = makeRuntime({ fetch: fetchImpl, resolveKey: async () => TEST_KEY })

  await expectTtsError(
    doubaoAdapter.synthesize(
      { text: 'err', signal: idleSignal() },
      {
        enabled: true,
        apiKeyEnv: 'DOUBAO_API_KEY',
        resourceId: 'seed-tts-2.0',
        voice: 'zh_female_vv_uranus_bigtts',
      },
      runtime,
    ),
    'auth',
  )
})

/* -------------------------------------------------------------------------- */
/* qwen-local                                                                  */
/* -------------------------------------------------------------------------- */

test('qwen-local: posts an OpenAI-compatible request and does not require a key', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(wavBytes()))
  const runtime = makeRuntime({
    fetch: fetchImpl,
    resolveKey: async () => undefined,
  })

  const result = await qwenLocalAdapter.synthesize(
    { text: '你好，本地 Qwen。', signal: idleSignal() },
    {
      enabled: true,
      baseURL: 'http://127.0.0.1:8000/v1',
      apiKeyEnv: '',
      model: 'Qwen/Qwen3-TTS-12Hz-0.6B',
      voice: 'Cherry',
      format: 'wav',
    },
    runtime,
  )

  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:8000/v1/audio/speech')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.Authorization, undefined)
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    model: 'Qwen/Qwen3-TTS-12Hz-0.6B',
    voice: 'Cherry',
    input: '你好，本地 Qwen。',
    response_format: 'wav',
  })
  assert.equal(result.format, 'wav')
  assert.equal(result.voice, 'Cherry')
  assert.deepEqual([...result.data], [...wavBytes()])
})

test('qwen-local: a configured ref adds a bearer token', async () => {
  const { calls, fetchImpl } = makeFetch(() => audioResponse(wavBytes()))
  const runtime = makeRuntime({
    fetch: fetchImpl,
    resolveKey: async () => TEST_KEY,
  })

  await qwenLocalAdapter.synthesize(
    { text: '带 token 的本地服务', signal: idleSignal() },
    {
      enabled: true,
      baseURL: 'http://127.0.0.1:8000/v1/',
      apiKeyEnv: 'QWEN_LOCAL_API_KEY',
      model: 'qwen3-tts',
      voice: 'Cherry',
      format: 'wav',
    },
    runtime,
  )

  assert.equal(calls[0].url, 'http://127.0.0.1:8000/v1/audio/speech')
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TEST_KEY}`)
})

/* -------------------------------------------------------------------------- */
/* selectable providers                                                       */
/* -------------------------------------------------------------------------- */

test('mimo, siliconflow, minimax, qwen, doubao and qwen-local are selectable as primary providers', () => {
  assert.equal(isProviderSelectable('mimo'), true)
  assert.equal(isProviderSelectable('siliconflow'), true)
  assert.equal(isProviderSelectable('minimax'), true)
  assert.equal(isProviderSelectable('qwen'), true)
  assert.equal(isProviderSelectable('doubao'), true)
  assert.equal(isProviderSelectable('qwen-local'), true)
  assert.equal(isProviderSelectable('openai-compatible'), false)
  // SAPI stays usable as an internal fallback, but not as a primary choice.
  assert.equal(isProviderSelectable('sapi'), false)
  // Unknown ids (custom adapters used by tests / third parties) stay allowed.
  assert.equal(isProviderSelectable('fake'), true)
})

test('DEFAULT_PROVIDERS enables implemented providers and keeps the rest off', () => {
  assert.equal(DEFAULT_PROVIDERS['mimo'].enabled, true)
  assert.equal(DEFAULT_PROVIDERS['siliconflow'].enabled, true)
  assert.equal(DEFAULT_PROVIDERS['minimax'].enabled, true)
  assert.equal(DEFAULT_PROVIDERS['qwen'].enabled, true)
  assert.equal(DEFAULT_PROVIDERS['doubao'].enabled, true)
  assert.equal(DEFAULT_PROVIDERS['qwen-local'].enabled, true)
  assert.equal(DEFAULT_PROVIDERS['openai-compatible'].enabled, false)
  assert.equal(DEFAULT_PROVIDERS['sapi'].enabled, true)
})
