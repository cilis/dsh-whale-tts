# Release notes 模板

以后所有 GitHub Release 统一使用本模板；标题、章节、语言和收尾保持一致。

## 标题

```text
dsh-whale-tts X.Y.Z 发布：<一句中文主题>
```

- 版本号与 `package.json`、git tag 一致；
- tag 保持 ASCII：`vX.Y.Z`；
- 主题只写这一版最重要的一件事，不堆 provider 列表。

## 正文

```markdown
## dsh-whale-tts X.Y.Z

### 新增
- ...

### 修复
- ...

### 变更
- ...

### 说明
- 测试：N pass / 0 fail。
- 已知限制：...
- 完整变更见 [CHANGELOG.md](...)。
```

规则：

1. **全中文**；provider id、文件名、命令、代码标识保持原文。
2. 固定顺序：新增 → 修复 → 变更 → 说明；没有内容的章节省略，不写“无”。
3. 每条以动词开头，一句话说清“做了什么/影响谁”，不写空泛的“优化体验”。
4. “说明”必须包含测试结果和已知限制；不能把未验证的云端调用写成已通过。
5. 末尾固定链接 CHANGELOG；有 release asset 时在 GitHub 页面附加，不在正文重复大段安装说明。
6. 先写 draft 检查，再发布；发布后不再改标题格式。

## 示例

```markdown
## dsh-whale-tts 0.5.1

### 新增
- 新增 `qwen` provider：接入 DashScope `qwen3-tts-flash`，下载 24 小时 URL 并输出 WAV。
- 新增 `doubao` provider：接入豆包 V3 SSE，解析 352/152/153 事件并输出 MP3。

### 修复
- 修复切换 provider 后仍显示上一个 provider 凭据引用的问题。

### 变更
- `tts_status` 增加 `preflight`，检查输出目录和 QQBot 音频路径形态。

### 说明
- 测试：152 pass / 0 fail。
- 已知限制：Qwen/豆包云 adapter 只做协议测试，CI 没有真实云端 key；`qwen-local` 需要单独启动 sidecar。
- 完整变更见 [CHANGELOG.md](../CHANGELOG.md)。
```
