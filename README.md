# dsh-whale-tts

> 这声音是育木的小鲸鱼的。

给 [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) 用的语音合成插件：把文本合成为本地音频文件并返回路径。播放、发送、上传都不归它管，交给调用方。

## 功能

- **三个工具**
  - `tts_synthesize`：文本转语音，返回绝对路径、相对路径和文件名；
  - `tts_list_voices`：列出 provider 能力和已保存的音色档案；
  - `tts_status`：自检 provider、密钥、缓存、输出目录。
- **声音设计 / 克隆**：写一段描述生成 2~5 个候选，试听后固化；也可以上传 10MB 内的 wav/mp3 做参考音频克隆。设计和克隆都会保留描述里的语气、语速，作为风格指令。
- **音色档案**：预置、克隆、设计三种，最多 50 个，可手动切换；删除档案会一并删掉参考音频。
- **设置卡**：DSH 插件页里可视化操作——试听、生成候选、管理档案、写密钥、改输出设置（中英双语）。
- **朗读**：DSH 助手每条最终回复的操作行有播放按钮，用当前音色朗读/暂停；设置卡可开「自动朗读新回复」（默认关，只读一轮最后一条正文）、跳过代码块、分段长度和语速。行内代码按词语读出，围栏代码块默认跳过。
- **备份与恢复**：把档案、样本、候选导出成一个 JSON（不含密钥），导入支持合并或替换，导入前自动备份当前状态。
- **密钥安全**：只保存 DSH 凭据的引用名，工具结果、日志和前端都不会出现密钥值；只允许清除本插件自己写入的凭据。
- **离线回退**：主 provider 目前只有 MiMo；MiMo 不可用时可以回退到 Windows 自带的离线 SAPI。

## 快速开始

```
dsh plugin --profile <profile> add file:/路径/dsh-whale-tts-0.4.2.tgz
# 或在 DSH 插件页安装 tgz / 本地目录，装完重启 DSH
```

- 详细中文说明：[README.zh.md](README.zh.md)
- English documentation: [README.en.md](README.en.md)
- Provider 与自托管：[docs/providers.md](docs/providers.md)、[docs/self-hosting.md](docs/self-hosting.md)
- 其他 TTS API 调研（Qwen / 豆包 / MiniMax / OpenAI / Azure / ElevenLabs / SiliconFlow / Fish Audio）：[docs/tts-apis/](docs/tts-apis/)

## License

MIT

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
