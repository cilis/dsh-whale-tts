/**
 * Which credential references this plugin wrote itself.
 *
 * The plugin reuses DSH credentials, so a reference can exist without the
 * plugin ever touching it. Only refs recorded here may be deleted from the
 * settings card; anything else belongs to DSH and is left alone. The record is a
 * small JSON file under the plugin state directory, written atomically and
 * serialized through one promise chain.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LoggerLike } from '../types.js'

/** State file version; bumps mean a migration is needed. */
const STATE_VERSION = 1

/** Construction options for {@link OwnedKeyStore}. */
export interface OwnedKeyStoreOptions {
  /** Absolute path of the JSON state file. */
  readonly file: string
  readonly logger?: LoggerLike
}

interface OwnedKeyState {
  readonly version: number
  readonly refs: readonly string[]
}

/** Persistent record of credential refs written by this plugin. */
export class OwnedKeyStore {
  private readonly file: string
  private readonly logger?: LoggerLike
  private refs: Set<string> | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: OwnedKeyStoreOptions) {
    this.file = options.file
    this.logger = options.logger
  }

  /** Load (once) and return the recorded refs. */
  async load(): Promise<ReadonlySet<string>> {
    if (this.refs !== undefined) return this.refs
    this.refs = await this.read()
    return this.refs
  }

  /** Whether `ref` was written by this plugin. */
  async has(ref: string): Promise<boolean> {
    const name = (ref ?? '').trim()
    if (name === '') return false
    return (await this.load()).has(name)
  }

  /** Recorded refs, sorted (for status/card projections). */
  async list(): Promise<string[]> {
    return [...(await this.load())].sort()
  }

  /** Record that this plugin wrote `ref`. */
  async add(ref: string): Promise<void> {
    const name = (ref ?? '').trim()
    if (name === '') return
    await this.mutate((refs) => refs.add(name))
  }

  /** Drop `ref` from the record (after it was deleted). */
  async remove(ref: string): Promise<void> {
    const name = (ref ?? '').trim()
    if (name === '') return
    await this.mutate((refs) => refs.delete(name))
  }

  /** Read the state file, tolerating a missing or corrupt one. */
  private async read(): Promise<Set<string>> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<OwnedKeyState> | null
      const refs = Array.isArray(parsed?.refs)
        ? parsed.refs.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
        : []
      return new Set(refs.map((entry) => entry.trim()))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.logger?.warn?.(
          '[whale-tts] cannot read owned-key state %s: %s',
          this.file,
          (error as Error).message,
        )
      }
      return new Set()
    }
  }

  /** Serialize one mutation and persist the result. */
  private async mutate(change: (refs: Set<string>) => void): Promise<void> {
    const next = this.queue.then(async () => {
      const refs = new Set(await this.load())
      change(refs)
      await this.write(refs)
      this.refs = refs
    })
    this.queue = next.catch(() => undefined)
    return next
  }

  /** Atomically write the state file. */
  private async write(refs: Set<string>): Promise<void> {
    const payload: OwnedKeyState = {
      version: STATE_VERSION,
      refs: [...refs].sort(),
    }
    const target = this.file
    const temporary = `${target}.tmp-${randomBytes(4).toString('hex')}`
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
