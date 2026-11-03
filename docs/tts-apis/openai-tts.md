# OpenAI TTS API

> 最后核对：2026-11-03
> 官方文档：
> - API：https://platform.openai.com/docs/api-reference/audio/createSpeech
> - 指南：https://platform.openai.com/docs/guides/text-to-speech

## 1. 能力概览

- **模型**：`gpt-4o-mini-tts`（支持自然语言 `instructions` 控制语气）、
  `gpt-4o-mini-tts-2025-12-15`、`tts-1`、`tts-1-hd`。
- **音色**：`alloy`、`ash`、`ballad`、`coral`、`echo`、`fable`、`nova`、
  `onyx`、`sage`、`shimmer`、`verse`（具体以控制台/文档为准）。
- **文本上限**：4,096 字符。
- **输出**：`mp3`（默认）、`opus`、`aac`、`flac`、`wav`、`pcm`；可直接返回
  二进制音频，也可用 SSE 流式返回 base64 片段。
- **没有声音克隆**：只能选预置音色；`gpt-4o-mini-tts` 可用
  `instructions` 描述风格（"speak softly" 等）。

## 2. 端点与认证

```http
POST https://api.openai.com/v1/audio/speech
Authorization: Bearer $OPENAI_API_KEY
Content-Type: application/json
```

Azure OpenAI 的路径/认证不同（`api-key` header + deployment 名），不要直接混用。

## 3. 请求

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | `gpt-4o-mini-tts` / `tts-1` / `tts-1-hd` |
| `input` | string | 是 | 待合成文本，≤ 4096 字符 |
| `voice` | string | 是 | 预置音色名 |
| `instructions` | string | 否 | 自然语言风格指令，仅 `gpt-4o-mini-tts` 系列 |
| `response_format` | string | 否 | `mp3`（默认）/`opus`/`aac`/`flac`/`wav`/`pcm` |
| `speed` | number | 否 | 0.25–4.0，默认 1 |
| `stream_format` | string | 否 | `audio`（默认）或 `sse` |

```bash
curl https://api.openai.com/v1/audio/speech \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini-tts",
    "input": "你好，我是育木的小鲸鱼。",
    "voice": "coral",
    "instructions": "用温柔、自然的语气朗读",
    "response_format": "mp3",
    "speed": 1.0
  }' --output speech.mp3
```

## 4. 响应

- 默认 `stream_format=audio`：响应体就是音频二进制，`Content-Type` 为
  `audio/mpeg`（或对应格式）。
- `stream_format=sse`：SSE 事件流，常见事件：
  - `speech.audio.delta`：`delta` 为 base64 音频片段；
  - `speech.audio.done`：包含 `usage`（字符/token 用量）。
- 错误：`400` 参数/文本超限、`401` Key、`429` 限流、`5xx` 服务端。

## 5. 接入 dsh-whale-tts 的建议

- 插件已经有 `openai-compatible` 适配器（`POST {baseURL}/audio/speech`，
  Bearer，原始字节），当前只是默认禁用；把 provider 打开、填
  `baseURL`/`model`/`voice` 即可。
- 输出格式默认 mp3；插件的 `output.format` 可以保持 `auto` 或强制 `mp3`。
- 如果要使用 `instructions`，需要在 adapter 里新增一个 provider 配置字段
  （当前 adapter 只发 `model/input/voice/response_format/speed` 之类）。
- 文本上限 4096，插件分段远小于它，无需额外处理。
