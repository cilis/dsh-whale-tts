# Qwen TTS API（阿里云百炼 / DashScope）

> 最后核对：2026-11-09（官方 API 页更新于 2026-10-27）
> 官方文档：
> - 非实时 API：https://www.alibabacloud.com/help/en/model-studio/qwen-tts-api
> - 实时 WebSocket：https://www.alibabacloud.com/help/en/model-studio/interactive-process-of-qwen-tts-realtime-synthesis
> - 音色列表：https://www.alibabacloud.com/help/zh/model-studio/qwen-tts-voice-list
> - 声音复刻：https://www.alibabacloud.com/help/en/model-studio/qwen-voice-enrollment

## 0. 这次复核的结论

- 非实时接口仍是 `qwen3-tts-flash`，端点、600 字符上限、24 小时 URL 都没变。
- 官方推荐的新 SDK 调用是 DashScope 2.0 的 `client.audio.tts.http.synthesize()` /
  `client.audio.tts.http.stream()`；旧版 SDK 的 multimodal 接口仍可用。
- 实时模型仍为 `qwen3-tts-flash-realtime`（快照 `qwen3-tts-flash-realtime-2025-11-27`），
  适合低延迟；只做整段朗读时不需要它。
- 音色列表在 2026-10 仍有更新；音色名以官方列表为准，不要硬编码「全部音色」。
- 开源 Qwen3-TTS（0.6B/1.7B）是另一条路线，不属于本文的云端 API；见
  [本地 TTS 调研](../local-tts-research.md)。

## 1. 能力概览

- **模型**：`qwen3-tts-flash`（非实时 HTTP）、`qwen3-tts-flash-realtime`
  （WebSocket 实时）；声音复刻通过 `qwen-voice-enrollment` 注册，再用
  `qwen3-tts-vc-realtime` 合成。
- **文本长度**：单次最多 **600 字符**（`qwen3-tts-flash`）。
- **音色**：官方列表较大且会更新；常见参数名如 `Cherry`（芊悦）、`Serena`（苏瑶）、
  `Ethan`（晨煦）、`Chelsie`（千雪）、`Momo`（茉兔）、`Moon`（月白）、
  `Vivian`、`Maia`、`Kai`、`Nofish` 等；另有上海话、北京话、四川话、粤语等方言。
- **多语种**：中文（普通话及各地方言）、英语、法语、德语、俄语、意大利语、
  西班牙语、葡萄牙语、日语、韩语等；用 `language_type` 指定单语种通常比 `Auto` 更稳。
- **输出**：非实时返回 **24 小时有效的 WAV URL**；SSE 流式中间帧返回 base64 音频片段，
  最后一帧给完整 URL。播放示例按 24 kHz、单声道处理。

## 2. 地域与认证

- 北京：`https://dashscope.aliyuncs.com/api/v1`
- 新加坡：`https://dashscope-intl.aliyuncs.com/api/v1`
  （官方示例里也有 `ap-southeast-1` 的 workspace 配置）
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

### 3.1 Python SDK 2.0

```python
import os
import dashscope

client = dashscope.Client(
    api_key=os.environ["DASHSCOPE_API_KEY"],
    region="ap-southeast-1",   # 北京可省略/按官方示例调整
)

result = client.audio.tts.http.synthesize(
    "你好，我是育木的小鲸鱼。",
    model="qwen3-tts-flash",
    voice="Cherry",
    language_type="Chinese",
)
print(result.audio_url, result.audio_id, result.expires_at)
```

流式版本用 `client.audio.tts.http.stream(...)`；`chunk.audio` 是已解码的字节，
`chunk.is_final` 为真时带完整 URL。

### 3.2 响应

```json
{
  "status_code": 200,
  "request_id": "5c63c65c-...",
  "code": "",
  "message": "",
  "output": {
    "finish_reason": "stop",
    "audio": {
      "data": "",
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
- `usage.characters` 是计费字符数；`input_tokens` / `output_tokens` 目前为 0。

## 4. 流式输出（SSE）

在同一个 URL 上增加请求头：

```http
X-DashScope-SSE: enable
```

返回 SSE：中间帧的 `output.audio.data` 是 base64 音频片段，最后一帧
`finish_reason=stop` 且带 `output.audio.url`。适合首字节延迟敏感的场景。

## 5. 实时 WebSocket

```
wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime
```

- 必须用 `wss://`；模型通过 URL 查询参数指定。
- `Authorization: Bearer <key>` 在 WebSocket 握手阶段校验。
- 协议是 event JSON（session 配置、文本/音频事件），和 OpenAI Realtime 类似但字段不同。
- 只做「整段文本朗读」时不需要它；实时对话/低延迟首包才值得接。

## 6. 声音复刻 / 声音设计

- 云端：`qwen-voice-enrollment` 用参考音频注册音色，再配
  `qwen3-tts-vc-realtime`（WebSocket）合成。不是一次性 HTTP 调用。
- 开源 Qwen3-TTS 模型另有 `generate_voice_clone()` / `generate_voice_design()`，
  但需要自己部署推理，不属于本 API。
- 复刻/设计的授权、配额和参考音频要求以控制台为准。

## 7. 限制与错误

- 单次 600 字符、24 小时 URL 有效期是主要限制。
- 常见错误：`400` 参数/文本超长、`401` Key 或地域错误、`429` 限流、
  `500` 服务端错误。
- 国际站缺少 workspace、北京 Key 用在 Singapore 端点，都会表现为认证失败。
- URL 过期后需要重新合成，不要缓存 URL 当作长期文件地址。

## 8. 接入 dsh-whale-tts 的建议

- provider id：`qwen`（或兼容旧命名 `qwen-tts`）；Key 引用：`DASHSCOPE_API_KEY`。
- `synthesize()`：POST 上述 URL → 校验 `status_code` → 取 `output.audio.url` →
  `fetch` 下载 → 返回 `{ data, format: 'wav', voice: input.voice }`。
- 文本上限 600；插件侧已有分段逻辑，可把 600 作为 provider 上限。
- `config` 需要的字段：`model`、`voice`、`language_type`、`baseURL`（地域/workspace）。
- 失败映射：
  - `400` → validation；
  - `401/403` → auth；
  - `429` → rate-limit；
  - `5xx` / 下载 URL 失败 → provider/network。
- 不要把 `request_id` 或完整文本写进公开日志；可以记录 provider、耗时、字符数。
- 声音复刻需要 enrollment + realtime WebSocket，建议作为独立里程碑，不和普通 HTTP
  adapter 混在一起。
