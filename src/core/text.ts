/**
 * Text preparation and cache keys. Pure functions: no I/O, no clock.
 */
import { createHash } from 'node:crypto'
import { TtsError } from '../types.js'

/** Remove control characters (keeping newlines/tabs) and collapse whitespace. */
export function normalizeText(raw: string): string {
  if (typeof raw !== 'string') {
    throw new TtsError('validation', 'text must be a string')
  }
  const withoutControls = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  const withoutZeroWidth = withoutControls.replace(/[\u200B-\u200D\uFEFF]/g, '')
  return withoutZeroWidth
    .replace(/[ \t\u00A0]+/g, ' ')
    .replace(/ *\r?\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Throw when the text cannot be synthesised as configured. */
export function assertText(text: string, maxChars: number): string {
  const normalized = normalizeText(text)
  if (normalized === '') {
    throw new TtsError('validation', 'text is empty after normalisation')
  }
  const length = [...normalized].length
  if (length > maxChars) {
    throw new TtsError(
      'validation',
      `text is too long: ${length} characters, limit is ${maxChars} (raise limits.maxChars or shorten the text)`,
      { detail: { length, maxChars } },
    )
  }
  return normalized
}

/** Count characters the way the limit is enforced (Unicode code points). */
export function charLength(text: string): number {
  return [...text].length
}

/** Trim a style instruction; empty means "no style". */
export function normalizeStyle(style: string | undefined): string | undefined {
  if (typeof style !== 'string') return undefined
  const trimmed = style.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Inputs that fully determine the audio bytes. */
export interface CacheKeyInput {
  readonly provider: string
  readonly model: string
  readonly voice: string
  readonly format: string
  readonly style?: string
  readonly text: string
}

/** Stable SHA-256 cache key over the synthesis inputs. */
export function cacheKey(input: CacheKeyInput): string {
  const payload = JSON.stringify([
    input.provider,
    input.model,
    input.voice,
    input.format,
    input.style ?? '',
    input.text,
  ])
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/** ASCII-safe slug used for derived voice/profile file names. */
export function slugify(input: string, fallback = 'voice'): string {
  const ascii = input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return ascii === '' ? fallback : ascii
}
