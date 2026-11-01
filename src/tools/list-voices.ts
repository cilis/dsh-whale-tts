/**
 * `tts_list_voices`: static provider capabilities, built-in voices and the
 * stored voice profiles. Never performs a network call.
 */
import { defineLocalTool, type JsonSchemaNode } from './definition.js'
import type { TtsService } from '../core/service.js'
import type { VoiceCatalog } from '../types.js'

/** This tool takes no arguments. */
type ListVoicesArgs = Record<string, never>

/** Shared nested schemas (raw JSON Schema subset). */
const VOICE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    label: { type: 'string' },
    description: { type: 'string' },
  },
  required: ['id'],
}

const CAPABILITIES_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    speech: { type: 'boolean' },
    singing: { type: 'boolean' },
    formats: { type: 'array', items: { type: 'string', enum: ['wav', 'mp3'] } },
    voices: { type: 'array', items: VOICE_SCHEMA },
    requiresKey: { type: 'boolean' },
    voiceDesign: { type: 'boolean' },
    voiceClone: { type: 'boolean' },
    platforms: { type: 'array', items: { type: 'string' } },
  },
  required: ['speech', 'singing', 'formats', 'voices', 'requiresKey'],
}

const PROFILE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    kind: { type: 'string', enum: ['preset', 'clone', 'design'] },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    presetVoiceId: { type: 'string' },
    sampleFile: { type: 'string' },
    sampleBytes: { type: 'integer' },
    sampleMime: { type: 'string' },
    designDescription: { type: 'string' },
    designCandidates: { type: 'array', items: { type: 'string' } },
    styleInstruction: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  required: ['id', 'name', 'kind', 'createdAt', 'updatedAt'],
}

const CATALOG_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    providers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          capabilities: CAPABILITIES_SCHEMA,
          voices: { type: 'array', items: VOICE_SCHEMA },
        },
        required: ['id', 'capabilities', 'voices'],
      },
    },
    profiles: { type: 'array', items: PROFILE_SCHEMA },
    activeProfileId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['providers', 'profiles', 'activeProfileId'],
}

/** Build the `tts_list_voices` tool over a service instance. */
export function createListVoicesTool(service: TtsService) {
  return defineLocalTool<ListVoicesArgs>({
    name: 'tts_list_voices',
    description:
      '列出可用的语音合成 provider、各自能力与内置音色，以及当前保存的音色档案（preset/clone/design）。' +
      '不联网、不读取密钥。 List TTS providers, capabilities, built-in voices and stored voice profiles.',
    parameters: { type: 'object', properties: {} },
    outputSchema: CATALOG_SCHEMA,
    render: (_args, rawValue) => {
      const value = rawValue as unknown as VoiceCatalog
      const providerLines = value.providers.map(
        (provider) =>
          `${provider.id}: ${provider.voices.length} voices, ` +
          `formats=${provider.capabilities.formats.join('/')}` +
          `${provider.capabilities.requiresKey ? ', requires key' : ', no key'}` +
          `${provider.capabilities.voiceDesign === true ? ', voice design' : ''}` +
          `${provider.capabilities.voiceClone === true ? ', voice clone' : ''}`,
      )
      const profileLines = value.profiles.map(
        (profile) =>
          `${profile.name} [${profile.kind}]` +
          `${profile.id === value.activeProfileId ? ' (active)' : ''}`,
      )
      const lines = [
        `Providers (${value.providers.length}): ${providerLines.join(' | ')}`,
        `Voice profiles (${value.profiles.length})` +
          (profileLines.length === 0 ? ': none' : `: ${profileLines.join(' | ')}`),
      ]
      return [{ type: 'text', text: lines.join('\n') }]
    },
    timeoutMs: 15_000,
    presentCall: () => ({ card: 'generic', title: 'tts_list_voices', kind: 'search' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'tts_list_voices',
      content: result.content,
    }),
    async execute() {
      await service.init()
      // Canonical JSON value: a JSON round trip makes every array mutable, as
      // the declared output schema requires.
      return JSON.parse(JSON.stringify(await service.listVoices())) as VoiceCatalog
    },
  })
}
