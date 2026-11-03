/**
 * Read-aloud RPC endpoints.
 *
 * Runs against the compiled output (`npm run build:host` first).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRpcHandler, REMOTE_CHANNEL } from '../lib/remote/service.js'

const events = [
  {
    type: 'assistant/message',
    seq: 2,
    time: 1_700_000_000_002,
    data: {
      message: {
        id: 'message-1',
        content: [{ type: 'text', text: '你好，这是回答。\n```ts\nconst x = 1\n```' }],
      },
    },
  },
  { type: 'turn/end', seq: 3, time: 1_700_000_000_003, data: { turn: 1 } },
]

function makeHandler(overrides = {}) {
  const service = {
    snapshot: () => ({
      readAloud: { auto: false, skipCode: true, segmentChars: 600, rate: 1 },
      limits: { maxChars: 2000 },
    }),
    ...overrides.service,
  }
  return createRpcHandler({
    service,
    sessions: {
      get: (sessionId) =>
        sessionId === 'session-1' ? { snapshotEvents: () => events } : undefined,
    },
    ...overrides,
  })
}

test('read-aloud/prepare returns cleaned segments', async () => {
  const handler = makeHandler()
  const result = await handler(
    'read-aloud/prepare',
    { sessionId: 'session-1', messageId: 'message-1' },
    new AbortController().signal,
  )
  assert.equal(result.ok, true)
  assert.equal(result.value.messageId, 'message-1')
  assert.equal(result.value.final, true)
  assert.equal(result.value.rate, 1)
  assert.equal(result.value.segments.length, 1)
  assert.equal(result.value.segments[0].includes('const x'), false)
  assert.equal(result.value.segments[0].includes('回答'), true)
})

test('read-aloud/prepare returns null for unknown session or message', async () => {
  const handler = makeHandler()
  const signal = new AbortController().signal
  assert.equal(
    (await handler('read-aloud/prepare', { sessionId: 'nope', messageId: 'message-1' }, signal))
      .value,
    null,
  )
  assert.equal(
    (await handler('read-aloud/prepare', { sessionId: 'session-1', messageId: 'nope' }, signal))
      .value,
    null,
  )
})

test('read-aloud/prepare validates required fields', async () => {
  const handler = makeHandler()
  const result = await handler(
    'read-aloud/prepare',
    { sessionId: 'session-1' },
    new AbortController().signal,
  )
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'tts/bad-request')
})

test('read-aloud/config returns the effective preferences', async () => {
  const handler = makeHandler()
  const result = await handler('read-aloud/config', {}, new AbortController().signal)
  assert.deepEqual(result.value, {
    auto: false,
    skipCode: true,
    segmentChars: 600,
    rate: 1,
  })
})

test('the plugin channel name is stable', () => {
  assert.equal(REMOTE_CHANNEL, '/dsh-whale-tts')
})
