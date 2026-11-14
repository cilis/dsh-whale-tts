# DeepSeek 官方 TTS API

> 最后核对：2026-11-14  
> 来源：`E:\DeepSeek Harness\DeepSeek API\doc\工具 API\tts.md`  
> 本插件实现：`deepseek` provider，整段 HTTP、WAV；PCM/WebSocket 暂未接入。

## 1. 能力概览

| 项目 | 内容 |
| --- | --- |
| 整段合成 | `POST https://api.deepseek.com/v1/tools/tts` |
| 流式合成 | `wss://api.deepseek.com/v1/tools/tts` |
| 鉴权 | `Authorization: Bearer <DEEPSEEK_API_KEY>` |
| 音色 | `stella`（海星，默认女声）、`tide`（暗潮，男声） |
| 语种 | 普通话、粤语、英语、日语、韩语、马来语、阿拉伯语、印尼语、泰语、越南语 |
| 语种参数 | 无；按文本自动识别 |
| 输出 | 整段 HTTP：`wav`（默认）或 `pcm`；WS：`pcm`（默认）或 `opus` |
| 文本上限 | 10,000 计费字符、请求体 64 KiB |
| 音频上限 | 单次最多 30 分钟 |
| 语速 | 不支持调节 |
| 并发 | 每账号最多 50 个进行中的请求 |

PCM 格式为 24 kHz、16 位、单声道；`opus` 是裸 Opus 包，不能直接存成 Ogg。

## 2. 整段 HTTP

```http
POST https://api.deepseek.com/v1/tools/tts
Authorization: Bearer <DEEPSEEK_API_KEY>
Content-Type: application/json

{
  "text": "你好，我是 DeepSeek。",
  "voice_id": "stella",
  "format": "wav",
  "filter_markdown": true
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是 | 不能为空；最多 10,000 计费字符 |
| `voice_id` | 否 | `stella`（默认）或 `tide` |
| `format` | 否 | `wav`（默认）或 `pcm` |
| `filter_markdown` | 否 | 朗读前是否去掉 Markdown，默认 `true` |

响应是**流式音频**，不是 JSON 包装：

- `wav` → `Content-Type: audio/wav`；
- `pcm` → 24 kHz/16-bit/mono 原始 PCM。

音频边合成边返回；如果已经开始返回后失败，连接会中途断开，**提前结束的响应必须视为失败**，不能把半截文件当成功。

### 错误码

| 状态码 | 原因 |
| --- | --- |
| `400` | 没有可朗读文本，或文本未通过内容审核（`Content Exists Risk`） |
| `401/403` | API Key 无效/无权限 |
| `429` | 账号并发超限 |
| `503` | 服务繁忙，可重试 |
| `504` | 合成超时，可重试 |

## 3. WebSocket 流式（暂未接入插件）

```text
wss://api.deepseek.com/v1/tools/tts
```

可选查询参数：

- `voice_id`
- `format`：`pcm`（默认）或 `opus`
- `filter_markdown`

鉴权两种方式：

```http
Authorization: Bearer <API Key>
```

或子协议：

```http
Sec-WebSocket-Protocol: tts, bearer.<API Key>
```

消息流程：

1. 发送 JSON 文本：`{"event":"text","text":"..."}`；
2. 最后发送：`{"event":"finish_text"}`；
3. 音频以二进制消息返回；
4. 服务端以文本消息结束：`{"event":"finish","code":"success"|"...","message":"..."}`。

错误码包括 `invalid_input`、`content_filter`、`input_timeout`、`service_error`。

限制：

- 60 秒内没有收到文字，会话结束；
- 单次会话最长 30 分钟；
- 单次最多 10,000 计费字符、64 KiB；
- 服务端每 25 秒发一次 ping。

当前 `deepseek` adapter 只做 HTTP 整段 WAV，所以不走 WebSocket。

## 4. 计费

| 计费单位 | 刊例价 | 限时折扣价 |
| --- | --- | --- |
| 每 10,000 字符 | 3 元 | 1.5 元 |

汉字算 2 个字符；英文字母、数字、空格等算 1 个。以官方控制台为准。

## 5. 插件实现

provider id：`deepseek`

```yaml
provider: deepseek
providers:
  deepseek:
    enabled: true
    baseURL: https://api.deepseek.com
    apiKeyEnv: DEEPSEEK_API_KEY
    voice: stella
    format: wav
    filterMarkdown: true
    timeoutMs: 120000
```

请求映射：

| 插件字段 | DeepSeek |
| --- | --- |
| `text` | `text` |
| `voice` | `voice_id` |
| `format` | 固定 `wav`（首版不支持 PCM） |
| `filterMarkdown` | `filter_markdown`，默认 `true` |
| `DEEPSEEK_API_KEY` | Bearer token |

错误映射：

| 上游 | 插件 kind |
| --- | --- |
| `400` + `Content Exists Risk` | `content-filter` |
| `400` 其他 | `validation` |
| `401/403` | `auth` |
| `402` | `quota` |
| `429` | `rate-limit`（可重试） |
| `503` | `server`（可重试） |
| `504` | `timeout`（可重试） |
| 中途断流 / WAV 截断 | `provider`（可重试） |

完整性检查：

- 有 `Content-Length` 时，实际字节数少于声明值 → 失败；
- WAV 的 RIFF 声明大小大于实际字节数 → 失败；
- 完全不是 WAV → `validateAudio` 失败；
- 空响应 → 失败。

真实验证（2026-11-14）：

- 用短句 `你好，我是育木的小鲸鱼。`、`stella`、`wav` 调用成功；
- 返回 138,284 字节的有效 WAV；
- 没有记录或输出 API Key。

## 6. 限制

- 首版不支持 PCM 输出（虽然 API 支持）；需要 PCM 时后续加 WAV 封装。
- 不支持 WebSocket 低延迟流式；当前插件契约返回完整文件。
- 不提供语速/音量调节；API 本身也不支持语速。
- 长文本会按官方计费字符计费；插件侧仍受 `limits.maxChars` 约束。
- 内容审核失败不能在插件侧绕过。
