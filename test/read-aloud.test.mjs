/**
 * Read-aloud text preparation tests.
 *
 * Runs against the compiled output (`npm run build:host` first).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  prepareSpeechSegments,
  readAssistantMessage,
  sanitizeForSpeech,
  splitForSpeech,
} from '../lib/core/read-aloud.js'

function assistantEvent(id, text, seq = 1) {
  return {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text }],
      },
    },
  }
}

test('readAssistantMessage extracts text, time and seq', () => {
  const events = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    assistantEvent('m1', '第一段。\n\n第二段。', 2),
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } },
  ]
  const message = readAssistantMessage(events, 'm1')
  assert.ok(message)
  assert.equal(message.text, '第一段。\n\n第二段。')
  assert.equal(message.time, 1_700_000_000_002)
  assert.equal(message.seq, 2)
  assert.equal(message.final, true)
})

test('readAssistantMessage marks intermediate messages as not final', () => {
  const events = [
    assistantEvent('m1', '我先查一下。', 1),
    assistantEvent('m2', '结果是这样。', 2),
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1 } },
  ]
  assert.equal(readAssistantMessage(events, 'm1').final, false)
  assert.equal(readAssistantMessage(events, 'm2').final, true)
})

test('readAssistantMessage ignores reasoning-only messages', () => {
  const events = [
    {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: { message: { id: 'm1', content: [{ type: 'reasoning', text: '思考' }] } },
    },
  ]
  assert.equal(readAssistantMessage(events, 'm1'), null)
})

test('readAssistantMessage returns null for unknown ids', () => {
  assert.equal(readAssistantMessage([], 'missing'), null)
})

test('sanitizeForSpeech skips fenced code but keeps inline code readable', () => {
  const input = '说明\n```ts\nconst x = 1\n```\n行内 `code` 和 [链接](https://example.com) 结束。'
  const output = sanitizeForSpeech(input)
  assert.equal(output.includes('const x'), false)
  assert.equal(output.includes('code'), true)
  assert.equal(output.includes('链接'), true)
  assert.equal(output.includes('https://'), false)
})

test('inline code is normalized into pronounceable words', () => {
  const output = sanitizeForSpeech(
    '新增 `src/core/read-aloud.ts`、`read-aloud/prepare` 和 `ctx.sessions`。',
  )
  assert.equal(output.includes('src core read aloud ts'), true)
  assert.equal(output.includes('read aloud prepare'), true)
  assert.equal(output.includes('ctx sessions'), true)
  assert.equal(output.includes('/'), false)
  assert.equal(output.includes('_'), false)
})

test('sanitizeForSpeech keeps inline code text when skipCode is false', () => {
  const output = sanitizeForSpeech('看看 `foo` 和\n```\nbar\n```', { skipCode: false })
  assert.equal(output.includes('foo'), true)
  assert.equal(output.includes('bar'), true)
})

test('sanitizeForSpeech removes markdown noise and tables', () => {
  const output = sanitizeForSpeech(
    '## 标题\n> 引用\n- 列表\n1. 有序\n| A | B |\n|---|---|\n| 1 | 2 |\n结尾',
  )
  assert.equal(output.includes('##'), false)
  assert.equal(output.includes('|'), false)
  assert.equal(output.includes('--'), false)
  assert.equal(output.includes('标题'), true)
  assert.equal(output.includes('结尾'), true)
})

test('splitForSpeech respects the limit and never returns empty segments', () => {
  const text = '第一句。第二句比较长一些！第三句？'
  const segments = splitForSpeech(text, 6)
  assert.ok(segments.length >= 3)
  assert.ok(segments.every((segment) => segment.length > 0 && segment.length <= 6))
  assert.equal(segments.join(''), text.replace(/\s+/g, ''))
})

test('splitForSpeech hard-splits a single oversized sentence', () => {
  const text = '一'.repeat(25)
  const segments = splitForSpeech(text, 10)
  assert.equal(segments.length, 3)
  assert.ok(segments.every((segment) => segment.length <= 10))
})

test('prepareSpeechSegments sanitizes then splits', () => {
  const segments = prepareSpeechSegments('说\n```\ncode\n```\n结束。', {
    skipCode: true,
    maxChars: 100,
  })
  assert.equal(segments.length, 1)
  assert.equal(segments[0].includes('code'), false)
  assert.equal(segments[0].includes('结束'), true)
})
