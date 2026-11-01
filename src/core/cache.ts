/**
 * Synthesis cache: content-addressed files under `cache.dir`, with lazy age
 * cleanup. Keys come from {@link cacheKey} in `text.ts`.
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AudioFormat } from '../types.js'

/** Cache options. */
export interface CacheOptions {
  readonly enabled: boolean
  readonly dir: string
  readonly maxAgeDays: number
}

/** Cache statistics. */
export interface CacheStats {
  readonly files: number
  readonly bytes: number
}

/** One cache hit. */
export interface CacheHit {
  readonly data: Uint8Array
  readonly format: AudioFormat
}

const KEY_PATTERN = /^[a-f0-9]{64}\.(wav|mp3)$/

/** A content-addressed synthesis cache. */
export class SynthesisCache {
  private readonly options: CacheOptions

  constructor(options: CacheOptions) {
    this.options = options
  }

  /** Whether caching is active. */
  get enabled(): boolean {
    return this.options.enabled
  }

  /** Directory holding cache files. */
  get dir(): string {
    return this.options.dir
  }

  private fileFor(key: string, format: AudioFormat): string {
    return join(this.options.dir, `${key}.${format}`)
  }

  /** Read a cached payload, if present. */
  async get(key: string, format: AudioFormat): Promise<CacheHit | undefined> {
    if (!this.options.enabled) return undefined
    try {
      const data = await readFile(this.fileFor(key, format))
      return { data, format }
    } catch {
      return undefined
    }
  }

  /** Store a payload; failures are swallowed (caching is best-effort). */
  async put(key: string, format: AudioFormat, data: Uint8Array): Promise<void> {
    if (!this.options.enabled) return
    try {
      await mkdir(this.options.dir, { recursive: true })
      const target = this.fileFor(key, format)
      const temporary = `${target}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(temporary, data)
      const { rename } = await import('node:fs/promises')
      await rename(temporary, target)
    } catch {
      // Best effort: a failed cache write must not fail the synthesis.
    }
  }

  /** Remove cache files older than `maxAgeDays`. Returns the number removed. */
  async cleanup(now: Date = new Date()): Promise<number> {
    if (!this.options.enabled) return 0
    const cutoff = now.getTime() - this.options.maxAgeDays * 24 * 60 * 60 * 1000
    let removed = 0
    let entries: string[]
    try {
      entries = await readdir(this.options.dir)
    } catch {
      return 0
    }
    for (const entry of entries) {
      const match = KEY_PATTERN.exec(entry)
      if (match === null) continue
      const target = join(this.options.dir, entry)
      try {
        const info = await stat(target)
        if (info.mtimeMs < cutoff) {
          await rm(target, { force: true })
          removed += 1
        }
      } catch {
        // Ignore files that vanish concurrently.
      }
    }
    return removed
  }

  /** Count files and bytes currently cached. */
  async stats(): Promise<CacheStats> {
    let files = 0
    let bytes = 0
    let entries: string[]
    try {
      entries = await readdir(this.options.dir)
    } catch {
      return { files: 0, bytes: 0 }
    }
    for (const entry of entries) {
      if (!KEY_PATTERN.test(entry)) continue
      try {
        const info = await stat(join(this.options.dir, entry))
        files += 1
        bytes += info.size
      } catch {
        // Ignore.
      }
    }
    return { files, bytes }
  }
}
