# dsh-whale-tts 发布 / 集成验证记录（M9）

> 角色：发布 / 集成验证（qa-pack）
> 日期：2026-10-31
> 目标产物：`dsh-whale-tts@0.1.0`（`dsh.bundle.patch` + host / client 双半侧）
> 运行时：DeepSeek Harness `0.2.1-rc.5`（Desktop 版）
> 工具链：Node.js `v26.13.0` / npm `11.20.0` / pnpm `11.28.5`（DSH Desktop 内置）/ tar
> 工作目录：`E:\DeepSeek Harness\QQBot\qq-bridge\plugins\dsh-whale-tts`
> 约束：不修改真实 `~/.dsh`、不启动常驻 DSH 服务、不联网。

## 0. 结论

| # | 验证项 | 结论 |
| --- | --- | --- |
| 1 | 手动构建 host（tsc）+ client（rollup / sucrase） | ✅ 通过 |
| 2 | `npm pack --dry-run` 白名单：必需文件齐全、无 `src/` `test/` `node_modules/` `tsconfig*` | ✅ 55 项 |
| 3 | 真实 `npm pack` + tgz 内容校验（`tar -tzf`） | ✅ 与 dry-run 清单一致 |
| 4 | client bundle 伪 `__ModuleLoader__` 冒烟 | ✅ `id` / `name` / `apply` / `inject` 均符合契约 |
| 5 | 临时 profile 安装 + `--dump-config` | ✅ 出现 `# == dsh-whale-tts` 层，`- id: whale-tts` 已组合 |
| 6 | 离线合成 smoke（假 adapter，真实 TTS 管线） | ✅ 30 项断言全过 |
| 7 | 清理临时目录 / 真实 `~/.dsh` 未被触碰 | ✅ |

> §2、§3 记录的是本文档落盘前的打包结果（55 项）。写入 `docs/validation.md` 与
> `docs/validation-notes.md` 后按 §8 复验：条目变为 **57 项**，新增的两项就是本记录与
> notes，其余 55 项不变；最终 tgz 由定稿后的 `npm pack --ignore-scripts` 生成。

## 沙箱限制与规避（必读）

- **npm 生命周期（prepack/build）子进程在沙箱内不可用（EPERM）**：不执行 `npm run build` /
  不带 `--ignore-scripts` 的 `npm pack`，改为直接运行构建入口：
  `node node_modules/typescript/bin/tsc -p tsconfig.json`、`node build/build-client.mjs`，
  然后再用 `npm pack --ignore-scripts` 跳过 `prepack`。
- **无网络**：`dsh plugin add` 背后是 pnpm，需要 `--offline`；且默认 pnpm store 在 C: 盘，
  受 workspace-write 沙箱限制其 `index.db` 不可写（`ERR_SQLITE_ERROR`）。因此把
  `C:\Users\cilis\AppData\Local\pnpm\store\v11` **只读复制**到工作区
  `E:\DeepSeek Harness\QQBot\.qa-store\v11`，再用
  `--store-dir E:\DeepSeek Harness\QQBot\.qa-store --offline` 完成安装；pnpm 输出
  `downloaded 0`，可证明未联网。
- **不启动常驻 DSH**：只执行一次性 `dsh plugin ... add` 与 `--dump-config`；所有命令显式设置
  `DSH_HOME=E:\DeepSeek Harness\QQBot\.qa-dsh-home`，真实 `C:\Users\cilis\.dsh` 只读、未写入。
- **真 SAPI 合成需要父进程能 spawn PowerShell**（`powershell.exe -File scripts/sapi.ps1`），
  沙箱禁止 spawn，故 smoke 用假 adapter 验证 provider 之后的全部真实管线。

## 1. 手动预构建

```bash
$ node node_modules/typescript/bin/tsc -p tsconfig.json
$ node build/build-client.mjs
client bundle written: E:\DeepSeek Harness\QQBot\qq-bridge\plugins\dsh-whale-tts\lib\client.js (70649 bytes)
```

构建结果：`lib/index.js`（4,237 bytes）、`lib/client.js`（71,714 bytes，UTF-8 实际字节）、
`lib/**/*.d.ts` 共 21 个声明文件。`lib/` 与 `src/` 时间戳一致，无遗留未构建源码。

## 2. `npm pack --dry-run` 文件白名单校验

```bash
$ npm pack --dry-run --ignore-scripts --json --cache "E:\DeepSeek Harness\QQBot\.npm-cache" > .qa-pack-dryrun.json
# exit 0；cache 指向工作区内目录，避免写用户级 npm 缓存
```

断言结果：

```text
dry-run entries: 55
missing        : none
lib .d.ts count: 21
lib js/d.ts all under lib/: true
forbidden hits : none
```

| 期望包含 | 结果 | 期望不包含 | 结果 |
| --- | --- | --- | --- |
| `lib/index.js` | ✅ | `src/` | ✅ 无 |
| `lib/client.js` | ✅ | `test/` | ✅ 无 |
| `lib/**/*.d.ts`（21 个） | ✅ | `node_modules/` | ✅ 无 |
| `cordis.patch.yml` | ✅ | `tsconfig.json` / `tsconfig.client.json` | ✅ 无 |
| `locale/en.json`、`locale/zh.json` | ✅ | `build/` | ✅ 无 |
| `icon.svg` | ✅ | `.qa-*` 临时产物 | ✅ 无 |
| `README.md`、`README.zh.md` | ✅ | `*.tgz` | ✅ 无 |
| `LICENSE`、`CHANGELOG.md` | ✅ | | |
| `docs/providers.md`、`docs/self-hosting.md`（+ 本记录） | ✅ | | |
| `scripts/sapi.ps1`、`scripts/smoke.mjs` | ✅ | | |
| `package.json`（npm 必带） | ✅ | | |

结论：`files` 白名单配置完整；host 与 client 双半侧产物、bundle patch、locale、文档、
SAPI 脚本都在包内，源码 / 测试 / 构建配置不会误发布。

## 3. 真实 `npm pack` 与 tgz 内容校验

```bash
$ rm -f *.tgz
$ npm pack --ignore-scripts --cache "E:\DeepSeek Harness\QQBot\.npm-cache"
dsh-whale-tts-0.1.0.tgz
$ ls -la dsh-whale-tts-0.1.0.tgz
99337 bytes
$ tar -tzf dsh-whale-tts-0.1.0.tgz | sort > .qa-tar.txt
$ wc -l .qa-tar.txt
55 .qa-tar.txt
$ sha256sum dsh-whale-tts-0.1.0.tgz
e5b8e96374bb505f2a14de41ceb175f52da6e0a70f6bfb4129d959d6049ea62f *dsh-whale-tts-0.1.0.tgz
```

tgz 完整清单（55 项，`package/` 前缀已省略）：

```text
CHANGELOG.md
LICENSE
README.md
README.zh.md
cordis.patch.yml
docs/providers.md
docs/self-hosting.md
icon.svg
lib/client.d.ts
lib/client.js
lib/config.d.ts
lib/config.js
lib/core/audio.d.ts
lib/core/audio.js
lib/core/cache.d.ts
lib/core/cache.js
lib/core/chain.d.ts
lib/core/chain.js
lib/core/paths.d.ts
lib/core/paths.js
lib/core/service.d.ts
lib/core/service.js
lib/core/text.d.ts
lib/core/text.js
lib/core/voices.d.ts
lib/core/voices.js
lib/credentials.d.ts
lib/credentials.js
lib/index.d.ts
lib/index.js
lib/providers/mimo.d.ts
lib/providers/mimo.js
lib/providers/minimax.d.ts
lib/providers/minimax.js
lib/providers/openai.d.ts
lib/providers/openai.js
lib/providers/registry.d.ts
lib/providers/registry.js
lib/providers/sapi.d.ts
lib/providers/sapi.js
lib/remote/service.d.ts
lib/remote/service.js
lib/tools/list-voices.d.ts
lib/tools/list-voices.js
lib/tools/status.d.ts
lib/tools/status.js
lib/tools/synthesize.d.ts
lib/tools/synthesize.js
lib/types.d.ts
lib/types.js
locale/en.json
locale/zh.json
package.json
scripts/sapi.ps1
scripts/smoke.mjs
```

集合校验：

```text
dry-run entries: 55
tar entries    : 55 (package/ prefix stripped)
file sets equal: true
```

结论：`npm pack --dry-run` 与实际 tgz 内容完全一致，产物自洽。

## 4. client bundle 冒烟（伪 module loader）

不新增文件，`node -e` 内联脚本：伪造 `globalThis.window.__ModuleLoader__` 收集注册信息，
用极简 `react` stub 提供 `createElement`，`vm.runInThisContext` 加载 `lib/client.js`，
再调用 `factory(requireStub)` 得到插件模块导出。

```js
let registered = null
globalThis.window = { __ModuleLoader__: { load: (spec) => { registered = spec } } }
const React = { createElement: () => ({}), Fragment: {}, useState: () => [undefined, () => {}] }
const requireStub = (id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
  throw new Error('unexpected require: ' + id)
}
vm.runInThisContext(fs.readFileSync('lib/client.js', 'utf8'), { filename: 'lib/client.js' })
const exp = registered.factory(requireStub)
// 断言 registered.id === 'dsh-whale-tts'
// 断言 typeof exp.apply === 'function'
// 断言 Array.isArray(exp.inject) 且含 'slots' / 'locale' / 'connection'
// 断言 exp.name === 'whale-tts'
```

输出：

```text
[client-smoke] OK id=dsh-whale-tts name=whale-tts inject=["slots","locale","connection"] apply=function exports=apply,inject,name
```

bundle 头部 / 尾部与契约（见 `.research/client.md` §4.1、§4.3）一致：

```js
/* dsh-whale-tts browser half — generated by build/build-client.mjs; do not edit. */
window.__ModuleLoader__.load({
  id: 'dsh-whale-tts',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    ...
    exports.apply = apply;
    exports.inject = inject;
    exports.name = name;
    return module.exports;
  },
});
```

bundle 顶层唯一的 `require` 是 `require('react')`（命中宿主静态 seed 表），无 ESM 语法、
无顶层副作用。结论：client 半侧可被 DSH 的 lazy-CJS 加载器正常注册。

## 5. 临时 profile 安装 + `--dump-config`

环境（全程显式隔离真实 DSH home）：

```powershell
$env:DSH_HOME = 'E:\DeepSeek Harness\QQBot\.qa-dsh-home'
```

### 5.1 联网安装的沙箱替代（失败记录，说明环境限制）

| # | 命令关键参数 | 结果 | 原因 |
| --- | --- | --- | --- |
| 1 | `add --offline file:<tgz>` | `ERR_PNPM_NO_OFFLINE_TARBALL` | 默认 C: store 因跨盘不可硬链接被 pnpm 弃用，自动 E: store 为空 |
| 2 | `+ --store-dir C:\Users\cilis\AppData\Local\pnpm\store\v11` | `ERR_SQLITE_ERROR: unable to open database file` | 沙箱 workspace-write 禁止写 C: store 的 `index.db` |
| 3 | `+ --store-dir E:\...\QQBot\.qa-pnpm-store` | `ERR_PNPM_NO_OFFLINE_TARBALL` | pnpm 会自动追加版本目录 `v11`，复制的 store 布局少一层 |
| 4 | 将 store 复制为 `E:\...\QQBot\.qa-store\v11`，`--store-dir E:\...\QQBot\.qa-store` | ✅ 成功 | 同一磁盘、可写、`--offline` 未触发任何下载 |

store 复制命令（一次性，19 秒，1.43 GB；验证后删除）：

```powershell
robocopy 'C:\Users\cilis\AppData\Local\pnpm\store\v11' 'E:\DeepSeek Harness\QQBot\.qa-store' /E /MT:32
```

### 5.2 安装成功（全新 profile `ttsqa2`）

```powershell
& 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd' plugin --profile ttsqa2 add `
    --offline --store-dir 'E:\DeepSeek Harness\QQBot\.qa-store' `
    'file:E:\DeepSeek Harness\QQBot\qq-bridge\plugins\dsh-whale-tts\dsh-whale-tts-0.1.0.tgz'
```

关键输出：

```text
Packages: +4
Progress: resolved 4, reused 4, downloaded 0, added 4, done

dependencies:
+ dsh-whale-tts 0.1.0

Done in 534ms using pnpm v11.28.5
```

profile 清单（pnpm 安装后由 plugin-manager 自动 reconcile：`dsh.bundle.patch` →
`dsh.profile.bundles` 追加包名）：

```json
{
  "name": "dsh-profile-ttsqa2",
  "private": true,
  "dependencies": {
    "dsh-whale-tts": "file:E:/DeepSeek Harness/QQBot/qq-bridge/plugins/dsh-whale-tts/dsh-whale-tts-0.1.0.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-whale-tts"
      ]
    }
  }
}
```

已安装依赖解析结果（peer 依赖由 DSH 运行时侧解析，pnpm 仅提示 peer 警告）：
`dsh-whale-tts 0.1.0`、`@deepseek-ai/schemastery 3.18.5`、
`@deepseek-ai/cosmokit 1.8.6`、`@standard-schema/spec 1.1.0`。

### 5.3 `--dump-config` 组合结果

```powershell
& '...\dsh.cmd' --profile ttsqa2 --dump-config
# exit 0
```

关键输出（层 label 为 bundle 包名，`# ==` 开头）：

```yaml
# == @deepseek-ai/dsh-base
...
# == dsh-whale-tts
- id: whale-tts
  name: dsh-whale-tts
  config:
    provider: openai-compatible
```

结论：

- 包内 `cordis.patch.yml` 被 DSH 组合器按 `dsh.bundle.patch` 声明找到并作为独立层叠加；
- 插入行的 `id: whale-tts`（= 设置命名空间）与 `name: dsh-whale-tts`（= npm 包名）正确；
- 默认配置 `provider: openai-compatible` 生效；
- 安装通过引擎/兼容性校验（`engines.dsh: >=0.2.1-rc.4 <0.3.0-0` 匹配运行时 `0.2.1-rc.5`），
  未被 preflight / 后置校验拒绝；
- 首次验证用 `ttsqa` profile 亦成功，`ttsqa2` 为全新 profile 复验（证明安装路径不依赖前次状态）。

## 6. 离线 smoke（假 adapter，真实 TTS 管线）

```bash
$ node scripts/smoke.mjs
```

覆盖：`init()` → `synthesize('你好，世界。')` → 文件存在 / RIFF+WAVE 魔数 / 字节数 /
`relativePath` 无盘符与反斜杠 → 同文本再合成断言 `cached: true` → `status()` → `preview()`
→ `listVoices()` → `dispose()`，全部使用 `os.tmpdir()` 下的临时 state / output 目录，
结束后清理。关键输出：

```text
[smoke] phase 2: synthesize("你好，世界。")
  PASS  synthesize() returned ok
  PASS  output file exists
  PASS  RIFF magic at offset 0
  PASS  WAVE magic at offset 8
  PASS  on-disk size matches reported bytes
  PASS  relativePath has no drive letter or backslash
[smoke] phase 3: synthesize(same text) must hit the cache
  PASS  second call reports cached: true
  PASS  adapter was not called again
[smoke] phase 4: status()
  provider      = fake
  cache         = enabled=true files=1 bytes=1644
[smoke] phase 6: listVoices()
  providers = fake
  profiles  = 0
[smoke] OK: all checks passed
```

统计：`PASS=30`、`FAIL=0`、退出码 0。WAV 为 8000 Hz / 16-bit / mono、44 字节头 + 0.1 s
静音（合计 1,644 bytes）。

**边界**：该 smoke 证明 provider 之后的一切（校验、缓存、命名、原子写、状态、试听）是真实的，
但 provider 本身是假 adapter。真 SAPI 合成要求父进程能 spawn PowerShell，本沙箱禁止，
需在真机按 README 配置 `provider: sapi` 后调用 `tts_synthesize` 验证。

## 7. 清理与隔离证明

验证结束后删除全部临时产物（均在仓库内，见 §8 命令）：`.qa-dsh-home/`（两个临时 profile）、
`.qa-store/`（1.43 GB pnpm store 副本）、`.pnpm-store/`（失败尝试产生的自动 store）、
`.qa-*` 日志/JSON、`dsh-whale-tts-0.1.0.tgz`。真实 `C:\Users\cilis\.dsh` 全程只读，未被写入；
未启动 / 重启任何常驻 DSH 服务。

## 8. 定稿后的最终复验

写本文档后再次执行打包（文档本身进入 `docs/`）：

```bash
$ node node_modules/typescript/bin/tsc -p tsconfig.json && node build/build-client.mjs
$ npm pack --dry-run --ignore-scripts --json --cache "E:\DeepSeek Harness\QQBot\.npm-cache"
$ npm pack --ignore-scripts --cache "E:\DeepSeek Harness\QQBot\.npm-cache"
$ tar -tzf dsh-whale-tts-0.1.0.tgz | sort | wc -l
57
```

最终产物条目 **57 项**：§3 的 55 项 + `docs/validation.md` + `docs/validation-notes.md`，
必需/禁止清单断言与集合相等性（dry-run == tar）不变：

```text
dry-run entries: 57
tar entries    : 57
file sets equal: true
missing        : none
forbidden hits : none
lib .d.ts count: 21
docs entries   : docs/providers.md, docs/self-hosting.md, docs/validation-notes.md, docs/validation.md
dsh-whale-tts-0.1.0.tgz  约 103 KB
```

同一份最终 tgz 又在全新 profile `ttsqa3` 上复验（`add --offline` + `--dump-config`）：

```text
+ dsh-whale-tts 0.1.0
Done in 638ms using pnpm v11.28.5
# == @deepseek-ai/dsh-base
# == dsh-whale-tts
- id: whale-tts
  name: dsh-whale-tts
    provider: openai-compatible
```

## 9. 用户需在沙箱外执行的等价命令

```powershell
cd 'E:\DeepSeek Harness\QQBot\qq-bridge\plugins\dsh-whale-tts'
npm run build                      # 沙箱内请改用 §1 的两条 node 命令
npm pack --ignore-scripts          # 或 npm pack（联网 + 允许 prepack 时）
dsh plugin --profile <你的profile> add .\dsh-whale-tts-0.1.0.tgz   # 联网安装依赖
dsh --profile <你的profile> --dump-config                          # 期望含 "# == dsh-whale-tts"
node scripts/smoke.mjs             # 离线自检
# 真机 SAPI：配置 provider: sapi 后调用 tts_synthesize（需 PowerShell 可 spawn）
```

## 附：验证矩阵

| 验证目标 | 手段 | 判定 |
| --- | --- | --- |
| 包内容完整 / 不误发布源码 | `npm pack --dry-run` + 断言脚本 | 必需 15 类文件齐全，0 禁止项 |
| tarball 与 dry-run 一致 | `tar -tzf` 集合比较 | `file sets equal: true` |
| client 半侧契约 | 伪 `__ModuleLoader__` + react stub | `id/name/apply/inject` 全过 |
| bundle 可安装 / 被组合 | 临时 DSH_HOME + `plugin add` + `--dump-config` | `# == dsh-whale-tts` 层出现 |
| 引擎兼容性 | 安装未被拒 | `engines.dsh` 匹配 `0.2.1-rc.5` |
| 合成管线正确性 | `scripts/smoke.mjs`（假 adapter） | 30/30 断言通过 |
| 真 SAPI | 需真机 PowerShell | 沙箱外执行 |

## 10. 0.1.1 修复复验（2026-11-01，真机首次打开设置卡后）

真机症状：设置卡能渲染，但点「刷新」报 `cannot get property "rpc" without inject`。

根因（两个）：

1. **client half 用错了对象**：`new RpcClient(ctx)` 把 Cordis **context 代理**当成 connection 服务，RPC 调用时读取 `ctx.rpc` 被 context 守卫拒绝（`rpc` 不是声明过的服务）。修复：`new RpcClient(ctx.connection)`（`inject` 里已声明 `connection`）。
2. **运行时依赖被解析到旧版**：在 profile 里用 `createRequire` 探测，`@deepseek-ai/dsh-tools` 解析到 `D:\Software\node\node_global\...\dsh-tools`（**0.1.0-rc.8**），而运行时是 **0.2.1-rc.5**——工具注册契约不同，host 半侧有加载失败风险。修复：**移除对该包的运行时依赖**，新增 `src/tools/definition.ts`（本地工具定义构建器：raw JSON Schema + 参数校验，符合运行时 registry 的受支持子集），三个工具改用 `defineLocalTool`；现在插件运行时只依赖 `@deepseek-ai/schemastery`。

同时把 host `settingsBridge` 改为晚绑定：settings 服务在插件之后挂载也能正常读写配置。

复验结果（沙箱内）：

| 项 | 命令 | 结果 |
| --- | --- | --- |
| host apply（假 Cordis ctx） | `node scripts/host-apply-smoke.mjs` | **10/10 PASS**：三工具注册、RPC 通道 `/dsh-whale-tts`、`status` / `config/get` / `profiles/list`、未知 endpoint → `tts/not-found` |
| client bundle（假 `__ModuleLoader__` + 假 connection） | node 内联脚本 | slot key=`dsh-whale-tts`；`rpc.call('/dsh-whale-tts','status')` 经 connection 服务发出（不再读 `ctx.rpc`） |
| 单测 | `node --test --test-isolation=none test/` | **103/103** |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.1.tgz`，**60 项**（新增 `lib/tools/definition.*` 与 `scripts/host-apply-smoke.mjs`） |
| 运行时依赖检查 | `grep -rn "@deepseek-ai/" lib/` | 只剩 `@deepseek-ai/schemastery`（依赖）；`dsh-tools` 运行时 import **0 处** |

用户侧安装命令不变：退出 DeepSeek Harness → 运行 `tools\install-whale-tts.ps1` → 重开。

## 11. 0.1.2 修复复验（2026-11-01，真机第二次打开设置卡后）

真机症状：卡片能渲染、RPC 已发出，但返回
`transport failure for /dsh-whale-tts/status: HTTP 405`。

真因（启动日志直接给出）：

```
name: 'whale-tts',
Error: cannot get property "webServer" without inject
  at Object.callback (…/profiles/qqbot/node_modules/dsh-whale-tts/lib/index.js:98:40)
```

Cordis 的 traceable 服务代理会把 `connection.rpc.handle()` 的 `owner` 解析成**消费者上下文的 shadow**，而 host 侧真正注册路由走的是 `owner.webServer.register(route)`。我们只注入了 `connection`，子 fiber 因此抛错；子 fiber 失败不会让父插件失败（父 entry 仍是 active），于是「插件已加载、但路由不存在」，HTTP 层就对 POST 回 405。

修复：

- 注册子上下文改为 `ctx.inject(['connection', 'webServer'], …)`，并按内嵌插件（如 `dsh-mnemon`）的写法把 `webServer` 作为直接属性 seed 进该上下文（`extendWithService`）。
- `TtsService` 的释放移到插件级 `ctx.effect`，这样即使 RPC 子上下文不激活（无 web 的 headless profile）也能正确清理。
- `scripts/host-apply-smoke.mjs` 现在模拟运行时的 `webServer` 查找：若 inject 集合回退，冒烟会直接失败。

复验（真机运行中的应用 + 沙箱内）：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 路由是否注册（修复前） | `POST http://127.0.0.1:<port>/dsh-whale-tts/status` | **405**（路由不存在） |
| 路由是否注册（修复后） | 同上 | **401**（路由存在，被鉴权围栏拦截；对照组 `/dsh-mnemon-view/dashboard` 同为 401） |
| 启动日志 | `~/.dsh/logs/startup-*.log` 中 `whale` 条目 | 修复前出现上述 `webServer` 错误；0.1.2 加载后无新增错误 |
| host apply 冒烟 | `node scripts/host-apply-smoke.mjs` | **11/11 PASS**（新增「rpc child injects connection + webServer」断言） |
| 单测 | `node --test --test-isolation=none test/` | **103/103** |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.2.tgz`，60 项 |
| 安装 | desktop 走应用内插件管理器；qqbot 走 CLI | 两个 profile 均为 0.1.2；`--dump-config` 含 `# == dsh-whale-tts` |

## 12. 0.1.3 修复复验（2026-11-01，卡片首次成功连上宿主后）

真机症状：RPC 通了之后，卡片一打开就报 `design description is empty`。

真因：card 的初次 `refresh()` 把 `design/candidates` 当作「列出已保存候选」来调
（无 payload），而 host 的该端点语义是「**生成**候选」：description 为空 → 抛
`TtsError('validation', 'design description is empty')` → `Promise.all` 整体失败，
整个卡片只显示这一条错误。

修复：

- 新增 `design/list` 端点（`service.listCandidates()`，只读磁盘、不联网）；
- card 的 `refresh()` 改调 `design/list`；`design/candidates` 仍只用于生成，空描述
  依旧返回校验错误；
- 新增两条单测：`design/list` 不触发生成路径；`design/candidates` 空描述映射为
  `tts/bad-request`；host 冒烟增加 `design/list returns an array` 断言。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **105/105** |
| host apply 冒烟 | `node scripts/host-apply-smoke.mjs` | **12/12 PASS** |
| client bundle | 伪 `__ModuleLoader__` + 假 connection | `rpc.call('/dsh-whale-tts/design/list')` 命中 |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.3.tgz`，60 项 |

## 13. 0.1.4 修复复验（2026-11-01，第一次真正点「生成候选」）

真机症状：`provider "mimo" has no designModel configured`。

真因：`Config` 的 provider 子 schema 给每个字段都写了 `.default('')`，所以
`cordis.patch.yml` 里只写 `enabled` / `apiKeyEnv` 时，Loader 校验后的
`providers.mimo.designModel` 是**存在但为空**的字符串；`providerConfigFor()` 的
合并顺序是「内置默认 ← 配置值」，空串把内置的 `mimo-v2.5-tts-voicedesign` 覆盖掉，
`designCandidates()` 于是判定未配置。clone 同理会坏。

修复：`providerConfigFor()` 里空字符串不再覆盖非空内置默认（显式非空值仍然优先；
内置默认也是空的键如 `sapi.model` 保持空）。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **106/106**（新增 1 条合并规则回归） |
| 运行时形状复现 | 用 schema 形状的「空 provider 字段」直接调 `designCandidates()` | 不再报 designModel；失败前移到预期阶段（缺少密钥 / sapi spawn EPERM） |
| host apply 冒烟 | `node scripts/host-apply-smoke.mjs` | **12/12 PASS** |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.4.tgz`，60 项 |

## 14. 0.1.5 修复复验（2026-11-01，音色设计不生效）

真机症状：生成候选成功，但候选声音完全没按「声音描述」生成。

对照官方文档（`mimo.mi.com/static/docs/api/audio/tts.md`）后确认两处：

1. **`mimo-v2.5-tts-voicedesign` 不支持 `audio.voice`**，设计描述只从 `user` 消息读取；适配器却把 `config.voice`（默认「苏打」）兜底塞进 `audio.voice`，预设音色覆盖了设计描述。修复：voice 选择改为按模型区分（preset / design / clone）。
2. **设计请求失败会回退到 sapi**：`designCandidates()` 走的是通用 provider 链，mimo 一旦报错（例如上面的非法字段）就静默用离线 SAPI 生成候选——听感与描述完全无关，且看不到错误。修复：设计候选与克隆音色合成都只跑主 provider，失败直接抛 `tts/provider`。

另外按官方示例给设计请求加 `audio.optimize_text_preview: true`（可用 `providers.<id>.designOptimizeText: false` 关掉），让示例句按设计音色润色。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **110/110**（adapter：design 无 voice、clone 用 data URL、optimize 开关；service：design 不回退） |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.5.tgz`，60 项 |
| 真机 | 卡片重新生成候选 | 待用户验收（需重启/热加载后重试） |

## 15. 0.1.6 修复复验（2026-11-01，重命名/复制按钮无反应）

真机症状：音色档案库的「重命名」「复制」点了没反应。

真因：card 用 `window.prompt()` 取名字、`window.confirm()` 做删除确认。
**Electron 不实现这两个对话框**（prompt 恒返回 `null`，confirm 恒返回
`false`），所以三个 handler 都在第一行就 return 了——按钮有效但什么也没发生。
删除按钮同样中招。

修复：

- 重命名改为行内输入框（Enter 保存 / Esc 取消，值未变则直接退出）；
- 复制直接调 `profiles/duplicate({ id })`，由 host 生成 `<name> 副本`（克隆样本会一起复制）；
- 删除改为行内两步确认（不再用浏览器对话框）；
- 新增 `scripts/client-bundle-smoke.mjs`：用伪 `__ModuleLoader__` 加载构建产物，
  断言 slot/RPC 契约，并**断言 bundle 里不再出现 `window.prompt` / `window.confirm`**。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **110/110** |
| client bundle 冒烟 | `node scripts/client-bundle-smoke.mjs` | **9/9 PASS**（含 dialogs 检查、slot key、RPC 通道） |
| host 冒烟 | `node scripts/host-apply-smoke.mjs` | **12/12 PASS** |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.6.tgz`，61 项 |

## 16. 0.1.7 增强复验（2026-11-01，克隆音色保留设计感）

需求：声音设计把语气/情绪放在设计提示词里，固化克隆后合成时没带这段指令，
一换文本就丢掉设计时的感觉。

实现：

- `VoiceProfile.styleInstruction`（可选）：profile 级的默认风格指令；
- `design/adopt` 时把设计描述自动写入 `styleInstruction`；
- `resolveVoice()` 返回 active profile 的 `styleInstruction`，`prepare()` 的风格
  优先级变为「调用参数 > profile 指令 > provider 默认」，因此合成与试听都会带上；
- 档案库新增「风格指令」行内编辑器（可设置/修改/清空任意 preset/clone 档案），
  复制档案时一并复制；缓存 key 含 style，改风格自然失效；
- `tts_synthesize(style=…)` 仍可按次覆盖。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **111/111**（adopt 自动写入、duplicate 复制、resolveVoice 返回 style、service 请求带 style 且调用参数优先） |
| client bundle 冒烟 | `node scripts/client-bundle-smoke.mjs` | **9/9 PASS** |
| host 冒烟 | `node scripts/host-apply-smoke.mjs` | **12/12 PASS** |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.7.tgz`，61 项 |

## 17. 0.1.8 修复/打磨复验（2026-11-01，凭据清除语义 + 控件风格）

问题 1：卡片「清除密钥」直接走 `credentials/clear` → `ctx.credentials.unset(ref)`。
复用模式下 ref 是 DSH 的共享凭据（`XIAOMI_TOKEN_PLAN_CN_API_KEY`），点一下就会把
DSH 凭据库里那条删掉，所有读取它的组件一起失效。

修复：复用模式下按钮禁用并显示说明；host 端点也兜底拒绝（`source !== 'manual'`
→ `tts/bad-request`）；手动模式仍可清除，改为行内两步确认。

问题 2：控件风格不统一（输入框/下拉/按钮高度不一致、标签列宽不一、徽标样式不一、
单复数行混排）。

修复：统一控制高度 28px / padding / 圆角 / 字号；标签列固定 88px；徽标统一为
pill；单选/复选组独立布局不再继承行边距；接口区拆成「每行一个字段」并补提示文案。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **113/113**（新增 reuse 拒绝、manual 允许两条） |
| client bundle 冒烟 | `node scripts/client-bundle-smoke.mjs` | **9/9 PASS** |
| host 冒烟 | `node scripts/host-apply-smoke.mjs` | **12/12 PASS** |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.8.tgz`，61 项 |

## 18. 0.1.9 修复复验（2026-11-01，清除按钮可按 + 归属记录）

真机症状：配置临时 key 并清除后切回 `XIAOMI_TOKEN_PLAN_CN_API_KEY`，清除按钮
又能点了。

真因：0.1.8 用「keySource 模式」推断所有权；保存过临时 key 后模式停留在
`manual`，切回共享 ref 也仍是 `manual`，于是按钮允许清除——host 侧也只校验
`source` 参数，存在误删共享凭据的漏洞。

修复：改为**按凭据 ref 记录归属**（`$DSH_HOME/whale-tts/keys-owned.json`）：

- 只有本插件通过卡片写入的 ref 才允许清除；其余一律拒绝（不调用 `credentials.unset`）；
- `credentials/candidates` 返回 `owned`，卡片据此启用/禁用按钮并给出说明；
- 保存密钥时登记、清除成功时注销；状态文件原子写入；
- 单测：service 归属生命周期（保存→candidates.owned→清除→文件）、remote 拒绝未归属 ref、手动清除路径。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **114/114** |
| client bundle 冒烟 | `node scripts/client-bundle-smoke.mjs` | **9/9 PASS** |
| host 冒烟 | `node scripts/host-apply-smoke.mjs` | **12/12 PASS** |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.1.9.tgz`，63 项（新增 `lib/core/owned-keys.js/.d.ts`） |

## 19. 0.2.0 改名 + 设计描述兜底（2026-11-01）

需求一：音色设计固化时自动把描述存为档案风格指令。0.1.7 起卡片已在 `design/adopt`
里带 `description`，本次再加 host 兜底：`design/adopt` 未收到 description 时回退到
配置的 `designDescription`，保证任何客户端/草稿状态下固化出来的克隆档案都带设计提示词。

需求二：插件改名 `dsh-whale-tts`。改动范围：

| 项 | 旧 | 新 |
| --- | --- | --- |
| npm 包名 / bundle 显示名 | `dsh-whale-tts` | `dsh-whale-tts` |
| client 模块 id / settings 卡槽位 key | `dsh-whale-tts` | `dsh-whale-tts` |
| RPC 通道 | `/dsh-whale-tts` | `/dsh-whale-tts` |
| loader entry id / settings 命名空间 | `whale-tts` | **保持不变**（兼容旧配置与已存设置） |
| 状态目录 | `$DSH_HOME/whale-tts` | **保持不变**（音色档案/候选/归属记录不迁移） |
| 工具名 | `tts_*` | 保持不变 |

迁移：profile 依赖与 patch 行 `name:` 需改为新包名；安装脚本会先移除遗留
`dsh-whale-tts` 依赖再安装。两个 profile 均已完成迁移并验证。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **115/115**（新增 adopt 兜底断言） |
| host 冒烟 | `node scripts/host-apply-smoke.mjs` | **12/12 PASS**（name=whale-tts、通道 `/dsh-whale-tts`） |
| client bundle 冒烟 | `node scripts/client-bundle-smoke.mjs` | **9/9 PASS**（模块 id/槽位 key/通道均新名） |
| 离线合成冒烟 | `node scripts/smoke.mjs` | 30/30 PASS |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.2.0.tgz` |

## 20. 0.3.0 备份导入导出 + 全量改名（2026-11-01）

### 备份 / 恢复

- 设置卡新增「备份与恢复」：导出写 `<state>/backups/whale-tts-backup-*.json`（档案+样本+设计候选+激活指针+无密钥配置快照+已归属 key 引用），任何密钥值都不落盘；
- 导入支持文件上传（base64 走 RPC）或 host 路径，模式 merge / eplace；
- 每次导入前自动导出当前状态为安全备份，导入后可一键恢复；保留最近 10 份备份；
- 导入的档案一律分配新 id 与样本文件，跨机器恢复不会撞 id；
- 新 RPC：ackup/export、ackup/list、ackup/import。

### 全量改名收尾

| 项 | 旧 | 新 |
| --- | --- | --- |
| loader 行 id / settings 命名空间 | feiyu-tts | whale-tts |
| 状态目录 | `/feiyu-tts` | `/whale-tts`（旧目录由安装脚本复制迁移，不删除） |
| locale 命名空间 | settings.feiyuTts | settings.whaleTts |
| 仓库目录 | plugins/dsh-feiyu-tts | plugins/dsh-whale-tts |
| 安装脚本 | tools/install-feiyu-tts.ps1 | tools/install-whale-tts.ps1 |

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **111/111**（新增备份往返/替换/拒绝非法文档、归属、adopt 兜底） |
| host 冒烟 | `node scripts/host-apply-smoke.mjs` | **14/14 PASS**（含 backup/export、backup/list） |
| client bundle 冒烟 | `node scripts/client-bundle-smoke.mjs` | **9/9 PASS** |
| 离线合成冒烟 | `node scripts/smoke.mjs` | 30/30 PASS |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.3.0.tgz`，63 项 |
| 真机安装 | desktop（pnpm）+ qqbot（CLI） | 均 **0.3.0**；qqbot `--dump-config` 输出 `id: whale-tts` 无解析错误 |

## 21. 0.3.1 / 0.3.2 工具 schema 修复 + provider 收敛（2026-11-01）

真机复验时发现 `tts_list_voices` 报错
`"value.profiles[0].styleInstruction" is not a declared property`：0.1.7 起档案就带
`styleInstruction`，但该工具的输出 JSON Schema 没有声明。0.3.1 补齐声明。

0.3.2 按需求只开放 MiMo 作为主 provider：

- `ProviderStatus.selectable`：仅 `mimo` 为 true，其余内置 provider（openai-compatible /
  minimax / sapi）为 false；未知/自定义适配器 id 仍允许（测试与第三方适配器不受影响）；
- 卡片 Provider 下拉只列可选项，并提示「其余 N 个暂未开放」；历史配置里的非可选值显示
  「暂不可用」；
- `openai-compatible` 默认改为 disabled，bundle 默认 `provider: mimo`；
- 主 provider 若被设为其他内置 provider，`synthesize/design/preview` 在准备阶段直接失败：
  `provider "..." is not available yet; choose "mimo"`；离线 `sapi` 仍可作为回退使用。

复验：

| 项 | 手段 | 结果 |
| --- | --- | --- |
| 单测 | `node --test --test-isolation=none test/` | **114/114**（新增 selectable 与主 provider 拒绝用例） |
| host 冒烟 | `node scripts/host-apply-smoke.mjs` | 全部 PASS |
| client bundle 冒烟 | `node scripts/client-bundle-smoke.mjs` | **9/9 PASS** |
| 离线合成冒烟 | `node scripts/smoke.mjs` | 30/30 PASS |
| 打包 | `npm pack --ignore-scripts` | `dsh-whale-tts-0.3.2.tgz` |
