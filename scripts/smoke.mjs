#!/usr/bin/env node
/**
 * Offline synthetic smoke test for the dsh-whale-tts host pipeline.
 *
 * What this proves (no DSH runtime, no network, no real provider):
 *   - `TtsService.init()` creates the state directory and loads the voice store;
 *   - `synthesize()` runs the whole prepare -> chain -> write -> cache pipeline
 *     and produces a real RIFF/WAVE file on disk;
 *   - repeated synthesis hits the content-addressed cache;
 *   - `status()`, `preview()` and `listVoices()` work against the same service.
 *
 * Why a fake adapter: real SAPI synthesis requires the parent process to be able
 * to spawn PowerShell (`powershell.exe -File scripts/sapi.ps1`). This sandbox
 * refuses to spawn child processes (EPERM), so a true SAPI run cannot be
 * exercised here. The fake adapter returns a valid 8000 Hz / 16-bit / mono WAV
 * (44-byte header + 0.1 s of silence) so every check past the provider boundary
 * is real. Real-machine verification steps live in README / docs/validation.md.
 *
 * Usage: node scripts/smoke.mjs
 * Exit code 0 = all checks passed, 1 = a check failed.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TtsService } from '../lib/core/service.js'

const KEY_REF = 'FAKE_TTS_API_KEY'

/** Build a 44-byte-header PCM WAV: 8000 Hz, 16-bit, mono, 0.1 s of silence. */
function makeWav() {
  const sampleRate = 8000
  const channels = 1
  const bitsPerSample = 16
  const blockAlign = (channels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const samples = Math.round(sampleRate * 0.1)
  const dataBytes = samples * blockAlign
  const riffSize = 36 + dataBytes

  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(riffSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  // PCM payload stays zeroed: 0.1 s of silence.
  return new Uint8Array(buffer)
}

/** Fake provider: records calls and returns a valid WAV. */
function createFakeAdapter() {
  const calls = []
  return {
    calls,
    id: 'fake',
    capabilities: {
      speech: true,
      singing: false,
      formats: ['wav'],
      voices: [{ id: 'fake-voice', label: 'Fake Voice' }],
      requiresKey: true,
    },
    async synthesize(request) {
      calls.push({ chars: [...request.text].length, voice: request.voice, format: request.format })
      if (request.signal?.aborted) throw new Error('request aborted')
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        data: makeWav(),
        format: 'wav',
        voice: request.voice ?? 'fake-voice',
      }
    },
  }
}

/** Credential bridge that resolves nothing, forcing the environment fallback. */
function createFakeCredentials() {
  return {
    async resolve() {
      return undefined
    },
    async describe() {
      return { configured: false, writable: true }
    },
    async set() {},
    async unset() {},
  }
}

/** Plain (already unwrapped) config matching `ConfigSnapshot` / `Config`. */
function createConfig(outputDir) {
  return {
    provider: 'fake',
    fallback: [],
    providers: {
      fake: {
        enabled: true,
        apiKeyEnv: KEY_REF,
        format: 'wav',
        voice: 'fake-voice',
        timeoutMs: 5000,
        retry: 0,
      },
    },
    output: {
      dir: outputDir,
      filename: 'tts-{timestamp}-{rand}',
      format: 'auto',
      overwrite: true,
    },
    cache: { enabled: true, dir: '', maxAgeDays: 30 },
    limits: { maxChars: 2000 },
    log: { text: false },
    activeProfileId: '',
    studioMode: 'preset',
    presetVoiceId: '苏打',
    customVoiceId: '',
    designDescription: '',
    designCandidateCount: 3,
    sampleText: '你好，我是魈。',
    previewText: '你好，我是魈。',
    apiKeyEnv: '',
    keySource: 'reuse',
    baseURLOverride: '',
    keyType: 'auto',
  }
}

const logger = {
  info: (message, ...args) => console.log(`  [log:info] ${message}`, ...args),
  warn: (message, ...args) => console.warn(`  [log:warn] ${message}`, ...args),
  error: (message, ...args) => console.error(`  [log:error] ${message}`, ...args),
  debug: () => {},
}

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
  }
}

/** Read the first 12 magic bytes of a file. */
async function magicOf(path) {
  const bytes = await readFile(path)
  return {
    bytes,
    riff: bytes.subarray(0, 4).toString('ascii'),
    wave: bytes.subarray(8, 12).toString('ascii'),
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-whale-tts-smoke-'))
const stateDir = join(root, 'state')
const outputDir = join(root, 'output')
const signal = new AbortController().signal

console.log(`[smoke] temp root: ${root}`)
console.log('[smoke] phase 1: init')

try {
  const adapter = createFakeAdapter()
  const service = new TtsService({
    config: createConfig(outputDir),
    logger,
    env: { FAKE_TTS_API_KEY: 'sk-smoke-test-only', DSH_HOME: root },
    home: root,
    tmp: root,
    platform: 'win32',
    credentials: createFakeCredentials(),
    adapters: new Map([[adapter.id, adapter]]),
    stateDir,
  })
  await service.init()
  check('init() created the state directory', (await stat(stateDir)).isDirectory())

  console.log('[smoke] phase 2: synthesize("你好，世界。")')
  const first = await service.synthesize({ text: '你好，世界。' }, signal)
  check('synthesize() returned ok', first.ok === true)
  check('adapter was called exactly once', adapter.calls.length === 1, `calls=${adapter.calls.length}`)
  check('output file exists', (await stat(first.path)).isFile(), first.path)
  check('output format is wav', first.format === 'wav', first.format)
  check('file size is a full WAV (> 44 bytes)', first.bytes > 44, `${first.bytes} bytes`)
  check('file ends with .wav', first.file.endsWith('.wav'), first.file)
  const firstMagic = await magicOf(first.path)
  check('RIFF magic at offset 0', firstMagic.riff === 'RIFF', firstMagic.riff)
  check('WAVE magic at offset 8', firstMagic.wave === 'WAVE', firstMagic.wave)
  check('on-disk size matches reported bytes', firstMagic.bytes.length === first.bytes,
    `${firstMagic.bytes.length} vs ${first.bytes}`)
  check('relativePath has no drive letter or backslash',
    !/[\\:]/.test(first.relativePath), first.relativePath)
  check('relativePath is POSIX-relative', first.relativePath === first.file, first.relativePath)

  console.log('[smoke] phase 3: synthesize(same text) must hit the cache')
  const second = await service.synthesize({ text: '你好，世界。' }, signal)
  check('second call reports cached: true', second.cached === true, `cached=${second.cached}`)
  check('adapter was not called again', adapter.calls.length === 1, `calls=${adapter.calls.length}`)
  check('cached bytes equal first result', second.bytes === first.bytes,
    `${second.bytes} vs ${first.bytes}`)
  check('cached relativePath has no drive letter or backslash',
    !/[\\:]/.test(second.relativePath), second.relativePath)
  check('cached file exists', (await stat(second.path)).isFile(), second.path)

  console.log('[smoke] phase 4: status()')
  const status = await service.status()
  console.log(`  provider      = ${status.provider}`)
  console.log(`  outputDir     = ${status.outputDir}`)
  console.log(`  cache         = enabled=${status.cache.enabled} files=${status.cache.files} bytes=${status.cache.bytes}`)
  console.log(`  activeVoice   = ${status.activeVoice}`)
  console.log(`  platform      = ${status.platform}`)
  console.log(`  providers     = ${Object.keys(status.providers).join(', ')}`)
  check('status().provider is the configured provider', status.provider === 'fake', status.provider)
  check('status().outputDir is the configured directory', status.outputDir === outputDir, status.outputDir)
  check('status().cache.files >= 1', status.cache.files >= 1, `${status.cache.files}`)
  const fakeStatus = status.providers.fake
  check('fake provider reports key configured from env', fakeStatus?.keyConfigured === true)
  check('fake provider reports key type from env', fakeStatus?.keyType === 'pay-as-you-go',
    fakeStatus?.keyType)

  console.log('[smoke] phase 5: preview()')
  const preview = await service.preview({ signal })
  check('preview file exists', (await stat(preview.path)).isFile(), preview.path)
  check('preview format is wav', preview.format === 'wav', preview.format)
  check('preview path lives under <stateDir>/preview',
    preview.path.startsWith(join(stateDir, 'preview')), preview.path)
  const previewMagic = await magicOf(preview.path)
  check('preview RIFF/WAVE magic is valid',
    previewMagic.riff === 'RIFF' && previewMagic.wave === 'WAVE')

  console.log('[smoke] phase 6: listVoices()')
  const catalog = await service.listVoices()
  console.log(`  providers = ${catalog.providers.map((p) => p.id).join(', ')}`)
  console.log(`  profiles  = ${catalog.profiles.length}`)
  console.log(`  active    = ${catalog.activeProfileId ?? 'null'}`)
  check('catalog lists the injected adapter', catalog.providers.some((p) => p.id === 'fake'))
  check('catalog exposes adapter voices',
    catalog.providers[0]?.voices.some((voice) => voice.id === 'fake-voice') === true)
  check('catalog has no stored profiles yet', catalog.profiles.length === 0,
    `${catalog.profiles.length}`)

  console.log('[smoke] phase 7: dispose()')
  service.dispose()
  check('dispose() does not throw', true)
} catch (error) {
  failures += 1
  console.error('[smoke] unexpected error:', error)
} finally {
  console.log(`[smoke] cleaning up ${root}`)
  await rm(root, { recursive: true, force: true })
}

if (failures > 0) {
  console.error(`\n[smoke] FAILED: ${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\n[smoke] OK: all checks passed')
}
