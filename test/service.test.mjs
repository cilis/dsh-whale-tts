/**
 * M9 synthesis-service tests.
 *
 * A real `TtsService` is constructed against injectable dependencies: a fake
 * provider adapter table, a fake credential bridge, a fake `fetch` that throws
 * if touched, and a throwaway temporary directory for every test. No network,
 * no real credentials and no files outside the OS temp dir are involved.
 *
 * Run after building:
 *   npm run build:host && node --test --test-isolation=none test/service.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'

import { TtsService } from '../lib/core/service.js'
import { TtsError } from '../lib/types.js'
import { minimaxAdapter } from '../lib/providers/minimax.js'
import { siliconflowAdapter } from '../lib/providers/siliconflow.js'

/** Minimal RIFF/WAVE payload (passes the magic-byte check). */
const WAV = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, // "RIFF"
  0x24, 0x00, 0x00, 0x00, // chunk size
  0x57, 0x41, 0x56, 0x45, // "WAVE"
  0x66, 0x6d, 0x74, 0x20, // "fmt "
  0x10, 0x00, 0x00, 0x00, // 16
  0x01, 0x00, 0x01, 0x00, // PCM, mono
])

/** Minimal MP3 payload (ID3 header, passes the magic-byte check). */
const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])

/** Fake primary key. */
const TEST_KEY = 'sk-fake-0123456789abcdef'
/** Fake fallback-provider key. */
const FALLBACK_KEY = 'sk-fake2-0123456789abcdef'
/** Sentenced stored in the voice-store sample used by the clone test. */
const SAMPLE_WAV = WAV

/** A signal that never aborts. */
function idleSignal() {
  return new AbortController().signal
}

/** Predicate for `assert.rejects`: a TtsError of the given kind. */
function isTtsErrorKind(kind) {
  return (error) => {
    assert.ok(error instanceof TtsError, `expected TtsError, got ${String(error)}`)
    assert.equal(error.kind, kind)
    return true
  }
}

/** Recording logger; assertions never depend on printed output. */
function createLogger() {
  const entries = []
  const record = (level) => (message, ...args) => {
    entries.push({ level, message: String(message), args })
  }
  return { entries, info: record('info'), warn: record('warn'), error: record('error'), debug: record('debug') }
}

/** In-memory credential bridge; the default store is empty so env keys win. */
function makeBridge() {
  const store = new Map()
  const calls = { resolve: [], describe: [], set: [], unset: [] }
  return {
    calls,
    store,
    async resolve(ref) {
      calls.resolve.push(ref)
      const value = store.get(ref)
      return value === undefined ? undefined : { value, source: 'credentials' }
    },
    async describe(ref) {
      calls.describe.push(ref)
      return store.has(ref)
        ? { configured: true, source: 'credentials', writable: true }
        : { configured: false, writable: true }
    },
    async set(ref, value) {
      calls.set.push({ ref, value })
      store.set(ref, value)
    },
    async unset(ref) {
      calls.unset.push(ref)
      store.delete(ref)
    },
  }
}

/**
 * Plain `ConfigSnapshot`-shaped config.
 *
 * `snapshot()` accepts plain values as well as volatile getters, so tests do not
 * need the schemastery `Config` object.
 */
function makeConfig(overrides = {}) {
  const base = {
    provider: 'fake',
    fallback: [],
    providers: {
      fake: {
        enabled: true,
        baseURL: '',
        apiKeyEnv: 'FAKE_API_KEY',
        model: 'fake-model',
        designModel: 'design-model',
        cloneModel: 'clone-model',
        voice: 'v1',
        format: 'wav',
        timeoutMs: 5_000,
        retry: 0,
        style: '',
        headers: {},
        voiceName: '',
        scriptPath: '',
        rate: 0,
      },
    },
    output: {
      dir: '${TMP}/out',
      filename: 'tts-{rand}',
      format: 'auto',
      overwrite: false,
    },
    cache: { enabled: true, dir: '', maxAgeDays: 30 },
    limits: { maxChars: 100 },
    log: { text: true },
    activeProfileId: '',
    studioMode: 'preset',
    presetVoiceId: '苏打',
    customVoiceId: '',
    designDescription: '',
    designCandidateCount: 2,
    sampleText: '你好，我是魈。',
    previewText: '你好，我是魈。',
    apiKeyEnv: '',
    keySource: 'reuse',
    baseURLOverride: '',
    keyType: 'auto',
  }

  const providerOverrides = overrides.providers ?? {}
  const providers = {}
  for (const [id, block] of Object.entries(base.providers)) {
    providers[id] = { ...block, ...(providerOverrides[id] ?? {}) }
  }
  for (const [id, block] of Object.entries(providerOverrides)) {
    if (providers[id] === undefined) providers[id] = { ...block }
  }

  return {
    ...base,
    ...overrides,
    providers,
    output: { ...base.output, ...(overrides.output ?? {}) },
    cache: { ...base.cache, ...(overrides.cache ?? {}) },
    limits: { ...base.limits, ...(overrides.limits ?? {}) },
    log: { ...base.log, ...(overrides.log ?? {}) },
  }
}

/** Fake provider adapter that records every synthesize call. */
function makeAdapter(options = {}) {
  const id = options.id ?? 'fake'
  const calls = []
  const handler =
    options.handler ??
    ((request) => ({ data: WAV, format: 'wav', voice: request.voice ?? 'v1' }))
  const adapter = {
    id,
    capabilities: {
      speech: true,
      singing: false,
      formats: ['wav'],
      voices: [{ id: 'v1' }],
      requiresKey: true,
      voiceDesign: true,
      voiceClone: true,
      ...(options.capabilities ?? {}),
    },
    async synthesize(request, config, runtime) {
      calls.push({ request, config, runtime })
      return handler(request, config, runtime, calls.length)
    },
  }
  return { adapter, calls }
}

/** Build a service with a fresh temp home; everything is injectable. */
async function setup(t, options = {}) {
  const tmpHome = await mkdtemp(join(tmpdir(), 'whale-service-'))
  t.after(async () => {
    await rm(tmpHome, { recursive: true, force: true })
  })

  const logger = createLogger()
  const primary = makeAdapter({
    id: 'fake',
    handler: options.handler,
    capabilities: options.capabilities,
  })
  const adapters = new Map([[primary.adapter.id, primary.adapter]])
  const adapterCalls = { fake: primary.calls }
  for (const spec of options.extraAdapters ?? []) {
    const extra = makeAdapter(spec)
    adapters.set(extra.adapter.id, extra.adapter)
    adapterCalls[extra.adapter.id] = extra.calls
  }
  for (const adapter of options.realAdapters ?? []) {
    adapters.set(adapter.id, adapter)
    adapterCalls[adapter.id] = []
  }

  const credentials = options.credentials ?? makeBridge()
  const env = {
    FAKE_API_KEY: TEST_KEY,
    FAKE2_KEY: FALLBACK_KEY,
    ...(options.env ?? {}),
  }

  let fetchCalls = 0
  const fetchImpl =
    options.fetch ??
    (async () => {
      fetchCalls += 1
      throw new Error('fetch must not be called by the fake adapters')
    })

  const setEnv = (name, value) => {
    if (value === undefined) delete env[name]
    else env[name] = value
  }

  const service = new TtsService({
    config: makeConfig(options.config),
    logger,
    env,
    home: tmpHome,
    tmp: tmpHome,
    platform: 'win32',
    fetch: fetchImpl,
    credentials,
    adapters,
    stateDir: join(tmpHome, 'whale-tts'),
  })
  t.after(() => service.dispose())

  if (options.init !== false) await service.init()

  return {
    service,
    tmpHome,
    logger,
    credentials,
    adapters,
    adapterCalls,
    primary: primary.adapter,
    setEnv,
    getFetchCalls: () => fetchCalls,
  }
}

/* -------------------------------------------------------------------------- */
/* init                                                                       */
/* -------------------------------------------------------------------------- */

test('init creates the state layout and an empty voice store', async (t) => {
  const { service, tmpHome } = await setup(t)
  const stateDir = join(tmpHome, 'whale-tts')

  assert.ok((await stat(stateDir)).isDirectory())
  assert.ok((await stat(join(stateDir, 'voices'))).isDirectory())
  assert.ok((await stat(join(stateDir, 'design'))).isDirectory())

  const state = JSON.parse(await readFile(join(stateDir, 'voices.json'), 'utf8'))
  assert.deepEqual(state, { version: 1, activeProfileId: null, profiles: [] })

  // init is idempotent and survives a repeated call.
  await service.init()

  const catalog = await service.listVoices()
  assert.deepEqual([...catalog.profiles], [])
  assert.equal(catalog.activeProfileId, null)
  assert.deepEqual(catalog.providers.map((provider) => provider.id), ['fake'])
  assert.equal(catalog.providers[0].capabilities.speech, true)
  assert.deepEqual(catalog.providers[0].voices, [{ id: 'v1' }])
  assert.deepEqual(await service.listProfiles(), [])
})

/* -------------------------------------------------------------------------- */
/* synthesize                                                                 */
/* -------------------------------------------------------------------------- */

test('synthesize writes into output.dir and returns path, file, format and bytes', async (t) => {
  const { service, tmpHome, adapterCalls, getFetchCalls } = await setup(t)

  const outcome = await service.synthesize({ text: '你好，世界' }, idleSignal())

  const outputDir = service.outputDirectoryForCard().dir
  assert.equal(outputDir, join(tmpHome, 'out'))
  assert.equal(getFetchCalls(), 0)

  assert.equal(outcome.ok, true)
  assert.equal(outcome.cached, false)
  assert.equal(outcome.provider, 'fake')
  assert.equal(outcome.format, 'wav')
  assert.equal(outcome.bytes, WAV.length)
  assert.equal(dirname(outcome.path), outputDir)
  assert.match(outcome.file, /^tts-[0-9a-f]{6}\.wav$/)
  assert.equal(outcome.file, basename(outcome.path))
  assert.equal(outcome.relativePath, outcome.file)
  assert.equal((await stat(outcome.path)).size, WAV.length)
  assert.deepEqual([...await readFile(outcome.path)], [...WAV])

  assert.equal(adapterCalls.fake.length, 1)
  const { request, config } = adapterCalls.fake[0]
  assert.equal(request.text, '你好，世界')
  assert.equal(request.voice, '苏打')
  assert.equal(request.model, 'fake-model')
  assert.equal(request.format, 'wav')
  assert.equal(request.style, undefined)
  assert.ok(request.signal instanceof AbortSignal)
  assert.equal(config.apiKeyEnv, 'FAKE_API_KEY')
})

test('service: siliconflow writes MP3 through the real adapter', async (t) => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(MP3, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
  }
  const { service, credentials, tmpHome } = await setup(t, {
    realAdapters: [siliconflowAdapter],
    fetch: fetchImpl,
    config: {
      provider: 'siliconflow',
      presetVoiceId: 'FunAudioLLM/CosyVoice2-0.5B:alex',
      providers: {
        siliconflow: {
          enabled: true,
          baseURL: 'https://api.siliconflow.test/v1',
          apiKeyEnv: 'SILICONFLOW_API_KEY',
          model: 'FunAudioLLM/CosyVoice2-0.5B',
          voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
          format: 'mp3',
          timeoutMs: 5_000,
          retry: 0,
        },
      },
    },
  })
  await credentials.set('SILICONFLOW_API_KEY', TEST_KEY)

  const outcome = await service.synthesize({ text: '硅基流动验证' }, idleSignal())

  assert.equal(outcome.provider, 'siliconflow')
  assert.equal(outcome.format, 'mp3')
  assert.equal(outcome.bytes, MP3.length)
  assert.equal(dirname(outcome.path), join(tmpHome, 'out'))
  assert.deepEqual([...await readFile(outcome.path)], [...MP3])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.siliconflow.test/v1/audio/speech')
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.input, '硅基流动验证')
  assert.equal(body.voice, 'FunAudioLLM/CosyVoice2-0.5B:alex')

  const status = await service.status()
  assert.equal(status.providers.siliconflow.selectable, true)
})

test('service: minimax decodes hex audio through the real adapter', async (t) => {
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(
      JSON.stringify({
        data: { audio: Buffer.from(MP3).toString('hex'), status: 2 },
        extra_info: { format: 'mp3' },
        base_resp: { status_code: 0, status_msg: 'success' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )
  }
  const { service, credentials } = await setup(t, {
    realAdapters: [minimaxAdapter],
    fetch: fetchImpl,
    config: {
      provider: 'minimax',
      presetVoiceId: 'male-qn-jingying',
      providers: {
        minimax: {
          enabled: true,
          baseURL: 'https://api.minimax.test/v1',
          apiKeyEnv: 'MINIMAX_API_KEY',
          model: 'speech-2.8-turbo',
          voice: 'male-qn-jingying',
          format: 'mp3',
          timeoutMs: 5_000,
          retry: 0,
        },
      },
    },
  })
  await credentials.set('MINIMAX_API_KEY', TEST_KEY)

  const outcome = await service.synthesize({ text: 'MiniMax 验证' }, idleSignal())

  assert.equal(outcome.provider, 'minimax')
  assert.equal(outcome.format, 'mp3')
  assert.deepEqual([...await readFile(outcome.path)], [...MP3])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://api.minimax.test/v1/t2a_v2')
  const body = JSON.parse(requests[0].init.body)
  assert.equal(body.text, 'MiniMax 验证')
  assert.equal(body.output_format, 'hex')
  assert.equal(body.audio_setting.format, 'mp3')
})

test('synthesize reuses the cache and does not call the adapter twice', async (t) => {
  const { service, adapterCalls } = await setup(t)

  const first = await service.synthesize({ text: '缓存测试' }, idleSignal())
  const second = await service.synthesize({ text: '缓存测试' }, idleSignal())

  assert.equal(first.cached, false)
  assert.equal(second.cached, true)
  assert.equal(second.provider, 'fake')
  assert.equal(second.format, 'wav')
  assert.equal(second.bytes, WAV.length)
  assert.equal(adapterCalls.fake.length, 1)
  assert.notEqual(second.path, first.path)
  assert.ok(second.path.includes('.cache'))
  assert.deepEqual([...await readFile(second.path)], [...WAV])

  // A different text is a different cache key and hits the adapter again.
  const third = await service.synthesize({ text: '另一段文本' }, idleSignal())
  assert.equal(third.cached, false)
  assert.equal(adapterCalls.fake.length, 2)
})

test('synthesize rejects empty text, oversized text and unknown providers', async (t) => {
  const { service } = await setup(t)

  await assert.rejects(
    service.synthesize({ text: '   ' }, idleSignal()),
    isTtsErrorKind('validation'),
  )

  await assert.rejects(
    service.synthesize({ text: 'a'.repeat(101) }, idleSignal()),
    (error) =>
      error instanceof TtsError &&
      error.kind === 'validation' &&
      /too long/.test(error.message),
  )

  await assert.rejects(
    service.synthesize({ text: '你好', provider: 'missing-provider' }, idleSignal()),
    (error) =>
      error instanceof TtsError &&
      error.kind === 'config' &&
      /unknown provider "missing-provider"/.test(error.message),
  )
})

/* -------------------------------------------------------------------------- */
/* retry and fallback                                                         */
/* -------------------------------------------------------------------------- */

test('synthesize retries a retryable timeout once when retry=1', async (t) => {
  let attempts = 0
  const { service, adapterCalls } = await setup(t, {
    config: { providers: { fake: { retry: 1 } } },
    handler: (request) => {
      attempts += 1
      if (attempts === 1) throw new TtsError('timeout', 'provider timed out')
      return { data: WAV, format: 'wav', voice: request.voice ?? 'v1' }
    },
  })

  const outcome = await service.synthesize({ text: '重试测试' }, idleSignal())

  assert.equal(outcome.ok, true)
  assert.equal(outcome.cached, false)
  assert.equal(adapterCalls.fake.length, 2)
  assert.equal(attempts, 2)
})

test('synthesize does not retry auth failures', async (t) => {
  const { service, adapterCalls } = await setup(t, {
    config: { providers: { fake: { retry: 2 } } },
    handler: () => {
      throw new TtsError('auth', 'invalid API key', { status: 401 })
    },
  })

  await assert.rejects(
    service.synthesize({ text: '鉴权失败' }, idleSignal()),
    (error) => {
      assert.ok(error instanceof TtsError)
      assert.equal(error.kind, 'auth')
      assert.match(error.message, /all TTS providers failed/)
      assert.match(error.message, /invalid API key/)
      // The configured key never appears in the surfaced error.
      assert.ok(!error.message.includes(TEST_KEY))
      return true
    },
  )
  assert.equal(adapterCalls.fake.length, 1)
})

test('synthesize falls back to the next provider after an auth failure', async (t) => {
  const { service, adapterCalls } = await setup(t, {
    config: {
      fallback: ['fake2'],
      providers: {
        fake: { retry: 1 },
        fake2: { enabled: true, apiKeyEnv: 'FAKE2_KEY', format: 'wav', retry: 0 },
      },
    },
    handler: () => {
      throw new TtsError('auth', 'primary key rejected', { status: 401 })
    },
    extraAdapters: [
      {
        id: 'fake2',
        handler: (request) => ({ data: WAV, format: 'wav', voice: request.voice ?? 'v1' }),
      },
    ],
  })

  const outcome = await service.synthesize({ text: '回退测试' }, idleSignal())

  assert.equal(outcome.ok, true)
  assert.equal(outcome.provider, 'fake2')
  assert.ok(outcome.path.endsWith('.wav'))
  assert.equal(adapterCalls.fake.length, 1)
  assert.equal(adapterCalls.fake2.length, 1)
})

/* -------------------------------------------------------------------------- */
/* status / listVoices / testConnection                                       */
/* -------------------------------------------------------------------------- */

test('status reports provider, key, voice, output directory and cache stats', async (t) => {
  const { service } = await setup(t)

  const status = await service.status()
  assert.equal(status.provider, 'fake')
  assert.deepEqual([...status.fallback], [])
  assert.equal(status.platform, 'win32')
  assert.equal(status.outputDir, service.outputDirectoryForCard().dir)
  assert.equal(status.activeProfileId, null)
  assert.equal(status.activeVoice, '苏打')
  assert.deepEqual({ ...status.cache }, { enabled: true, files: 0, bytes: 0 })

  const row = status.providers.fake
  assert.ok(row, 'status is missing the fake provider row')
  assert.equal(row.configured, true)
  assert.equal(row.enabled, true)
  assert.equal(row.keyRequired, true)
  assert.equal(row.keyConfigured, true)
  assert.equal(row.keyType, 'pay-as-you-go')
  assert.equal(row.keyRef, 'FAKE_API_KEY')
  assert.equal(row.available, true)
  assert.equal(row.model, 'fake-model')
  assert.equal(row.voice, 'v1')
  assert.equal(row.baseURL, '')

  await service.synthesize({ text: '缓存计数' }, idleSignal())
  const after = await service.status()
  assert.ok(after.cache.files >= 1)
  assert.ok(after.cache.bytes >= WAV.length)
})

test('testConnection reports success and classifies auth failures', async (t) => {
  const healthy = await setup(t)
  const ok = await healthy.service.testConnection({ signal: idleSignal() })
  assert.equal(ok.ok, true)
  assert.equal(ok.provider, 'fake')
  assert.equal(ok.keyConfigured, true)
  assert.equal(ok.keyType, 'pay-as-you-go')
  assert.equal(typeof ok.latencyMs, 'number')
  assert.equal(ok.error, undefined)

  const broken = await setup(t, {
    handler: () => {
      throw new TtsError('auth', 'invalid key', { status: 401 })
    },
  })
  const failed = await broken.service.testConnection({ signal: idleSignal() })
  assert.equal(failed.ok, false)
  assert.equal(failed.provider, 'fake')
  assert.equal(failed.keyConfigured, true)
  assert.ok(failed.error)
  assert.equal(failed.error.kind, 'auth')
  assert.match(failed.error.message, /invalid key/)
})

test('testConnection tests only the selected provider, not the fallback chain', async (t) => {
  const fallback = await setup(t, {
    handler: () => {
      throw new TtsError('auth', 'selected provider rejected the key', { status: 401 })
    },
    extraAdapters: [{ id: 'backup' }],
    config: { fallback: ['backup'] },
  })
  const result = await fallback.service.testConnection({ signal: idleSignal() })
  assert.equal(result.ok, false)
  assert.equal(result.provider, 'fake')
  assert.equal(result.error.kind, 'auth')
  assert.equal(fallback.adapterCalls.backup.length, 0)
})

test('testConnection reports a missing key as auth instead of falling back', async (t) => {
  const missing = await setup(t, { env: { FAKE_API_KEY: undefined } })
  const result = await missing.service.testConnection({ signal: idleSignal() })
  assert.equal(result.ok, false)
  assert.equal(result.keyConfigured, false)
  assert.equal(result.error.kind, 'auth')
  assert.match(result.error.message, /FAKE_API_KEY/)
  assert.equal(missing.adapterCalls.fake.length, 0)
})

/* -------------------------------------------------------------------------- */
/* preview files                                                              */
/* -------------------------------------------------------------------------- */

test('preview writes under <stateDir>/preview and readPreview reads it back', async (t) => {
  const { service, tmpHome } = await setup(t)
  const previewDir = join(tmpHome, 'whale-tts', 'preview')

  const preview = await service.preview({ text: '预览测试', signal: idleSignal() })

  assert.equal(preview.format, 'wav')
  assert.match(preview.file, /^preview-.*\.wav$/)
  assert.equal(dirname(preview.path), previewDir)
  assert.equal(preview.bytes, WAV.length)
  assert.equal((await stat(preview.path)).size, WAV.length)

  const read = await service.readPreview(preview.file)
  assert.deepEqual([...read.data], [...WAV])
  assert.equal(read.mime, 'audio/wav')
  assert.deepEqual(await service.listPreviews(), [preview.file])

  await assert.rejects(
    service.readPreview('missing-preview.wav'),
    isTtsErrorKind('validation'),
  )
})

/* -------------------------------------------------------------------------- */
/* voice design                                                               */
/* -------------------------------------------------------------------------- */

test('designCandidates sends designModel and the configured style without a voice', async (t) => {
  const { service, adapterCalls, tmpHome } = await setup(t, {
    config: {
      designDescription: '温柔',
      designCandidateCount: 2,
      providers: { fake: { designModel: 'design-model', format: 'wav' } },
    },
  })

  const candidates = await service.designCandidates({ signal: idleSignal() })

  assert.equal(candidates.length, 2)
  assert.equal(adapterCalls.fake.length, 2)
  for (const candidate of candidates) {
    assert.equal(candidate.format, 'wav')
    assert.equal(candidate.bytes, WAV.length)
    assert.ok(candidate.file.endsWith('.wav'))
    const file = join(tmpHome, 'whale-tts', 'design', candidate.file)
    assert.equal((await stat(file)).size, WAV.length)
  }
  for (const call of adapterCalls.fake) {
    assert.equal(call.request.model, 'design-model')
    assert.equal(call.request.style, '温柔')
    assert.equal(call.request.voice, undefined)
    assert.equal(call.request.text, '你好，我是魈。')
    assert.equal(call.config.designModel, 'design-model')
  }

  const listed = (await service.listCandidates()).map((candidate) => candidate.id).sort()
  assert.deepEqual(listed, candidates.map((candidate) => candidate.id).sort())
})

test('designCandidates never falls back to another provider', async (t) => {
  const { service, adapterCalls } = await setup(t, {
    config: {
      designDescription: '温柔',
      designCandidateCount: 2,
      fallback: ['fake2'],
      providers: {
        fake: { designModel: 'design-model', format: 'wav', retry: 1 },
        fake2: { enabled: true, apiKeyEnv: 'FAKE2_KEY', format: 'wav', retry: 0 },
      },
    },
    handler: () => {
      throw new TtsError('auth', 'design model rejected', { status: 401 })
    },
    extraAdapters: [
      {
        id: 'fake2',
        handler: (request) => ({ data: WAV, format: 'wav', voice: request.voice ?? 'v1' }),
      },
    ],
  })

  await assert.rejects(
    service.designCandidates({ signal: idleSignal() }),
    (error) => {
      assert.ok(error instanceof TtsError)
      assert.match(error.message, /design model rejected/)
      return true
    },
  )
  // A fallback provider would have produced a candidate that ignores the
  // description; design requests must fail instead.
  assert.equal(adapterCalls.fake2.length, 0)
})

test('designCandidates validates description, capability and design model', async (t) => {
  const noDescription = await setup(t, { config: { designDescription: '' } })
  await assert.rejects(
    noDescription.service.designCandidates({ signal: idleSignal() }),
    (error) =>
      error instanceof TtsError &&
      error.kind === 'validation' &&
      /description is empty/.test(error.message),
  )

  const noCapability = await setup(t, {
    config: { designDescription: '温柔' },
    capabilities: { voiceDesign: false },
  })
  await assert.rejects(
    noCapability.service.designCandidates({ signal: idleSignal() }),
    (error) =>
      error instanceof TtsError &&
      error.kind === 'validation' &&
      /does not support voice design/.test(error.message),
  )

  const noModel = await setup(t, {
    config: {
      designDescription: '温柔',
      providers: { fake: { designModel: '' } },
    },
  })
  await assert.rejects(
    noModel.service.designCandidates({ signal: idleSignal() }),
    (error) =>
      error instanceof TtsError &&
      error.kind === 'config' &&
      /no designModel configured/.test(error.message),
  )
})

/* -------------------------------------------------------------------------- */
/* voice profiles                                                             */
/* -------------------------------------------------------------------------- */

test('voice profiles: save, activate, status, synthesis and delete fallback', async (t) => {
  const { service, adapterCalls } = await setup(t)

  const preset = await service.saveProfile({
    name: '我的音色',
    kind: 'preset',
    presetVoiceId: 'voice-x',
  })
  assert.equal(preset.kind, 'preset')
  assert.equal(preset.presetVoiceId, 'voice-x')

  const activation = await service.activateProfile(preset.id)
  assert.deepEqual({ ...activation }, { activeProfileId: preset.id })

  const status = await service.status()
  assert.equal(status.activeProfileId, preset.id)
  assert.equal(status.activeVoice, '我的音色')

  const catalog = await service.listVoices()
  assert.equal(catalog.activeProfileId, preset.id)
  assert.deepEqual(catalog.profiles.map((profile) => profile.id), [preset.id])

  const outcome = await service.synthesize({ text: '使用预设档案' }, idleSignal())
  assert.equal(outcome.ok, true)
  assert.equal(adapterCalls.fake.length, 1)
  assert.equal(adapterCalls.fake[0].request.voice, 'voice-x')
  assert.equal(adapterCalls.fake[0].request.model, 'fake-model')

  const deleted = await service.deleteProfile(preset.id)
  assert.equal(deleted.ok, true)
  assert.equal(deleted.activeProfileId, null)
  assert.deepEqual([...deleted.removedSamples], [])

  const after = await service.status()
  assert.equal(after.activeProfileId, null)
  assert.equal(after.activeVoice, '苏打')
  assert.deepEqual(await service.listProfiles(), [])
})

test('synthesize with an activated clone profile sends a data URL and the clone model', async (t) => {
  const { service, adapterCalls } = await setup(t)

  const sample = await service.uploadSample(SAMPLE_WAV, 'audio/wav', 'wav')
  assert.equal(sample.sampleMime, 'audio/wav')
  assert.equal(sample.sampleBytes, SAMPLE_WAV.length)

  const clone = await service.saveProfile({
    name: '克隆音色',
    kind: 'clone',
    sampleFile: sample.sampleFile,
    sampleBytes: sample.sampleBytes,
    sampleMime: sample.sampleMime,
  })
  await service.activateProfile(clone.id)

  const outcome = await service.synthesize({ text: '克隆合成' }, idleSignal())
  assert.equal(outcome.ok, true)
  assert.equal(adapterCalls.fake.length, 1)

  const request = adapterCalls.fake[0].request
  assert.equal(request.model, 'clone-model')
  assert.ok(request.voice.startsWith('data:audio/wav;base64,'))
  const decoded = Buffer.from(
    request.voice.slice('data:audio/wav;base64,'.length),
    'base64',
  )
  assert.deepEqual([...decoded], [...SAMPLE_WAV])
  assert.equal(outcome.voice, request.voice)
})

test('synthesize carries the active profile style instruction into the request', async (t) => {
  const { service, adapterCalls } = await setup(t, {
    config: { providers: { fake: { cloneModel: 'clone-model' } } },
  })
  const sample = await service.uploadSample(SAMPLE_WAV, 'audio/wav', 'wav')
  const clone = await service.saveProfile({
    name: '设计固化音色',
    kind: 'clone',
    sampleFile: sample.sampleFile,
    sampleBytes: sample.sampleBytes,
    sampleMime: sample.sampleMime,
    styleInstruction: '温柔、语速偏慢，带一点笑意',
  })
  await service.activateProfile(clone.id)

  await service.synthesize({ text: '设计感要保持' }, idleSignal())
  assert.equal(
    adapterCalls.fake[0].request.style,
    '温柔、语速偏慢，带一点笑意',
    'the design prompt stored on the profile must reach the provider as the user-message style',
  )

  // An explicit per-call style still wins over the stored one.
  await service.synthesize({ text: '临时改语气', style: '轻快一点' }, idleSignal())
  assert.equal(adapterCalls.fake[1].request.style, '轻快一点')
})

/* -------------------------------------------------------------------------- */
/* credential ownership                                                       */
/* -------------------------------------------------------------------------- */

test('keys written through the plugin are owned; shared credentials are not', async (t) => {
  const { service, credentials, tmpHome } = await setup(t)
  const shared = 'XIAOMI_TOKEN_PLAN_CN_API_KEY'
  const manual = 'MIMO_API_KEY'
  credentials.store.set(shared, 'tp-shared-secret')

  // A credential that only DSH owns cannot be cleared from the card.
  await assert.rejects(
    service.clearKey(shared),
    (error) =>
      error instanceof TtsError &&
      error.kind === 'validation' &&
      /不是由本插件写入/.test(error.message),
  )
  assert.equal(credentials.store.get(shared), 'tp-shared-secret')

  // Writing a key through the plugin records ownership.
  const info = await service.setKey(manual, 'sk-manual-secret')
  assert.equal(info.ref, manual)
  assert.equal(info.configured, true)
  const candidates = await service.credentialCandidates()
  assert.equal(candidates.find((row) => row.ref === manual)?.owned, true)
  assert.equal(candidates.find((row) => row.ref === shared)?.owned, false)

  // The owned key may be cleared, and clearing removes it from the record.
  await service.clearKey(manual)
  assert.equal(credentials.store.get(manual), undefined)
  const after = await service.credentialCandidates()
  assert.equal(after.find((row) => row.ref === manual)?.owned, false)

  // Ownership survives a restart (state file, not in-memory only).
  const owned = JSON.parse(await readFile(join(tmpHome, 'whale-tts', 'keys-owned.json'), 'utf8'))
  assert.deepEqual(owned.refs, [])
})

/* -------------------------------------------------------------------------- */
/* backup / restore                                                           */
/* -------------------------------------------------------------------------- */

test('backup export writes a secret-free document that import restores', async (t) => {
  const { service, credentials, tmpHome } = await setup(t)
  credentials.store.set('XIAOMI_TOKEN_PLAN_CN_API_KEY', TEST_KEY)
  const sample = await service.uploadSample(SAMPLE_WAV, 'audio/wav', 'wav')
  await service.saveProfile({
    name: '备份音色',
    kind: 'clone',
    sampleFile: sample.sampleFile,
    sampleBytes: sample.sampleBytes,
    sampleMime: sample.sampleMime,
    styleInstruction: '温柔、语速偏慢',
  })

  const exported = await service.exportBackup()
  assert.equal(exported.profiles, 1)
  assert.ok(exported.path.startsWith(join(tmpHome, 'whale-tts', 'backups')))

  const raw = await readFile(exported.path, 'utf8')
  const document = JSON.parse(raw)
  assert.equal(document.format, 'dsh-whale-tts-backup')
  assert.equal(document.version, 1)
  assert.equal(raw.includes(TEST_KEY), false)
  assert.deepEqual(document.keyRefs, [])

  const listed = await service.listBackups()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].file, exported.file)

  const target = await setup(t)
  const imported = await target.service.importBackup({
    mode: 'merge',
    base64: Buffer.from(raw, 'utf8').toString('base64'),
  })
  assert.equal(imported.importedProfiles, 1)
  assert.ok(imported.safetyBackup.bytes > 0)
  assert.match(imported.safetyBackup.path, /backups/)
  const profiles = await target.service.listProfiles()
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].name, '备份音色')
  assert.equal(profiles[0].styleInstruction, '温柔、语速偏慢')

  // Server-side path import appends another copy in merge mode.
  const second = await target.service.importBackup({ mode: 'merge', path: exported.path })
  assert.equal(second.importedProfiles, 1)
  assert.equal((await target.service.listProfiles()).length, 2)
})

test('backup import rejects bad documents and replace mode clears the library', async (t) => {
  const { service } = await setup(t)
  await service.saveProfile({ name: '旧音色', kind: 'preset', presetVoiceId: 'soda' })
  const exported = await service.exportBackup()

  await assert.rejects(
    service.importBackup({ mode: 'merge', base64: Buffer.from('not json').toString('base64') }),
    (error) => error instanceof TtsError && error.kind === 'validation',
  )
  await assert.rejects(
    service.importBackup({ mode: 'merge', base64: Buffer.from('{"format":"other"}').toString('base64') }),
    (error) => error instanceof TtsError && /not recognised/.test(error.message),
  )
  await assert.rejects(
    service.importBackup({ mode: 'merge', path: 'C:\\definitely\\missing\\backup.json' }),
    (error) => error instanceof TtsError && /not found/.test(error.message),
  )

  const replaced = await service.importBackup({ mode: 'replace', path: exported.path })
  assert.equal(replaced.mode, 'replace')
  const profiles = await service.listProfiles()
  assert.equal(profiles.length, 1)
  assert.equal(profiles[0].name, '旧音色')
})

test('a non-selectable built-in provider is rejected as the primary', async (t) => {
  const { service } = await setup(t, { extraAdapters: [{ id: 'sapi' }] })
  await assert.rejects(
    service.synthesize({ text: '测试', provider: 'sapi' }, idleSignal()),
    (error) =>
      error instanceof TtsError &&
      error.kind === 'config' &&
      /not available yet/.test(error.message),
  )
})
