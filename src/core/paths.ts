/**
 * Path templates and directory resolution.
 *
 * Supported template variables: `${DSH_HOME}`, `${HOME}`, `${TMP}`, `${TEMP}`,
 * `${USERPROFILE}`. An expanded directory path must be absolute; a relative
 * path is a configuration error (loud at first use, not silently cwd-relative).
 */
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { TtsError } from '../types.js'

/** Environment used for template expansion; injectable for tests. */
export interface TemplateEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly home?: string
  readonly tmp?: string
}

/** The DSH home directory (`DSH_HOME` or `~/.dsh`). */
export function dshHome(environment: TemplateEnvironment): string {
  const configured = environment.env['DSH_HOME']
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  return join(environment.home ?? homedir(), '.dsh')
}

/** Expand `${VAR}` references in a path template. */
export function expandTemplate(template: string, environment: TemplateEnvironment): string {
  if (typeof template !== 'string') {
    throw new TtsError('config', 'path template must be a string')
  }
  const variables: Record<string, string> = {
    DSH_HOME: dshHome(environment),
    HOME: environment.home ?? homedir(),
    USERPROFILE: environment.env['USERPROFILE'] ?? environment.home ?? homedir(),
    TMP: environment.tmp ?? tmpdir(),
    TEMP: environment.env['TEMP'] ?? environment.tmp ?? tmpdir(),
  }
  const expanded = template.replace(/\$\{([A-Za-z0-9_]+)\}/g, (match, name: string) => {
    const value = variables[name]
    return value === undefined ? match : value
  })
  if (expanded !== template && /\$\{[A-Za-z0-9_]+\}/.test(expanded)) {
    throw new TtsError('config', `unknown path template variable in "${template}"`)
  }
  return expanded
}

/**
 * Expand and require an absolute directory path.
 *
 * @param template - configured path, possibly containing template variables.
 * @param environment - environment used for expansion.
 * @param label - field name used in the error message.
 */
export function resolveDirectory(
  template: string,
  environment: TemplateEnvironment,
  label = 'path',
): string {
  const trimmed = template.trim()
  if (trimmed === '') {
    throw new TtsError('config', `${label} must not be empty`)
  }
  const expanded = expandTemplate(trimmed, environment)
  if (!isAbsolute(expanded)) {
    throw new TtsError(
      'config',
      `${label} must expand to an absolute path (got "${expanded}"); use \${DSH_HOME} or an absolute path`,
    )
  }
  return resolve(expanded)
}

/** Create a directory (recursively) and return it. */
export async function ensureDirectory(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true })
  return directory
}

/** The plugin state directory (`<DSH_HOME>/whale-tts`) that holds voices and samples. */
export function stateDirectory(environment: TemplateEnvironment): string {
  return join(dshHome(environment), 'whale-tts')
}

/** Join a POSIX-style relative path so consumers on every platform can use it. */
export function toPosixRelative(from: string, target: string): string {
  const relative = target.startsWith(from)
    ? target.slice(from.length).replace(/^[\\/]+/, '')
    : target
  return relative.split(/[\\/]+/).join('/')
}
