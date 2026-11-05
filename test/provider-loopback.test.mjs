/**
 * Loopback integration test: real Node `fetch` against a local HTTP server.
 *
 * The adapter unit tests use a fake `fetch`; this file proves the same code
 * works through the real HTTP stack (URL joining, headers, JSON bodies,
 * response parsing and audio-file writes) without touching a provider.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { TtsService } from '../lib/core/service.js'
import { minimaxAdapter } from '../lib/providers/minimax.js'
import { siliconflowAdapter } from '../lib/providers/siliconflow.js'

const MP3 = Uint8Array.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
const KEY = 'sk-loopback-test-key'

const logger = { info() {}, warn() {}, error() {}, debug() {} }

function config(provider, baseURL, voice) {
  return {
    provider,
    fallback: [],
    providers: {
      [provider]: {
        enabled: true,
        baseURL,
        apiKeyEnv: provider === 'siliconflow' ? 'SILICONFLOW_API_KEY' : 'MINIMAX_API_KEY',
        model: provider === 'siliconflow' ? 'FunAudioLLM/CosyVoice2-0.5B' : 'speech-2.8-turbo',
        designModel: '',
        cloneModel: '',
        voice,
        format: 'mp3',
        timeoutMs: 5_000,
        retry: 0,
        style: '',
        headers: {},
        voiceName: '',
        scriptPath: '',
        rate: 0,
      },
    },
    output: { dir: '${TMP}/out', filename: 'loop-{rand}', format: 'auto', overwrite: false },
    cache: { enabled: false, dir: '', maxAgeDays: 30 },
    limits: { maxChars: 200 },
    readAloud: { auto: false, skipCode: true, segmentChars: 600, rate: 1 },
    log: { text: false },
    activeProfileId: '',
    studioMode: 'preset',
    presetVoiceId: voice,
    customVoiceId: '',
    designDescription: '',
    designCandidateCount: 2,
    sampleText: '',
    previewText: '',
    apiKeyEnv: '',
    keySource: 'reuse',
    baseURLOverride: '',
    keyType: 'auto',
  }
}

function credentials() {
  return {
    async resolve() {
      return { value: KEY, source: 'credentials' }
    },
    async describe() {
      return { configured: true, source: 'credentials', writable: true }
    },
    async set() {},
    async unset() {},
  }
}

async function makeService(t, provider, baseURL, voice, adapter) {
  const home = await mkdtemp(join(tmpdir(), 'whale-loopback-'))
  t.after(async () => {
    await rm(home, { recursive: true, force: true })
  })
  const service = new TtsService({
    config: config(provider, baseURL, voice),
    logger,
    env: {},
    home,
    tmp: home,
    platform: 'win32',
    fetch: globalThis.fetch,
    credentials: credentials(),
    adapters: new Map([[adapter.id, adapter]]),
    stateDir: join(home, 'whale-tts'),
  })
  t.after(() => service.dispose())
  await service.init()
  return { service, home }
}

test('loopback: siliconflow and minimax work through real fetch', async (t) => {
  const requests = []
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ url: request.url, headers: request.headers, body })
      if (request.url === '/v1/audio/speech') {
        response.writeHead(200, { 'content-type': 'audio/mpeg' })
        response.end(Buffer.from(MP3))
        return
      }
      if (request.url === '/v1/t2a_v2') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            data: { audio: Buffer.from(MP3).toString('hex'), status: 2 },
            base_resp: { status_code: 0, status_msg: 'success' },
          }),
        )
        return
      }
      response.writeHead(404)
      response.end('not found')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const baseURL = `http://127.0.0.1:${server.address().port}/v1`

  const sf = await makeService(
    t,
    'siliconflow',
    baseURL,
    'FunAudioLLM/CosyVoice2-0.5B:alex',
    siliconflowAdapter,
  )
  const sfOutcome = await sf.service.synthesize({ text: 'siliconflow loopback' }, new AbortController().signal)
  assert.equal(sfOutcome.provider, 'siliconflow')
  assert.equal(sfOutcome.format, 'mp3')
  assert.deepEqual([...await readFile(sfOutcome.path)], [...MP3])
  assert.equal(sfOutcome.bytes, MP3.length)

  const mm = await makeService(
    t,
    'minimax',
    baseURL,
    'male-qn-jingying',
    minimaxAdapter,
  )
  const mmOutcome = await mm.service.synthesize({ text: 'minimax loopback' }, new AbortController().signal)
  assert.equal(mmOutcome.provider, 'minimax')
  assert.equal(mmOutcome.format, 'mp3')
  assert.deepEqual([...await readFile(mmOutcome.path)], [...MP3])

  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, '/v1/audio/speech')
  assert.equal(requests[0].headers.authorization, `Bearer ${KEY}`)
  assert.equal(JSON.parse(requests[0].body).input, 'siliconflow loopback')
  assert.equal(requests[1].url, '/v1/t2a_v2')
  assert.equal(requests[1].headers.authorization, `Bearer ${KEY}`)
  assert.equal(JSON.parse(requests[1].body).text, 'minimax loopback')
})
