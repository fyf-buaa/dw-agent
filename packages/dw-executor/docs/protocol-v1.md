# dw-agent API v1：HTTP 资源与 WebSocket 订阅

本文描述当前源代码的公开契约，不是旧协议的适配层或未来方案。HTTP 路由以 `src/http-api.ts` / `src/management.ts` 为准，WebSocket 以 `src/protocol.ts` / `src/gateway.ts` 为准。下列报文是按该契约编写的示例，不是已经运行的测试记录。

- HTTP 基址：`http://127.0.0.1:17850/api`。
- WebSocket：`ws://127.0.0.1:17850/dw-agent/v1`。
- `api_version` 仍为字符串 `"1"`；WebSocket 命令的 `v` 为数字 `1`。
- HTTP [OpenAPI 3.1](../schemas/openapi.json) 与 [WebSocket JSON Schema](../schemas/protocol-v1.schema.json) 是机器可读参考。从 `packages/dw-executor` 执行 `npm run schema` 可重新生成两份文件。
- 所有创建、配置和业务操作走 HTTP。WebSocket **只有** `hello`、`subscribe`、`unsubscribe`，没有会话控制权、全局模式切换或业务写命令。

## 认证、权限和资源格式

除 `GET /api/health/live`、`GET /api/health/ready` 外，HTTP 请求使用 `Authorization: Bearer <token>`。POST/PUT/PATCH 使用 `Content-Type: application/json`，无参数的 POST 操作也发送 `{}`。GET/DELETE 不接受请求体。凭据不能出现在 URL、查询参数或浏览器地址栏中。远程部署应使用 HTTPS/WSS，并配置允许的 Origin；本机默认监听回环地址。同端口本机 WebUI 来源默认允许，其他浏览器来源需要白名单。

`GET /api/bootstrap` 返回：

```json
{"api_version":"1","socket_path":"/dw-agent/v1","principal":{"id":"root","permissions":["read","chat","execute","approve","manage"],"session_ids":null,"companion_scopes":null},"defaults":{"workspace_id":"default","execution_profile_id":"default","model_profile_id":"default","persona_id":"default","user_id":"local"}}
```

`GET /api/capabilities` 返回当前协议、HTTP、事件和功能支持。客户端不能因为某个配置存在就假定 provider 可用或存在 OS 进程沙箱。权限分别为 `read`、`chat`、`execute`、`approve`、`manage`，并在具体会话、任务、审批、后台作业和事件流上再次检查资源范围。`session_ids:null` / `companion_scopes:null` 表示不限制；空数组表示没有该范围。会话和 companion 两种范围同时适用。限定了会话集合的令牌不能创建集合之外的新会话。

令牌管理是额外限制：`/api/tokens` 的 GET/POST 和 `/api/tokens/{id}` 的 DELETE **只允许 bootstrap 身份 `principal.id === "root"`**。受管令牌即使具有 manage 也不能列举、创建或吊销令牌，不能通过管理权限转授其他范围。

`persona_id + user_id` 是长期记忆、关系、日程和日记的分区键。`user_id` 不从 client_id、连接或 session_id 推导；默认 `local`，人格和用户标识使用 1–100 位字母、数字、下划线或连字符。它不是完整账号系统，访问隔离来自令牌权限和范围。

通常成功资源是：

```json
{"id":"opaque-id","revision":1,"created_at":"2026-10-18T00:00:00.000Z","updated_at":"2026-10-18T00:00:00.000Z","data":{"title":"示例"}}
```

`id` 是不透明字符串，不解析其内部结构。资源外层时间为 UTC RFC3339；保留的 companion/life `data` 内部时间沿用毫秒时间戳，不要混淆。原生配置视图的初始 `revision` 可以是 `0`。列表为 `{items:[完整资源],next_cursor:null|string}`；persona 列表另外返回 `errors`、`editable`、`roleplay_defaults`，记忆列表另外返回 `total`。

列表游标是不透明的、绑定资源种类/过滤条件的字符串，不是数字偏移量，也不是事件序号。原样保留 `next_cursor`，下一页沿用相同过滤条件。常规列表 `limit` 为 1–200，记忆最多 100，日记最多 60。即使某页因授权过滤而 `items:[]`，只要 `next_cursor` 不为空仍应继续翻页。GET 也可使用 HEAD；已实现路由支持 OPTIONS 返回允许的方法。

### 幂等、修订号和错误

所有 POST 必须携带 `Idempotency-Key`（1–200 位字母、数字、`_ . : -`）。客户端保留原 method/path/query/body/key，网络中断时重发原请求，不能换 key 来“重试”不确定的创建或操作。会话和执行类操作在发送前持久化；含凭据的管理请求只能保留在内存或受保护的凭据存储中，不把秘密写入普通传输状态文件，丢失请求后先查询资源核对结果。key 按 principal 隔离；相同 key 改变请求内容会冲突。断开 HTTP 或 WebSocket **不会**取消服务器工作。

重复资源 POST 返回同一资源的**当前**状态，不承诺重复响应字节完全一致；已经删除或忘记的资源不会从旧响应缓存复活。持久化意图在重启后若无法确认完成，明确报中断，不自动再运行模型或工具。令牌创建是特殊情况：明文只返回一次，相同 key 再次请求返回 `TOKEN_ALREADY_ISSUED`，不能找回或重新生成秘密。

配置 PATCH 携带所编辑资源的 `expected_revision`；DELETE 将其放在 query 中，例如 `DELETE /api/sessions/ID?expected_revision=3`。MCP PUT、provider/model PATCH 用 `expected_revision:null` 创建、当前正整数修订号更新。companion 状态、生活配置、条件等保留各自的原生修订号；编辑生活配置用 `data.settings.revision`，编辑生活条件用 `data.state.revision`。冲突后重新读取并由用户决定，不盲目覆盖。

服务器生成权威 `X-Request-Id` 响应头；错误响应也带 `request_id`。请求体不要求 `request_id`。客户端可以发送跟踪用的 `X-Request-Id`，但它不是业务去重 key 或服务器确认 ID。

```json
{"error":{"code":"REVISION_MISMATCH","message":"Refresh the resource before saving","retryable":true},"request_id":"server-request-id"}
```

错误 HTTP 状态包括 400 输入/游标错误、401 未认证或令牌失效、403 权限/范围不足、404 不存在、405 方法不支持、409 修订/幂等/忙状态冲突、410 游标历史过期、413 超限、415 媒体类型错误、500 安全内部错误、503 服务不可用。`retryable` 不授权客户端隐式重复推理。响应不包含 provider 密钥、私密推理或原始工具输出。

## HTTP 会话、聊天和后台执行

下表路径均相对 `/api`。创建通常返回 201；聊天/任务/作业准入及暂停、恢复、取消返回 202；其他操作为 200（presentation、生活条件创建也为 201）。202 只是接受操作，不是完成或安全边界已经到达。

| 方法与路径 | 契约 |
|---|---|
| GET、POST `/sessions` | 列表 / 创建会话 |
| GET、PATCH、DELETE `/sessions/{id}` | 读取、修改标题/配置引用、删除 |
| GET、POST `/sessions/{id}/messages` | 可见消息历史 / `{text}` 创建前台 Run |
| GET `/runs/{id}` | 前台 Run 当前状态 |
| POST `/runs/{id}/cancel` | `{}` 显式取消前台 Run |
| GET `/tasks?session_id=...` | 可分页任务列表 |
| POST `/sessions/{id}/tasks` | `{input,workspace_id?,execution_profile_id?,model_profile_id?}` 创建后台任务 |
| GET `/tasks/{id}` | 任务当前状态 |
| POST `/tasks/{id}/pause`、`resume`、`cancel` | `{}` 显式生命周期操作 |
| GET `/tasks/{id}/tool-calls` | 结构化工具历史 |
| GET `/approvals`、`/approvals/{id}` | `approve` 权限；列表可按 session_id/task_id/status 过滤 |
| POST `/approvals/{id}/decision` | `{decision:"approve"或"deny",expected_revision}` |
| GET `/tools?workspace_id=...&execution_profile_id=...` | 实际工具名/参数、是否允许、是否需审批及隔离方式 |
| GET `/sessions/{id}/events?after_seq=0&limit=100` | 单会话事件回放 |
| GET `/events?stream_id=...&after_seq=0&limit=100` | 已授权的任意事件流回放 |

创建会话示例（实际请求契约，示例值不是服务器生成结果）：

```http
POST /api/sessions
Authorization: Bearer <token>
Idempotency-Key: create-session-7bd8
Content-Type: application/json

{"persona_id":"default","user_id":"local","workspace_id":"default","execution_profile_id":"default","model_profile_id":"default"}
```

省略这些引用时使用 bootstrap 默认值。不能把客户端任意 `cwd` 作为会话创建参数；工作目录来自注册 workspace。会话 `data` 包含 persona_id/user_id/persona_revision/title/workspace_id/execution_profile_id/model_profile_id/active_run_id。人格版本和用户在会话中冻结，不通过 PATCH 换人格或记忆分区。

消息 `data` 包含 session_id、`role:"user"|"assistant"`、text，以及可选 speech/segments/run_id/task_id。前台 Run 为 queued/running/completed/failed/cancelled；同一会话只允许一个未完成前台 Run。后台任务为 queued/running/awaiting_approval/paused/completed/failed/cancelled，使用独立原生执行历史，可以与聊天同时进行，不通过“切换到 agent 模式”劫持聊天上下文。任务冻结创建时的人格、workspace、execution profile 和 model profile；聊天只接收有界、非可信的任务摘要。

pause 返回 `pause_requested:true` 不代表已经暂停，需等待持久化的 `task.paused` 或查询状态。cancel 同样不能撤销已发生的外部效果。审批绑定一次确切工具调用、参数哈希和执行范围；拒绝、过期、取消或重启不产生隐式许可。`trusted_host` **所有调用**均需逐次精确批准，包括名为 read/write 的调用及 approval:"never" 的配置，避免扩展冒用安全内建工具名称。`restricted` 仅对已知、受守卫的文件工具执行 always/writes/never 策略，不是通过 cwd 或 shell 正则表达式构造的 OS 沙箱。

文件守卫同时保护执行器 dataDir 与 agentDir；workspace 不得位于这些受保护根目录内，workspace 中的受保护子树同样不可通过文件工具访问。受限工具的路径、链接和文件身份检查不是对敌对宿主进程目录重命名竞态的强隔离；`process_sandbox:false`，不能宣称提供 OS 进程沙箱。

重启后未完成前台 Run 失败并标明中断，未完成任务转为 paused，未完成后台 Job 取消并标明 `JOB_INTERRUPTED`。恢复任务必须是显式 HTTP 操作；已完成工具不因为连接重连而重派。

删除会话要求当前 revision 且没有未完成任务/前台运行。删除会话不会删除共享 companion 分区。`session.deleted` 保留在独立事件日志中，不随会话原生日志被删除。客户端收到删除事件或读取该会话的 404 后，丢弃所选 ID、该流游标和该会话待发请求，不自动重建或附加同一 ID；其他流继续工作。

## 场景上下文与播放反馈

`PUT /sessions/{id}/scene-context` 是有来源、时间、有效期的**非可信数据**，不是可执行提示词，也不写成长期记忆。上限 32 KiB、100 个对象，所有对象 ID 必须在 `allowed_object_ids` 内且不能重复；对象只接受 id/label/description/position，坐标必须是有限数值。有效期不超过五分钟，不接受已过期或明显未来采集时间。

```json
{"expected_revision":null,"version":1,"source_client_id":"godot-local","captured_at":"2026-10-18T12:00:00.000Z","expires_at":"2026-10-18T12:01:00.000Z","allowed_object_ids":["door"],"objects":[{"id":"door","label":"房门","position":{"x":1,"y":0,"z":2}}]}
```

`POST /sessions/{id}/presentation-events` 接收实际已属于该会话的 segment_id：

```json
{"segment_id":"segment-id","status":"started","occurred_at":"2026-10-18T12:00:01.000Z"}
```

先 started，再 completed/interrupted/failed；终态不能再改变，时间不能倒退，可选 error_code 是安全标识。相同状态重复报告返回已存在资源。渲染器负责动画、语音和实际播放调度，服务器不会因为收到 reply.segment 就假定已经播放。

## 回复句段

模型输出语法：

```text
<segment><expression>{"description":"轻轻点头","language":"zh-CN"}</expression><speech>"你回来啦。"</speech></segment>
```

`expression` 是 `{description,language}`。description 必须非空、最多 1000 字符，不含 ASCII/全角括号、标记、代码、工具调用或私密推理；language 是语言标签，不硬绑定英语或动画引擎。speech 是普通角色台词的 JSON 字符串。公开 `ReplySegment`：

```json
{"message_id":"message-id","segment_id":"segment-id","index":0,"expression":{"description":"轻轻点头","language":"zh-CN"},"speech":"你回来啦。","text":"（轻轻点头）你回来啦。","task_refs":[]}
```

`text` 确定性等于 `（${description}）${speech}`。索引从 0 递增，segment_id 是稳定播放去重键；task_refs 只是相关任务引用，不是允许执行工具的指令。普通文字界面显示 text，3D 客户端分别消费 expression 和 speech。服务器只发布完整且验证通过的句段，不转发原始模型 delta，不为无效新输出虚构表情，也不自动追加格式修复请求。

启用角色扮演时，最后一个完整 segment 后仍可有一次服务端内部 `<companion>...</companion>` 控制块。它不属于 speech 或 expression，不向客户端暴露。记忆提议需有证据并保持 pending，供所有者批准。忘记具有防重放语义，但不宣称物理擦除历史原生 JSONL。角色日程、身体状态和天气背景是虚构数据，不是现实观察。

## WebSocket：认证与多流订阅

一个 UTF-8 text message 对应一个 JSON 对象，上限 1 MiB，不接收二进制。连接后五秒内发送 hello。服务端默认每 20 秒 ping，60 秒未收到 pong 断开；Godot WebSocketPeer 负责协议级 ping/pong，应用需要持续 poll。

```json
{"v":1,"type":"hello","id":"hello-1","payload":{"client_id":"godot-local","token":"<private-token>","versions":[1]}}
```

```json
{"v":1,"type":"hello.accepted","reply_to":"hello-1","payload":{"version":1,"capabilities":["events.replay","events.multisubscriber"],"max_message_bytes":1048576}}
```

client_id 跨重连保持不变，不承担资源所有权或 token 身份。hello 成功后可以同时订阅多个流，同一个流允许多个客户端独立订阅，彼此不会踢下线。每连接最多 128 个流：

```json
{"v":1,"type":"subscribe","id":"sub-session-1","payload":{"stream_id":"session:SESSION_ID","after_seq":42}}
{"v":1,"type":"subscribe","id":"sub-companion-1","payload":{"stream_id":"companion:default:local","after_seq":0}}
{"v":1,"type":"unsubscribe","id":"unsub-1","payload":{"stream_id":"companion:default:local"}}
```

流为 `session:ID`、`companion:PERSONA:USER`、`system`。system 要求 manage，其余流按资源范围鉴权；失效/撤销令牌的连接以 4001 关闭，应等待更正凭据，不持续重连。

```json
{"v":1,"type":"subscription.accepted","reply_to":"sub-session-1","payload":{"stream_id":"session:SESSION_ID","after_seq":42,"latest_seq":45}}
{"v":1,"type":"subscription.removed","reply_to":"unsub-1","payload":{"stream_id":"companion:default:local"}}
{"v":1,"type":"command.rejected","reply_to":"bad-command","payload":{"error":{"code":"INVALID_PAYLOAD","message":"Invalid subscribe payload","retryable":false}}}
```

这些确认消息没有 `id` 或持久化 seq。正常确认的 reply_to 必填；command.rejected 在原输入尚无可信 ID 时可省略 reply_to。回放事件可以出现在 subscription.accepted 之前；确认中的 latest_seq 不是客户端已经处理的游标。

持久化事件采用不同的封装：

```json
{"api_version":"1","event_id":"event-id","stream_id":"session:SESSION_ID","seq":43,"type":"reply.segment","occurred_at":"2026-10-18T12:00:00.000Z","session_id":"SESSION_ID","run_id":"RUN_ID","data":{"message_id":"message-id","segment_id":"segment-id","index":0,"expression":{"description":"轻轻点头","language":"zh-CN"},"speech":"你回来啦。","text":"（轻轻点头）你回来啦。","task_refs":[]}}
```

可选关联字段为 session_id/run_id/task_id。reply.segment 的 data 是权威的完整 ReplySegment；消息更新和 run/task 生命周期使用有界的 ID、revision、状态通知，不重复累计正文、历史或大结果。需要完整当前状态时使用通知中的 ID 调用规范 HTTP 读取接口；这也避免长回复把单帧推到 1 MiB 以上。常用类型：

| 类型 | data |
|---|---|
| session.created / session.updated | Session 资源 |
| session.deleted | `{id}`；之后不再选择该会话 |
| message.created | 有界的 Stored 用户消息（输入最多 65536 字符） |
| message.updated | `{message_id,revision,session_id,status:"streaming",role:"assistant"}`；按会话消息历史刷新，不把通知当正文 |
| run.started / run.completed / run.failed / run.cancelled | `{id,revision,session_id,status,usage?}`；GET `/runs/{id}` 获取完整当前资源 |
| task.created / task.running / task.awaiting_approval / task.paused / task.completed / task.failed / task.cancelled | `{id,revision,session_id,status,pause_requested?,cancel_requested?,usage?}`；GET `/tasks/{id}` 获取完整当前资源 |
| reply.segment | ReplySegment，不是另一份命令 |
| tool.started / tool.finished | 结构化 ToolCall 资源 |
| scene.updated / presentation.updated | 对应资源 |
| approval.pending / approved / denied / expired / cancelled / consumed | `{approval_id,task_id,session_id?,status,revision}`；GET `/approvals/{id}` 获取确切参数、哈希、范围和当前状态，不在通知中传输大参数 |
| job.changed | job_id/revision/status/cancel_requested/usage；GET Job 获得结果 |
| schedule.changed / schedule.removed | companion 调度登记变化 |
| 其他 companion/life 变化 | 原生算法持久化变化通知；按对应 HTTP 资源刷新 |

### 至少一次交付和游标恢复

每个流有独立、严格递增 seq。按 `(stream_id,seq)` 去重，保存最后**连续且已应用**的游标；多个流不能共用一个 last_seq。收到重复 seq 可忽略，收到跳号不能直接更新游标，应重连并从原游标回放。额外使用 segment_id 防止重复播放。HTTP 事件页返回 `{items,has_more,latest_seq}`；与资源列表的 next_cursor 不是同一种游标。

服务器在订阅回放前登记实时发布，不在“回放结束”和“实时开始”之间留空隙。断开连接不停止运行，重新连接只恢复订阅。背压可用 1013 关闭；客户端退避后从保存游标重连。

历史因删除/隐私清理被清除时，旧 after_seq 返回 `CURSOR_EXPIRED`，details 包含 `earliest_seq`、`latest_seq`。不能假装历史完整，也不能直接把 latest_seq 当作已消费值。先 GET 对应的规范资源并替换本地视图；会话 404 即丢弃该选择和待发操作。资源仍在时，以 `earliest_seq - 1` 为新回放起点（清理后的边界），之后仍按连续 seq 去重。删除通知位于保留边界之后，可被重放。system 通知流的当前快照是对应管理资源集合，需要应用端刷新实际使用的列表。

## 人格、长期生活和管理资源

| 路径（相对 /api） | 方法 / 内容 |
|---|---|
| `/personas`、`/personas/{id}` | GET/POST、GET/PATCH；POST `{id,system_prompt,roleplay?}`，PATCH 使用外层数值 expected_revision |
| `/companions/{persona}/{user}` | GET，保留原有 profile/config 字段于 data |
| `.../state` | PATCH 关系/情绪/用户称呼/关系背景/重要日期，expected_revision |
| `.../memories`、`.../memories/{id}` | GET/POST、GET/PATCH；列表 q/status/kind/limit/cursor；PATCH operation approve/archive/restore/forget/pin/unpin/correct |
| `.../recall?q=...` | GET，只预览 core 和 ranked items，不记录一次真实 provider 召回 |
| `.../life`、`.../life/settings` | GET、PATCH `{expected_revision,config}`；保留完整分组和结构化表单字段 |
| `.../life/advance` | POST `{}`，显式推进虚构状态 |
| `.../life/conditions`、`.../life/conditions/{id}` | POST `{expected_revision,label,duration_hours?}`；PATCH `{expected_revision,operation:"remove"}` |
| `.../life/plan` | GET，data 为当前 LifePlan 或 null |
| `.../diaries`、`.../diaries/{date}` | GET、GET/DELETE；DELETE 使用 expected_revision |
| `.../schedule` | GET/PATCH/DELETE；PATCH `{enabled,expected_revision}` 显式登记后台调度，DELETE 移除登记 |
| `.../jobs` | POST `{kind:"plan"或"diary"或"detail",force?,expected_revision?}`，返回202 Job |
| `/jobs`、`/jobs/{id}`、`/jobs/{id}/cancel` | GET 列表/单项、POST 显式取消；列表支持 companion_scope/session_id/status/kind |
| `/providers`、`/providers/{id}` | GET、PATCH/DELETE；密钥只写入，响应只有配置/认证存在性 |
| `/models`、`/providers/{provider}/models/{id}` | GET、PATCH/DELETE；路径 model id 是原生名称的百分号编码，不是 catalog opaque id |
| `/model-profiles`、`/model-profiles/{id}` | GET/POST、GET/PATCH/DELETE；name 和独立 chat/agent/life 选择 |
| `/model-tests` | POST `{provider,model,thinking_level?,api_key?}`，返回202 Job；输入密钥不写进 Job |
| `/workspaces`、`/workspaces/{id}` | GET/POST、GET/PATCH/DELETE；注册现有 root，不允许请求任意目录 |
| `/execution-profiles`、`/execution-profiles/{id}` | GET/POST、GET/PATCH/DELETE；精确工具允许列表、审批、并发/调用/时间预算、隔离模式 |
| `/tokens`、`/tokens/{id}` | **仅 bootstrap root 身份**；GET/POST、DELETE；名字/permissions/可选范围/未来 expires_at，明文仅显示一次；manage 不足以授权 |
| `/mcp/servers`、`/mcp/servers/{id}` | manage；GET、GET/PUT/DELETE，保留原生 transport/exposure 配置且不回传秘密 |
| `/mcp/servers/{id}/reconnect` | POST `{}`，真实重连并获取实际状态/工具 |
| `/mcp/servers/{id}/authorization` | POST `{}` / GET / DELETE，真实原生 OAuth 状态 / 本地退出 |
| `/mcp/servers/{id}/authorization/complete` | POST `{redirect_url}`，原生验证 state/PKCE/redirect |
| `/extensions`、`/extensions/{id}`、`/skills`、`/skills/{id}` | manage；GET 列表、PATCH `{expected_revision,enabled}`，仅已安装且可信目录发现的资源 |
| `/resources/reload` | manage；POST `{}`，仅空闲重载，忙时冲突，不暗中取消任务或远程安装包 |

model profile 每个角色为 `{provider,model,thinking_level?,max_output_tokens}`。未提供角色继承 default，PATCH 角色部分合并，thinking_level:null 清除设置。读取额外返回 declared/configured/effective_max_tokens、context_window、available；有效输出预算是模型声明、配置和上下文限制的最小值，没有统一 65536 硬编码上限。默认 profile 修改前可跟随已有全局选择，显式修改后独立保存。

MCP 响应的 env/headers/args 和 OAuth clientSecret 被隐藏，secret_fields 说明存在的秘密字段；同一 transport 更新省略秘密可保留，env:null / headers:null 显式清除对应 map。认证 URL 是受管理的短期授权流程，不是把 API token 放入 URL。退出只声明删除本地凭据，`remote_revocation_supported:false` 不宣称已远程吊销。安装资源重载不使执行策略失效。

## Godot 4 示例客户端

[`examples/godot/dw_agent_client.gd`](../examples/godot/dw_agent_client.gd) 是实际 HTTPRequest/WebSocketPeer 传输实现，不包含旧业务 WS 命令。将节点加入树后调用 connect_executor(token)，客户端先通过 bootstrap 校验身份，再派发业务请求和建立事件订阅，每帧 poll 保持连接。HTTP 使用独立、非阻塞 HTTPRequest 节点，有限并发、超时、完成后释放；网络失败自动退避重发原请求并沿用原 key，明确 HTTP 成功/错误通过 http_completed/http_failed 返回。

以下是使用当前客户端的接线示例，尚不是执行记录：

```gdscript
extends Node

var executor := DwAgentClient.new()

func _ready() -> void:
    add_child(executor)
    executor.http_completed.connect(_on_http_completed)
    executor.reply_segment.connect(_on_reply_segment)
    executor.session_deleted.connect(_on_session_deleted)
    executor.connect_executor(OS.get_environment("DW_AGENT_TOKEN"))

func _on_http_completed(request_id: String, status: int, _resource: Variant) -> void:
    print("HTTP ", request_id, " status=", status)

func _on_reply_segment(_session: String, _run: String, segment: Dictionary) -> void:
    # 接入应用自己的语言、表情和播放编排消费者。
    print(segment.text)

func _on_session_deleted(_id: String) -> void:
    executor.list_sessions()
```

完整操作通过 request(method,path,body,owner_session_id) 访问真实 HTTP 路由；便利方法包含 create_session、select_session、submit、create_task、task_action、cancel_run、decide_approval、put_scene、report_presentation、get_history、subscribe_companion。workspace/profile 用服务器注册 ID，模型配置不通过客户端全局 mode 控制。请求返回本地关联 ID，不是服务器 X-Request-Id、Run ID 或 Session ID。

event_received 原样发布轻量通知，不把 message/run/task 通知伪装为完整资源。应用需要当前详情时用 `executor.request("GET", "/api/runs/" + run_id.uri_encode())`、`/api/tasks/{id}` 或 `get_history()`；实时句段仍只消费 reply_segment，避免把 HTTP 历史再次当作待播放增量。

客户端状态按 base_url 和已认证的 principal 绑定，保存 client_id、会话选择、每流游标，以及会话/run/task/approval 待确认写操作的原 method/path/序列化 body/key；不保存 Bearer token。可能含 provider/MCP 秘密的配置请求只在内存排队，不写入状态文件。该文件仍包含用户文本，应按私有应用数据保护。重新认证得到不同 principal 时停止派发，不能把旧 pending 请求迁移到另一身份；换服务器或身份用新 state_path。写入失败时停止派发，避免不安全重放。收到删除事件/会话404后清理相应选择、订阅和待发请求；删除事件可能先于 HTTP 确认到达，应用应处理 session_deleted，而不是始终等待原删除请求回调。

CURSOR_EXPIRED 触发 replay_reset_required；客户端自动 GET session/companion 规范快照，先发出 http_completed 让应用应用快照，再恢复到保留边界。system 流由应用刷新其管理列表后调用 resume_subscription_after_snapshot(stream_id)。若快照获取失败，保持该流暂停，不偷偷跳过数据。没有过期的流继续用各自最后连续 seq 重放，多订阅之间互不影响。
