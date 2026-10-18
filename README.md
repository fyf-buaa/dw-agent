# dw-agent

面向 digital-wifa 等 3D 数字人项目的 LLM 后端，基于固定提交的 Pi 源码改造。项目将稳定人格、跨会话记忆、关系与情绪、虚构生活及日记接入对话，同时保留独立的 Agent 工具执行能力。HTTP `/api` 接收业务操作，WebSocket `/dw-agent/v1` 提供多客户端事件订阅和断线补收。

- [启动、配置与部署](packages/dw-executor/README.md)
- [HTTP / WebSocket API 规范](packages/dw-executor/docs/protocol-v1.md)
- [OpenAPI](packages/dw-executor/schemas/openapi.json) · [WebSocket JSON Schema](packages/dw-executor/schemas/protocol-v1.schema.json)
- [Godot 客户端示例](packages/dw-executor/examples/godot/dw_agent_client.gd)

完成依赖安装和模型配置后，在仓库根目录运行 `npm run start:dw`，打开 `http://127.0.0.1:17850/`，使用服务访问令牌连接。没有模型凭据时也可先启动，再通过 WebUI 配置。安装步骤、令牌位置及环境变量见启动文档。

## 拟人核心

拟人化不只是为模型追加一句“扮演某个角色”。例如，用户说过“我喜欢兰花”，系统会保留带来源的交谈摘录；模型可以提出一条偏好记忆，但须经审核才作为确认信息使用。以后在同一人格与用户范围内创建新会话，相关记忆仍可被召回，同时结合角色设定、当地时间、关系和虚构生活状态组织回复，而不是把全部历史无差别塞入上下文。

### 稳定人格与角色档案

- **身份与表达**：分别设置系统提示、角色名称、身份、世界观、经历、性格、说话方式和行为边界。模型不能自行改写稳定系统提示和角色卡。
- **时间与生活背景**：设置角色时区、起床和就寝时间、固定作息及地点、重要日期和目标。当前活动优先采用固定作息，其次采用当天日程，最后回退到作息时钟。
- **人格与用户分区**：长期资料以 `persona_id × user_id` 保存。同一分区跨会话共享记忆、关系、生活配置与日记；不同分区不混用。`user_id` 是资料分区标识，不是登录凭据，访问权仍由令牌控制。
- **版本边界**：会话冻结创建时的角色卡；保存人格后，新建会话使用新版本，已存在会话不会被静默换人格。后台生活任务读取最新保存的角色卡。

角色扮演默认关闭，需要在“角色档案”明确开启。记忆开关、生活状态开关、后台调度登记是不同层次的控制，不因打开某个页面而全部自动启用。

### 长期记忆：记录、审核、召回与遗忘

记忆分为交谈摘录、事实、事件、承诺和反思，并标注属于用户、角色、世界还是双方关系。每条资料保留说话者、时间、会话和运行来源，避免把角色说过的话直接当成用户事实。

1. **记录交谈**：启用角色扮演和记忆后，成功完成的交谈保存经过凭据脱敏的摘录。摘录只证明双方说过什么，不证明话里的现实行动已经发生；不会回扫旧会话自动提炼记忆。
2. **提出记忆**：模型可在正常回复后附加私有控制数据，提出事实、事件、承诺或反思。服务端校验原文证据、归属和敏感内容；模型提议一律先进入待审核状态，不额外调用一次“记忆提取模型”，控制数据也不会进入角色台词。
3. **人工管理**：在“记忆与关系”中审核、手动添加、纠正、固定、归档、恢复或遗忘。确认后的信息才能作为有效记忆参与召回；固定条目构成有严格预算的核心记忆。
4. **按需召回**：使用本机 SQLite FTS5、Unicode 分词与中文二元词组检索，结合重要性、时间衰减、持久性、召回强化和近重复抑制排序。每轮最多加入 8 条固定核心和 6 条动态相关记忆，并受字符预算限制。召回预览不会增加强化次数。
5. **可控遗忘**：遗忘会清除该条记忆的正文、来源引用与索引，保留不含正文的防重放标记；依赖该来源的日记及衍生素材会失效。归档则保留内容，允许恢复。

当前是**词法检索**，不是向量语义检索，没有隐藏的 embedding、重排或摘要请求。较早资料中的“今天、明天”等相对日期按来源时间解释，不直接套用到当前日期。凭据识别不能替代保密措施，不应主动向角色提供密钥或密码。

### 关系与情绪演化

系统保存双方关系背景、用户称呼、重要日期、亲密分、关系阶段、情绪正负倾向及唤醒程度。关系阶段从回避、戒备、中立逐步到熟悉、友好、亲近、信任和深度联结，由状态规则计算，不让模型任意改名或跳级。

- 模型提出的情绪和亲密度变化必须附当前用户原文证据，不能只凭角色自己的台词自我强化。
- 亲密分范围为 −100～100；模型单轮最多变化 ±3，每个角色当地日的绝对变化累计最多 12。变化保留原因和证据，所有者也可手动校正。
- 情绪与唤醒程度按 4 小时半衰期回落；长期没有互动时，亲密分逐渐向中立冷却，而不是永久维持一次对话产生的强烈状态。
- 关系与情绪作为后续对话的上下文，不代表模型具有真实情感，也不替代角色卡中的行为边界。

### 虚构生活状态与日程

角色可以拥有随当地时间变化的生活背景，而不是每次对话都从“刚刚醒来”开始：

- **生活状态**：睡眠、梦境、健康或不适、饥饿与胃口、基础生理周期共同影响精力和情绪底色。状态具有起止时间、原因、阶段和演化记录，支持到期、转移、恢复余韵及人工添加或移除。
- **可选六阶段周期**：支持月经期、卵泡期、排卵前期、排卵期、黄体期和经前期，分别配置持续时间、状态描述、情绪底色和精力变化；还可独立设置不适模拟。它是可关闭的角色设定，不是健康预测或医学模型。
- **每日日程**：结合角色卡、固定作息、专用生活背景和已有资料生成当天活动、时间、情绪与地点；允许自定义提示词。模型不可用时可使用明确标注来源的已有或固定日程，不冒充模型生成成功。
- **日程细化**：可对当前或即将开始的日程段生成更细的虚构事件，全部标记为模拟内容。细化不会执行现实任务，也不会主动向用户发送消息。
- **对话注入**：可将当前活动、精力、有效状态、未完成计划和近期日记的有界摘录加入回复上下文；可以关闭注入而保留资料供管理查看。天气来自手工配置的虚构背景，不联网读取真实天气。

生活状态的推进不需要额外 LLM 推理；日程、日记和细化生成才会使用配置的模型。查看资料不会把未初始化的基线状态伪装成已经生成的生活事件。

### 角色日记与连续性

日记以角色第一人称记录当天资料，支持自动选形式、场景式、片段式、内心独白和观察式写法；可选择短、中、长篇幅，严格、平衡或更具表现力的写实程度，并填写创作方向。

- **证据分层**：分别标注有来源的交谈或人工记录、尚未完成的计划、模拟事件和虚构状态。“用户说做了某事”只证明这句话被说过，不等于任务已经执行完成。
- **跨日承接**：保留近期日记、情绪线索和长期事件线索，避免每天完全失忆；历史素材仍注明日期，不被搬成今天发生的新事件。
- **衍生资料**：可从日记生成自然分享素材、梦境片段和连续性线索，供后续角色上下文使用，不因此触发主动消息或社交平台发布。
- **质量与降级**：生成过程有受限的质量检查与修订预算。证据不足或模型失败时，可以返回明确标注的证据式备用内容，并记录警告，不编造“模型写作成功”。
- **保留与删除**：支持查看历史日记、重新生成及删除；默认保留最近 14 篇。删除当天日记后，自动维护不会立即将它重新写回。

### 自动维护、默认值与模型分工

日程和日记配置中的“开启”不等于自动调度已经登记。需要为相应人格与用户明确注册后台调度；服务运行后，调度不依赖浏览器在线，只处理当前当地日期，不补造停机期间的过去日记。

| 配置项 | 默认行为 |
|---|---|
| 角色扮演 | 关闭，需手动启用 |
| 记忆 | 开启，但以角色扮演已启用为前提；上下文预算 8192 字符 |
| 角色时区与作息 | 使用服务器本地时区；07:30 起床、23:30 就寝，可修改 |
| 每日日程 | 配置开启，07:30 生成，目标 10 条 |
| 每日日记 | 配置开启，23:10 生成；自动选形式、标准篇幅、平衡写实 |
| 日记保留 | 最近 14 篇，可设为 1～60 篇 |
| 拟人化状态与被动注入 | 开启，状态强度 50 / 100；健康、胃口、基础周期可分别关闭 |
| 日程细化 | 关闭；启用后默认提前 3 分钟 |
| 六阶段周期 | 关闭；六阶段默认依次为 5 / 5 / 3 / 1 / 8 / 6 天 |
| 人工状态持续时间 | 12 小时，可设为 1～72 小时 |

“模型与分工”分别配置 `chat`、`agent` 和 `life` 的物理模型、思考强度及输出预算；生活任务还可对日程、日记、细化单独指定模型。未单独指定的生活任务使用 `life` 分工。后台生成是独立 Job，可查询状态、实际调用数、token、错误和警告，也可显式取消；关闭页面不等于取消任务。后台生成会消耗模型额度，角色状态与记忆检索本身不会额外发起推理。

### 与 Agent 和 3D 数字人的配合

前台拟人对话与后台 Agent 使用独立执行历史：角色可以在任务等待审批时继续聊天，任务执行不会占用或替换聊天上下文。Agent 保持创建时绑定的人格，支持真实文件读写、命令执行、MCP 和扩展工具；实际能力受工作区、执行配置、预算和逐次审批约束。**角色描述了某个动作，不等于工具已经执行。**

可交付回复按完整句段返回：

- `expression`：自然语言动作或表现描述。
- `speech`：不含动作描述的台词，可交给 TTS。
- `text`：`（动作描述）台词`，供普通文字界面直接展示。
- `task_refs`：由服务端绑定的相关任务引用，不是模型生成的执行指令。

数字人前端负责把表现描述映射到动画，将台词送入 TTS，并报告实际播放状态。场景上下文有来源和有效期，只作为非可信观察数据，不会自动成为长期记忆或系统指令。服务端不提供 ARDY、TTS、动作动画、VRM 重定向或渲染实现。

### 如何启用

1. 在 WebUI“模型与分工”配置并测试模型，选择对话、Agent 和生活任务分工。
2. 在“角色档案”填写人格、世界观、表达与边界，启用角色扮演并保存，然后新建会话。
3. 在“记忆与关系”选择对应人格与用户，设置称呼和关系背景，审核记忆提议；需要稳定保留的信息可手动添加并固定。
4. 在“生活任务”配置状态、日程、日记和注入；需要自动运行时，明确启用该范围的后台调度，也可先手动生成并查看 Job。
5. 接入数字人时，通过 API 创建会话、提交对话或独立任务、订阅回复句段；完整流程见 [接入规范](packages/dw-executor/docs/protocol-v1.md)。

### 数据与能力边界

- 人格、记忆关系、生活资料及会话分别持久化；重启后继续读取，不依赖某个网页连接保存状态。默认数据目录为 `~/.dw-agent`。
- 删除会话不会删除共享人格、长期记忆、关系、日记或调度，也不会撤销工具已产生的文件和外部副作用。
- 遗忘和删除不是磁盘安全擦除；当前原生上下文、迁移备份和外部备份可能仍含旧内容，需要另行管理。
- 虚构活动、梦境、健康、天气和日记不能作为现实观察、医疗判断或任务完成证明；本项目没有操作系统进程沙箱。
- 设计参考 [memory_companion](https://github.com/menglimi/astrbot_plugin_memory_companion) 与 [private_companion](https://github.com/menglimi/astrbot_plugin_private_companion)，采用独立 TypeScript 实现，不是两个插件的逐项兼容复刻。不移植社交平台适配、群聊、主动消息和回复触发策略。

验证命令：`npm run test:dw`、`npm run check`。更完整的参数、权限、数据迁移和部署说明见 [执行器 README](packages/dw-executor/README.md)。

上游基线：`earendil-works/pi@698a2d23b86a5045dd54554354a5e0cb7e466795`。下面保留 Pi 上游说明。

---

<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md). Bundle them as [Pi packages](packages/coding-agent/docs/packages.md) and share via npm or git.

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or install a package that does it your way.

Use Pi [interactively](packages/coding-agent/docs/usage.md), automate it in [print or JSON mode](packages/coding-agent/docs/cli.md), control it over [RPC](packages/coding-agent/docs/rpc.md), or build apps with the [Pi TypeScript SDK](packages/coding-agent/docs/sdk.md). See [OpenClaw](https://github.com/OpenClaw/OpenClaw) for a real-world integration.

## Getting started

Install the command-line interface:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

On Windows:

```shell
powershell -c "irm https://pi.dev/install.ps1 | iex"
```

The installer pins all dependencies and updates Pi with `pi update`. Alternatively, install directly with npm, which does not pin transitive dependencies:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Pi requires Node.js 22.19 or newer. The macOS, Linux, and Windows installers can install it if needed. Pi does not require dependency lifecycle scripts for a normal npm installation.

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

For a built-in AI provider, run `/login` inside Pi to connect a subscription or API key. Then give Pi a task.

See the [documentation](https://pi.dev/docs/latest) for full setup and usage instructions, or [visit pi.dev](https://pi.dev) for demos.

## Run with Nix

```bash
nix run github:earendil-works/pi/stable
```

`stable` points at the latest release. Install it with `nix profile add github:earendil-works/pi/stable` and update with `nix profile upgrade pi`. Use a release tag such as `github:earendil-works/pi/v1.0.0` to pin a version, or `github:earendil-works/pi` for unreleased changes on `main`. Nix builds Pi from source.

Supports ARM64 and x86-64 on Linux and macOS. Use `nix build .` or `nix run .` to build or run your checkout.

Nix builds are offline, so the bundled model data comes from a pi.dev model catalog revision pinned in `nix/model-catalog.json`. At runtime, Pi still overlays newer catalog data from pi.dev as usual. The Nix workflow replaces the pin on `main` when it no longer matches the checkout, for example after a provider is added or gains a new model type. To refresh it by hand:

```bash
npm run update:model-catalog-pin
```

## Packages

This monorepo contains the Pi CLI and its supporting libraries.

| Package | Description |
|---------|-------------|
| **[@earendil-works/chord](packages/chord)** | Typed host runtime for hot-reloadable plugins, contracts, replicated state, and RPC over JSON links |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-durable](packages/durable)** | Durable conversation, task, and document runtime |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).  Longer term plans for Pi can also be found in [RFCs](https://rfc.earendil.com/keyword/pi/).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run check         # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-durable \
  --package @earendil-works/pi-agent-core
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @earendil-works/pi-agent-core \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release's `SHA256SUMS` file. Extract it and run the same build script used for the official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The archive includes release model data and native prebuilds. `--offline-model-data` uses that model data without refreshing provider catalogs. The script installs dependencies and builds the executable with its runtime assets; pass `--skip-install` if dependencies are already provided.

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent install lock.
- The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package does not pin transitive deps.
- Local release smoke tests and npm publication use the same tarball packer; npm publishes the validated tarballs rather than repacking workspace directories.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Install lock generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## Share your OSS coding agent sessions

If you use Pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## License

MIT

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
