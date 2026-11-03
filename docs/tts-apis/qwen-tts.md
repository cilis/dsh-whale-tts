# Qwen TTS API（阿里云百炼 / DashScope）

> 最后核对：2026-11-03
> 官方文档：
> - 非实时 API：https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api
> - 音色列表：https://www.alibabacloud.com/help/zh/model-studio/qwen-tts-voice-list
> - 实时 WebSocket：https://www.alibabacloud.com/help/en/model-studio/interactive-process-of-qwen-tts-realtime-synthesis
> - 声音复刻（voice enrollment）：https://www.alibabacloud.com/help/en/model-studio/qwen-voice-enrollment

## 1. 能力概览

- **模型**：`qwen3-tts-flash`（非实时 HTTP）、`qwen3-tts-flash-realtime`
  （WebSocket 实时）；声音复刻使用 `qwen-voice-enrollment` 建模，再用
  `qwen3-tts-vc-realtime` 合成。
- **文本长度**：单次最多 **600 字符**（`qwen3-tts-flash`）。
- **音色**：官方列表几十个，参数名是英文名，例如 `Cherry`（芊悦）、
  `Serena`（苏瑶）、`Ethan`（晨煦）、`Chelsie`（千雪）、`Momo`（茉兔）、
  `Moon`（月白）、`Jennifer`（詹妮弗）；另有上海话、北京话、四川话、粤语等。
- **多语种**：中文（普通话及各地方言）、英语、法语、德语、俄语、意大利语、
  西班牙语、葡萄牙语、日语、韩语等，可按 `language_type` 指定。
- **输出**：非实时返回 24 小时有效的 WAV URL；流式返回 base64 音频片段，
  最后一帧再给完整 URL。播放示例使用 24 kHz、单声道。

## 2. 地域与认证

- 北京：`https://dashscope.aliyuncs.com/api/v1`
- 新加坡：`https://dashscope-intl.aliyuncs.com/api/v1`（或 QwenCloud 的
  `https://ap-southeast-1.maas.qwencloudapi.com/api/v1`）
- 请求头：

```http
Authorization: Bearer $DASHSCOPE_API_KEY
Content-Type: application/json
```

> 北京和新加坡的 API Key 不通用；国际站还需要 workspace。具体以控制台为准。

## 3. 非实时合成

```http
POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `model` | string | 是 | `qwen3-tts-flash` |
| `input.text` | string | 是 | 待合成文本，最多 600 字符 |
| `input.voice` | string | 是 | 音色参数名，如 `Cherry` |
| `input.language_type` | string | 否 | `Auto`（默认）、`Chinese`、`English`、`German`、`Italian`、`Portuguese`、`Spanish`、`Japanese`、`Korean`、`French`、`Russian` |

```bash
curl -X POST 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' \
  -H "Authorization: Bearer $DASHSCOPE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "qwen3-tts-flash",
    "input": {
      "text": "你好，我是育木的小鲸鱼。",
      "voice": "Cherry",
      "language_type": "Chinese"
    }
  }'
```

响应（节选）：

```json
{
  "status_code": 200,
  "request_id": "5c63c65c-...",
  "output": {
    "finish_reason": "stop",
    "audio": {
      "url": "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/....wav?...",
      "id": "audio_...",
      "expires_at": 1766113409
    }
  },
  "usage": { "characters": 13, "input_tokens": 0, "output_tokens": 0 }
}
```

要点：

- `output.audio.url` 有效 **24 小时**，要立即下载或转存。
- 非流式响应里的 `output.audio.data` 是空串，必须走 URL。
- 失败时看 `status_code`、`code`、`message`；`request_id` 用于排查。

## 4. 流式输出（SSE）

在同一个 URL 上增加请求头：

```http
X-DashScope-SSE: enable
```

返回 SSE：中间帧的 `output.audio.data` 是 base64 音频片段，最后一帧
`finish_reason=stop` 且带 `output.audio.url`。适合首字节延迟敏感的场景。

## 5. 实时 WebSocket（可选）

```
wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
```

协议是 event JSON（session 配置、文本/音频事件），和 OpenAI Realtime 类似但
字段不完全相同。只做「整段文本朗读」时不需要它。

## 6. 声音复刻 / 声音设计

- 云端：`qwen-voice-enrollment` 用 5 秒以上参考音频注册音色，再配
  `qwen3-tts-vc-realtime`（WebSocket）合成。不是单纯一次性 HTTP 调用。
- 开源的 Qwen3-TTS 模型另有 `generate_voice_clone()` 和
  `generate_voice_design()`，但需要自己部署推理，不属于本 API。

## 7. 限制与错误

- 单次 600 字符、24 小时 URL 有效期是主要限制。
- 常见错误：`400` 参数/文本超长、`401` Key 或地域错误、`429` 限流、
  `500` 服务端错误。
- 价格/并发按模型和地域不同，见控制台计费页。

## 8. 接入 dsh-whale-tts 的建议

- 新 provider id：`qwen-tts`；Key 引用：`DASHSCOPE_API_KEY`。
- `synthesize()`：POST 上述 URL → 取 `output.audio.url` → `fetch` 下载 →
  返回 `{ data, format: 'wav', voice: input.voice }`。
- 文本上限 600，插件侧已有分段逻辑，可直接复用（600 作为 provider 上限）。
- `config` 需要的字段：`model`、`voice`、`language_type`、`baseURL`（地域）。
- 如果要支持声音复刻，需要额外接入 enrollment + realtime WebSocket，工程量
  明显大于普通 HTTP adapter，建议后续单独做。
