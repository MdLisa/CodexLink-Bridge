# 0.3.0 设备绑定补充

所有登录与任务请求必须按 DEVICE_SECURITY.md 提供设备签名。旧 token 不再可用；新设备先由电脑人工批准。下面保留聊天接口说明。

# 0.3.0 设备绑定补充

所有登录与任务请求必须按 DEVICE_SECURITY.md 提供设备签名。旧 token 不再可用；新设备先由电脑人工批准。下面保留聊天接口说明。

# 安卓客户端接口 · v0.1.0

基址由电脑提供，例如 `http://电脑内网IP:18766`。JSON 使用 UTF-8。除健康检查和登录外，所有 HTTP 请求使用 `Authorization: Bearer <手机凭据>`。不要把凭据放到 URL 或日志中。

## 接口表

| 方法及路径 | 输入或用途 |
| --- | --- |
| GET `/health` | 无需登录；`ready` 是后台是否连上 Codex，不代表模型网络已验证 |
| POST `/api/login` | JSON `{username,password,deviceName}`；201 返回 `{device:{id,name},token}`，手机安全保存 token |
| GET `/api/status` | online、允许目录、能力、当前设备和待处理授权/提问列表 |
| GET `/api/devices` | 本机设备身份的已登录连接列表 |
| DELETE `/api/devices/:id` | 撤销本机设备身份的连接，禁止管理其他手机 |
| GET `/api/threads?cursor=…` | 最近聊天列表，仅返回允许目录内的聊天，附 nextCursor |
| POST `/api/threads` | JSON `{cwd?,name?}`；201 返回聊天，cwd 默认首个允许目录 |
| GET `/api/threads/:id` | 聊天元数据；control 为 bridge 或 readOnly |
| GET `/api/threads/:id/history?limit=20&cursor=…` | 历史 turns，由新到旧分页；items 按聊天内顺序，nextCursor 用于更早记录 |
| POST `/api/threads/:id/acquire` | 接管已有聊天；发送消息时也会自动接管 |
| POST `/api/threads/:id/release` | 所有手机任务结束后交回桌面；回收自己的 Codex 连接，释放全部空闲聊天 |
| POST `/api/threads/:id/messages` | JSON `{messageId,text?,attachmentIds?}`；202 返回 `{job,duplicate}` |
| GET `/api/threads/:id/jobs` | 此聊天最近 100 个手机任务 |
| GET `/api/jobs/:id` | 单个任务当前状态 |
| POST `/api/jobs/:id/cancel` | 停止任务；队列中取消不会发给 Codex |
| POST `/api/uploads` | 原始图片字节，最大 10 MiB，PNG/JPEG/WebP/GIF；201 返回 `{id,mime,size,sha256,url}` |
| GET `/api/uploads/:id` | 带身份验证读取已上传图片 |
| POST `/api/requests/:id/respond` | 授权或提问回答，见下文 |

JSON 请求必须带 `Content-Type: application/json`。消息 text 最长 64000 字符，attachmentIds 最多 8 张。图片签名检查用于过滤明显错误的格式，图像解码由 Codex 处理。客户端应压缩大图，避免原图超限。

messageId 推荐 UUID，允许 8～128 位字母、数字、下划线、点、冒号和短横线。发送前生成并保存，超时后用**相同编号及内容**重试。相同编号但内容不同返回 409。此机制跨后台重启保留。

job 字段：`id,threadId,messageId,state,turnId,error,createdAt,updatedAt`。state：`queued / starting / running / waitingApproval / completed / failed / interrupted / cancelled / needsReview`。needsReview 表示执行结果不确定，刷新历史后由用户判断，客户端不可自动生成新编号重做。

历史返回 `storedStatus` 仅描述存档状态，不能当作当前正在运行的状态。实时状态使用 jobs 和 `/api/status`。当前历史图片条目只有附件占位；手机上传的图片可用自己的上传记录访问。未接入任意结果文件下载接口。

## 实时连接

连接 `ws://电脑内网IP:18766/events`。正式外网入口使用 `wss://`。连接后 5 秒内发送：

```json
{"type":"auth","token":"手机凭据","after":123}
```

after 是已处理的最后 seq，首次为 0。也可以使用握手 Authorization 请求头，但需要补传恢复位置时用首条消息认证。URL 禁止 query，不能放 token。

认证前不发送事件。认证后先补发保留的历史事件，再发送 `{type:"authenticated",data:{deviceId,lastSeq}}`。事件结构 `{seq,type,data,time}`；客户端保存最大 seq，重连时忽略已处理的重复事件。

- `job.updated`：data 为 job。
- `thread.event`：data 包含 method、threadId，及 turnId/itemId/delta/item/turn/error 等适用字段。method 包括 `item/agentMessage/delta`、`item/commandExecution/outputDelta`、`item/started`、`item/completed`、`turn/completed`、`error`。
- `request.created`：待授权或提问。
- `request.resolved`：请求已经完成、过期或随任务结束撤销。
- `thread.released`：聊天已释放。
- `server.status`：online；交接期间暂时 false。

重连后读取 `/api/status`、当前聊天 jobs 和 history，重建界面。进度仅保留约 5000 条；若返回 `refresh.required`，执行完整刷新。不得只凭恢复事件判断当前仍有授权等待。

服务发送 WebSocket ping，原生库需自动 pong。客户端也可发 `{"type":"ping"}` 获取 pong。连接失效不表示任务已停止；按原 messageId 查询或重试。

## 授权和提问

request.id 是桥接生成的随机编号，不暴露底层请求 ID。显示请求的 command、cwd、reason、changes、additionalPermissions 等已有字段，再由用户选择。

命令或文件授权请求的 method 是 `item/commandExecution/requestApproval` 或 `item/fileChange/requestApproval`。POST 回答：

```json
{"decision":"accept"}
```

仅接受 accept（允许本次）、decline（拒绝）、cancel（取消）。不提供永久允许或会话全部允许。

`item/tool/requestUserInput`：按 questions 展示问题，POST：

```json
{"answers":{"question-id":{"answers":["用户选择或填写的内容"]}}}
```

每个问题必须有 answers 数组。其他尚未实现的底层请求会明确拒绝，不静默放行。

## 错误处理

错误统一 `{error:{code,message}}`。401 重新登录；403 目录或来源被拒绝；409 提示聊天占用、消息编号冲突、请求已结束、任务正在启动或还有待完成任务；413 图片过大；415 格式不支持；429 登录错误过多；503 后台断开或正在交接，稍后刷新。

`THREAD_BUSY` 时保持原聊天和未成功发送内容，提示用户释放桌面占用后重试；不要新建副本。`TASK_PENDING` 的交回请求需要所有手机任务结束或停止。`TASK_STARTING` 停止请求需要稍后再试。

安全边界：不提供任意原始 RPC、任意上传路径、远程修改代理和远程停止服务。`/admin/stop` 是本机管理程序专用，手机凭据无权使用。

## Image references (0.3.1)

Historical and live user-message image parts include `image: {id, mime, size, available}` for existing bridge uploads. Local file paths and remote image URLs are not returned. Unknown/unmapped images use `{available:false}`. Read image bytes with the existing device-authenticated and signed `GET /api/uploads/{id}` endpoint; missing or invalid cached images return JSON HTTP 404. Arbitrary filesystem paths are not accepted.

## Generic files (0.4.0)

Device-signed POST /api/files?id=<UUID>&name=<filename>&mime=<MIME> accepts up to 10 MiB of raw bytes. The signed query binds metadata to the body. An identical retry returns the existing ID; conflicting content is rejected. Files are stored beneath the configured directory in separate UUID folders. POST /api/threads/{id}/messages accepts optional fileIds alongside attachmentIds (maximum 8 combined). Saved local paths are included in the Codex input; authenticated history and live user-message views expose safe files metadata cards instead of the generated path manifest. No generic arbitrary-path download API is added.

## Per-device project access (0.5.0)

`GET /api/status` adds `capabilities.perDeviceProjects: true` and `projectAccess: {mode: "directories" | "all", roots: string[], revision: string}`. `workspaces` contains that device's configured roots, or the server's default workspace suggestions in `all` mode. A changed revision invalidates client catalog, selected-thread and image caches. Existing clients retain server-side enforcement.

The policy is stored by approved public-key fingerprint and account generation, independent of login token/session IDs. Existing devices snapshot the previous global roots. New devices default to those roots; unlimited access requires explicit local configuration. All chat operations, task lookup/cancellation and approval responses check the requesting phone's current policy, including already-loaded threads. Policies control chat project directories; they do not replace the Codex execution sandbox or global approval reviewer.

Live and replayed events are filtered using a persisted workspace attribution; unattributed legacy chat events are omitted and clients refresh canonical history. Policy updates send a neutral `access.changed` event and close affected sockets with code `4009`; clients reconnect without discarding credentials. Status exposes only approval requests in permitted projects. Devices API lists and revokes only sessions sharing the caller's device identity.

Attachment uploads record their device identity. Before submission, only that device can use them. Once linked to chats, access follows permitted chat directories, including when an attachment ID is known. Legacy images acquire chat attribution when their authenticated history is read; unattached legacy images are denied. No arbitrary-file download endpoint is introduced.

Local management only: `POST /admin/project-access`, loopback source plus `x-bridge-admin`, JSON `{fingerprint,generation,mode,roots}`. Paths must be existing absolute directories and are canonicalized; up to 32 directories, no empty restricted scope. `all` requires an empty roots array. Out-of-scope running tasks return `409 TASK_PENDING` without saving. Out-of-scope queued jobs are failed, and queued jobs recheck current policy before execution. Legacy queued jobs without device attribution become `needsReview` after migration. The phone has no policy-write API.
