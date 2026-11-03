/**
 * Read-aloud text preparation.
 *
 * Pure functions shared by the RPC layer and the unit tests: the host resolves
 * one finalized assistant message from the session log, turns Markdown source
 * into speech-friendly plain text, and splits it into provider-sized segments.
 */

/** One resolved assistant message ready for speech. */
export interface ReadAloudMessage {
  /** Plain text of the message's text blocks. */
  readonly text: string
  /** Session event time (epoch ms); the client uses it for auto-read gating. */
  readonly time: number
  /** Session sequence of the message event. */
  readonly seq: number
  /** True when this is the closing text message of its turn. */
  readonly final: boolean
}

/** Narrow view of the session events this module reads. */
interface EventLike {
  readonly type?: unknown
  readonly seq?: unknown
  readonly time?: unknown
  readonly data?: unknown
}

/** Text blocks of an assistant message, joined with blank lines. */
function messageText(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const candidate = block as { type?: unknown; text?: unknown }
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue
    const text = candidate.text.trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}

/** Message id carried by an assistant/message event. */
function eventMessageId(event: EventLike): string | undefined {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  const message = (data as { message?: unknown }).message
  if (message === null || typeof message !== 'object') return undefined
  const id = (message as { id?: unknown }).id
  return typeof id === 'string' ? id : undefined
}

/**
 * Find one assistant message by durable id.
 *
 * `final` is true only when a later `turn/end` exists without another text
 * assistant message in between: auto-read uses it to skip intermediate
 * "let me check…" messages that precede tool calls.
 */
export function readAssistantMessage(
  events: readonly unknown[],
  messageId: string,
): ReadAloudMessage | null {
  const index = events.findIndex(
    (event) => isEvent(event) && event.type === 'assistant/message' && eventMessageId(event) === messageId,
  )
  if (index < 0) return null
  const event = events[index] as EventLike
  const data = event.data as { message?: unknown } | undefined
  const text = messageText(data?.message).trim()
  if (text === '') return null

  let final = false
  for (let next = index + 1; next < events.length; next += 1) {
    const later = events[next]
    if (!isEvent(later)) continue
    if (later.type === 'turn/end') {
      final = true
      break
    }
    if (later.type === 'assistant/message' && messageText((later.data as { message?: unknown } | undefined)?.message) !== '') {
      final = false
      break
    }
  }

  return {
    text,
    time: typeof event.time === 'number' ? event.time : 0,
    seq: typeof event.seq === 'number' ? event.seq : 0,
    final,
  }
}

function isEvent(value: unknown): value is EventLike {
  return value !== null && typeof value === 'object'
}

/**
 * Turn Markdown source into speech-friendly plain text.
 *
 * Code is the only content that is ever dropped wholesale (`skipCode`): a
 * fenced block read character by character is unusable. Everything else keeps
 * its words and loses only the markup.
 */
export function sanitizeForSpeech(
  text: string,
  options: { readonly skipCode?: boolean } = {},
): string {
  const skipCode = options.skipCode !== false
  let output = text

  if (skipCode) {
    output = output
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
  } else {
    output = output.replace(/```[a-zA-Z0-9_-]*\n?/g, ' ').replace(/`([^`\n]*)`/g, '$1')
  }

  output = output
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s)）]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/\|/g, '，')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return output
}

/** Sentence units used by {@link splitForSpeech}. */
function sentenceUnits(text: string): string[] {
  const matches = text.match(/[^。！？!?；;\n]+[。！？!?；;]?/g)
  if (matches === null) return []
  const units: string[] = []
  for (const match of matches) {
    const unit = match.trim()
    if (unit !== '') units.push(unit)
  }
  return units
}

/** Split text into provider-sized segments at sentence boundaries. */
export function splitForSpeech(text: string, maxChars: number): string[] {
  const limit = Math.max(1, Math.floor(maxChars))
  const segments: string[] = []
  let current = ''

  const flush = (): void => {
    const value = current.trim()
    if (value !== '') segments.push(value)
    current = ''
  }

  for (const unit of sentenceUnits(text)) {
    if (unit.length > limit) {
      flush()
      for (let offset = 0; offset < unit.length; offset += limit) {
        const piece = unit.slice(offset, offset + limit).trim()
        if (piece !== '') segments.push(piece)
      }
      continue
    }
    if (current === '') {
      current = unit
    } else if (current.length + unit.length <= limit) {
      current += unit
    } else {
      flush()
      current = unit
    }
  }
  flush()
  return segments
}

/** Resolve, sanitize and split one message in a single call. */
export function prepareSpeechSegments(
  text: string,
  options: { readonly skipCode?: boolean; readonly maxChars: number },
): string[] {
  const clean = sanitizeForSpeech(text, { skipCode: options.skipCode })
  return splitForSpeech(clean, options.maxChars)
}
