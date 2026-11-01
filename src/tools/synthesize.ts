/**
 * `tts_synthesize`: text → local audio file.
 *
 * The tool returns one canonical JSON value. The model-visible text is produced
 * only by `render`; `presentCall` / `presentResult` are pure UI projections.
 */
import { defineLocalTool, type JsonSchemaNode } from './definition.js'
import type { TtsService } from '../core/service.js'
import type { SynthesisOutcome } from '../types.js'

/** Model-visible arguments. */
interface SynthesizeArgs extends Record<string, unknown> {
  text: string
  provider?: string
  voice?: string
  format?: 'wav' | 'mp3'
  style?: string
  filename?: string
}

const PARAMETERS: JsonSchemaNode = {
  type: 'object',
  properties: {
    text: {
      type: 'string',
      description: '要合成的文本（已清洗的口语文本；上限见 limits.maxChars）。',
    },
    provider: {
      type: 'string',
      description: '临时覆盖默认 provider id；目前仅 mimo 可用（离线 sapi 只作回退），一般不需要。',
    },
    voice: {
      type: 'string',
      description: '临时覆盖音色 id（预置音色时使用）；一般用设置卡里的音色档案。',
    },
    format: {
      type: 'string',
      enum: ['wav', 'mp3'],
      description: '临时覆盖输出格式；provider 不支持时回退其默认格式。',
    },
    style: {
      type: 'string',
      description: '自然语言风格指令（如「温柔一点」），仅部分 provider 支持。',
    },
    filename: {
      type: 'string',
      description: '不含扩展名的文件名模板；支持 {timestamp} 与 {rand}。',
    },
  },
  required: ['text'],
}

/** Canonical result schema. */
const OUTCOME_SCHEMA: JsonSchemaNode = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    path: { type: 'string', description: 'Absolute path of the audio file' },
    relativePath: {
      type: 'string',
      description: 'Path relative to output.dir, POSIX separators',
    },
    file: { type: 'string', description: 'File name only' },
    format: { type: 'string', enum: ['wav', 'mp3'] },
    provider: { type: 'string' },
    voice: { type: 'string' },
    cached: { type: 'boolean', description: 'True when the cached file was reused' },
    bytes: { type: 'integer' },
    elapsedMs: { type: 'integer' },
  },
  required: [
    'ok',
    'path',
    'relativePath',
    'file',
    'format',
    'provider',
    'voice',
    'cached',
    'bytes',
    'elapsedMs',
  ],
}

/** Build the `tts_synthesize` tool over a service instance. */
export function createSynthesizeTool(service: TtsService) {
  return defineLocalTool<SynthesizeArgs>({
    name: 'tts_synthesize',
    description:
      '把文本合成为本地音频文件（语音）。voice/profile/provider 默认取当前设置，只传 text 即可。' +
      '返回 path / relativePath / file 三个路径字段与格式、时长信息；插件本身不播放、不发送，' +
      '拿到文件后交给对应的投递工具。相同内容与参数会命中缓存（cached=true）。' +
      ' Synthesize text into a local audio file with the configured TTS voice.',
    parameters: PARAMETERS,
    outputSchema: OUTCOME_SCHEMA,
    render: (_args, rawValue) => {
      const value = rawValue as unknown as SynthesisOutcome
      const cached = value.cached ? '，缓存命中' : ''
      return [
        {
          type: 'text',
          text:
            `已生成语音文件 ${value.path}` +
            `（${value.provider} / ${value.voice}，${value.format}，` +
            `${Math.round(value.bytes / 1024)} KB，${value.elapsedMs}ms${cached}）。`,
        },
      ]
    },
    timeoutMs: 180_000,
    presentCall: (args) => ({
      card: 'generic',
      title: 'tts_synthesize',
      kind: 'other',
      rawInput: {
        chars: [...(args.text ?? '')].length,
        provider: args.provider,
        voice: args.voice,
        format: args.format,
      },
    }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.isError ? 'tts_synthesize failed' : 'tts_synthesize',
      content: result.content,
    }),
    async execute(args, exec) {
      await service.init()
      const outcome = await service.synthesize(
        {
          text: args.text,
          provider: args.provider,
          voice: args.voice,
          format: args.format,
          style: args.style,
          filename: args.filename,
        },
        exec.signal,
      )
      return { ...outcome }
    },
  })
}
