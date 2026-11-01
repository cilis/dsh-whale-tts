/**
 * `tts_status`: configuration and credential status for troubleshooting.
 * Never returns secret values or synthesised text.
 */
import { defineLocalTool, type JsonSchemaNode } from './definition.js'
import type { TtsService } from '../core/service.js'
import type { TtsStatus } from '../types.js'

/** This tool takes no arguments. */
type StatusArgs = Record<string, never>

const STATUS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string' },
    fallback: { type: 'array', items: { type: 'string' } },
    providers: {
      type: 'object',
      additionalProperties: true,
      description: 'Per-provider status rows keyed by provider id',
    },
    activeProfileId: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    activeVoice: { type: 'string' },
    cache: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        files: { type: 'integer' },
        bytes: { type: 'integer' },
      },
      required: ['enabled', 'files', 'bytes'],
    },
    outputDir: { type: 'string' },
    platform: { type: 'string' },
  },
  required: [
    'provider',
    'fallback',
    'providers',
    'activeProfileId',
    'activeVoice',
    'cache',
    'outputDir',
    'platform',
  ],
}

/** Build the `tts_status` tool over a service instance. */
export function createStatusTool(service: TtsService) {
  return defineLocalTool<StatusArgs>({
    name: 'tts_status',
    description:
      '查看语音合成插件的运行状态：默认 provider、回退链、各 provider 的密钥是否配置（不返回值）、' +
      '当前激活音色、缓存与输出目录。排障先用它。 Show TTS provider, credential, cache and output status (no secrets).',
    parameters: { type: 'object', properties: {} },
    outputSchema: STATUS_SCHEMA,
    render: (_args, rawValue) => {
      const value = rawValue as unknown as TtsStatus
      const rows = Object.entries(value.providers ?? {}).map(([id, row]) => {
        const state = row.available ? 'ready' : 'unavailable'
        const key = row.keyRequired
          ? `key ${row.keyConfigured ? 'configured' : 'missing'}${
              row.keyType === undefined ? '' : ` (${row.keyType})`
            }`
          : 'no key needed'
        return `${id}: ${state}, ${key}${row.lastError === undefined ? '' : `, ${row.lastError}`}`
      })
      return [
        {
          type: 'text',
          text: [
            `provider=${value.provider} fallback=[${value.fallback.join(', ')}]`,
            `active voice=${value.activeVoice}${
              value.activeProfileId === null ? '' : ` (${value.activeProfileId})`
            }`,
            `output dir=${value.outputDir}`,
            `cache=${value.cache.enabled ? 'on' : 'off'} (${value.cache.files} files, ${value.cache.bytes} bytes)`,
            ...rows,
          ].join('\n'),
        },
      ]
    },
    timeoutMs: 30_000,
    presentCall: () => ({ card: 'generic', title: 'tts_status', kind: 'other' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: 'tts_status',
      content: result.content,
    }),
    async execute() {
      await service.init()
      const status = await service.status()
      return {
        provider: status.provider,
        fallback: [...status.fallback],
        providers: JSON.parse(JSON.stringify(status.providers)) as Record<string, never>,
        activeProfileId: status.activeProfileId,
        activeVoice: status.activeVoice,
        cache: {
          enabled: status.cache.enabled,
          files: status.cache.files,
          bytes: status.cache.bytes,
        },
        outputDir: status.outputDir,
        platform: status.platform,
      }
    },
  })
}
