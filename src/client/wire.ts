/**
 * Wire shapes of the host RPC payloads. Kept structural (and deliberately
 * loose) so a host-side field addition never breaks the browser half.
 */

/** One stored voice profile. */
export interface Profile {
  id: string
  name: string
  kind: 'preset' | 'clone' | 'design'
  description?: string
  tags?: string[]
  presetVoiceId?: string
  sampleFile?: string
  sampleBytes?: number
  sampleMime?: string
  designDescription?: string
  designCandidates?: string[]
  styleInstruction?: string
  createdAt: string
  updatedAt: string
}

/** One temporary design candidate. */
export interface Candidate {
  id: string
  file: string
  bytes: number
  format: 'wav' | 'mp3'
  createdAt: string
}

/** Non-secret credential description. */
export interface KeyInfo {
  ref: string
  configured: boolean
  source: 'environment' | 'credentials' | 'missing'
  keyType: string
  /** True when this plugin wrote the credential (only then may it be cleared). */
  owned?: boolean
}

/** Provider status row. */
export interface ProviderStatusRow {
  configured: boolean
  enabled: boolean
  keyRequired: boolean
  keyConfigured: boolean
  keyType?: string
  keyRef?: string
  available: boolean
  /** Whether the card may offer this provider as the primary one. */
  selectable?: boolean
  model?: string
  voice?: string
  baseURL?: string
  lastError?: string
}

/** Whole-plugin status. */
export interface TtsStatus {
  provider: string
  fallback: string[]
  providers: Record<string, ProviderStatusRow>
  activeProfileId: string | null
  activeVoice: string
  cache: { enabled: boolean; files: number; bytes: number }
  outputDir: string
  platform: string
}

/** Config snapshot (only the fields the card edits are typed). */
export interface ConfigSnapshot {
  provider: string
  fallback: string[]
  output: { dir: string; filename: string; format: 'auto' | 'wav' | 'mp3'; overwrite: boolean }
  cache: { enabled: boolean; dir: string; maxAgeDays: number }
  limits: { maxChars: number }
  readAloud: { auto: boolean; skipCode: boolean; segmentChars: number; rate: number }
  log: { text: boolean }
  activeProfileId: string
  studioMode: 'preset' | 'design' | 'clone'
  presetVoiceId: string
  customVoiceId: string
  designDescription: string
  designCandidateCount: number
  sampleText: string
  previewText: string
  apiKeyEnv: string
  keySource: 'reuse' | 'manual'
  baseURLOverride: string
  keyType: string
  [key: string]: unknown
}

/** Payload of the `status` endpoint. */
export interface StatusPayload {
  status: TtsStatus
  output: { dir: string; cacheDir: string; stateDir: string }
  keys: KeyInfo[]
  config: ConfigSnapshot
  revision?: number
  writable: boolean
  providers: string[]
}

/** Payload of the `config/get` endpoint. */
export interface ConfigPayload {
  config: ConfigSnapshot
  revision?: number
  writable: boolean
}

/** Result of `credentials/test`. */
export interface TestResult {
  ok: boolean
  provider: string
  keyConfigured: boolean
  keyType: string
  latencyMs: number
  error?: { kind: string; message: string }
}

/** Result of `preview`. */
export interface PreviewPayload {
  path: string
  file: string
  relativePath: string
  format: 'wav' | 'mp3'
  provider: string
  voice: string
  bytes: number
  elapsedMs: number
}

/** Result of `audio/read`. */
export interface AudioPayload {
  mime: string
  bytes: number
  base64: string
}

/** Read-aloud preferences returned by `read-aloud/config`. */
export interface ReadAloudConfigPayload {
  auto: boolean
  skipCode: boolean
  segmentChars: number
  rate: number
}

/** One prepared assistant message returned by `read-aloud/prepare`. */
export interface ReadAloudPreparePayload {
  messageId: string
  segments: string[]
  time: number
  seq: number
  final: boolean
  rate: number
}

/** Result of `samples/upload`. */
export interface SamplePayload {
  sampleFile: string
  sampleBytes: number
  sampleMime: string
}

/** A settings path operation. */
export type ConfigOp =
  | { op: 'set'; path: string[]; value: unknown }
  | { op: 'unset'; path: string[] }

/** Provider capability row returned by `providers/list`. */
export interface ProviderVoiceList {
  id: string
  capabilities: {
    speech: boolean
    singing: boolean
    formats: string[]
    voices: { id: string; label?: string; description?: string }[]
    requiresKey: boolean
    voiceDesign?: boolean
    voiceClone?: boolean
    platforms?: string[]
  }
  voices: { id: string; label?: string; description?: string }[]
}

/** One backup document on the host. */
export interface BackupFileInfo {
  path: string
  file: string
  bytes: number
  createdAt: string
  profiles?: number
  candidates?: number
}

/** Result of importing a backup document. */
export interface BackupImportResult {
  mode: 'merge' | 'replace'
  importedProfiles: number
  importedCandidates: number
  activeProfileId: string | null
  safetyBackup: BackupFileInfo
  warnings: string[]
}
