# 变更记录

## 未发布

- Add confirmed deletion for failed/cancelled processing tasks, refreshing the
  list and badge without interrupting playback. Atomically reject stale deletion
  after a retry or completion; keep imported originals outside the job directory.
  Leave the existing general-purpose deletion API unchanged unless `failed_only`
  is explicitly requested.

- Add A-Z song/artist navigation and 24-item pagination to keep large libraries
  bounded, including the phone picker. Retain global pinyin search and queue
  behavior; add private frequent-played ranking from the signed-in account's
  retained, evidence-based playback history instead of invented popularity.

- Treat manual song skip as a request to play the next queue entry, including
  when the previous song was paused. An empty queue stops; stale/retried skips
  do not advance twice or override a later pause.

- Add manual lyric timing controls with precise line start/end fields, whole-song
  offsets, per-line or whole-song alignment to the current local playhead, preview,
  and timing reset. Move/stretch existing word timestamps with their lines and
  preserve draft text until save/cancel. Validate intervals, keep short rebuilt
  words within their line, and reject stale revision-aware saves without publishing.

- Start the first room queue entry automatically on an already-armed receiver,
  allow explicit player preparation before any song is queued, and retain
  manual pause when appending songs. Show per-device player/controller/microphone
  roles and receiving status without conflating browsers signed into one account.
  Presence is bounded and volatile; device labels never grant room privileges or
  enable remote microphone transport.

- Open a locally generated phone-remote QR dialog from the classic player's
  remote shortcut, retaining a direct-link fallback, keyboard focus handling
  and uninterrupted playback. The QR contains only the current site's remote
  URL; account authentication and room membership remain unchanged.

- Refresh the active player's lyrics when realignment or editing publishes a new
  version, including other account devices and the TV stage. Keep playback position,
  audio and microphone sessions intact; fence stale responses, retain unsaved edits,
  and retry transient lyric-load failures without reloading the song.

- 试唱、设备设置、播放历史及账号入口统一使用简体中文，包括页面说明、动态提示、
  无障碍标签、设备选择与错误信息；接口字段、用户自定义名称和现有设置保持不变。

- Follow both the person and the device for player settings. A signed-in account
  keeps portable defaults on the server while each browser keeps its own
  hardware overrides (microphone, feedback guard, output volume, input/output
  device), stored per account UUID in `data/user-state.sqlite3` with revisions
  so two devices cannot overwrite each other. New `/devices` names browsers,
  assigns roles, draws a local topology map and chooses the preferred player,
  which now decides where playback may start instead of silently claiming this
  device; new `/history` lists songs a validated player lease actually advanced
  through, per account, with explicit deletion only. See `docs/devices.md`.

- Restore the full home player in account mode instead of redirecting users to a
  controller with no audio receiver. Local playback, shared queue controls,
  lyrics, mixing and recording use the current room and exclusive player lease.
  Keep the original standalone behavior and make receiver-free remote/TV play
  actions explicit rather than presenting a silent room flag as playback.
  Commit range drags once, release playback on normal page exit or activation
  failure, restore first-song microphone monitoring, and require reactivation
  after the operating system suspends audio output.
- Redesign phone, lobby, library and TV layouts with compact account menus,
  expandable secondary controls, a desktop player sidebar and a two-column TV setup.
  Keep phone song-picking targets above the queue dock and TV activation visible on
  short displays; add real-browser responsive and account-menu keyboard regressions.
- 新增可选账号房间模式：验证私密代理跳点后的用户身份，每个账号只有一个当前房间，
  自动创建／恢复私人单人房；组队原子切换，退出回单人房，房主交接，结束房间时为成员
  分别准备单人房。用户昵称与演唱身份跨设备一致，不接纳浏览器自报身份或旧配对凭据。
- 账号部署首页进入当前房间，曲库维护保留在 `/library`；新增当前账号、当前房间及房主
  配对码更新接口。独立播放器和按设备配对保留在未启用账号集成的部署中。
- 新增 `/rooms` 聚会大厅：具名房间、可选展示、多人配对、成员在线状态、点歌归属与合唱名单。
  每个房间保留独立歌单，本机可保存多个房间并切换；退出配对与结束房间分开处理。
- 手机房主可允许电视以受限屏幕角色加入，不传递房主凭据；每房间仍仅有一个播放租约。
  电视切换先释放自己的租约并停止旧音轨，过期请求与歌词不能覆盖新房间。
- 老房间快照保持兼容且默认不在大厅展示；成功配对不再消耗失败配对的限流额度。
- 非交互提示不再遮挡点歌按钮，增加聚会入口后的经典导航在平板宽度自动换行。
- 更新桌面、手机、电视和录唱截图，新增日常使用说明书与公开截图生成说明；
  文档区分 `main` 开发界面与正式稳定版，统一实际按钮名称和证书路径示例。
- Chrome 回归使用独立短路径临时目录，避免深层 Linux CI 工作区导致套接字路径过长。
- 经典点歌台采用深色薄荷绿视觉、唱片装饰、紧凑封面列表与悬浮播放条；
  优化桌面 / 手机布局，封面按需加载，加载失败保留本地占位，不影响点歌。
- 按服务端、前端、worker、运维、部署和测试整理入口，增加程序与脚本索引。
- 新增 `python -m tools` 分类命令；证书、合成演示、离线对齐共用实现，旧脚本保留兼容入口。
- 测试迁到 `tests/python`、`tests/frontend`、`tests/browser`；统一运行器支持分组和文件选择，
  保留原有无参数命令，空匹配和未知选择不会假通过。
- 容器部署示例统一到 `deploy/deploy-openk.sh.example`。
- 演示任务使用有效 ID 与逐词格式，预检拒绝覆盖已有任务；证书 `--help` 不再生成文件，
  查看帮助不需要安装可选证书依赖。
- 离线切行、对齐支持嵌套歌词和音轨，成组发布 JSON / LRC；对齐默认预览，
  执行需 `--apply --offline`，不会向离线进程私有远程队列派单。
- 除重按实际登记音轨评估，支持独立任务目录；无法比较的整组保留，不按缺失质量信息删除。

## v1.0.0 — 2026-09-06

首个带版本标签的稳定发布；适用于可信网络或认证反向代理后的单 API 进程部署。

### 功能

- 新增电视舞台 `/tv`、手机点歌 `/remote` 和管理入口 `/admin`；共享房间、持久队列、
  原唱切换、遥控器焦点、播放租约与幂等控制。
- 经典与手机端统一搜索：歌名／歌手组合、全拼、首字母、繁简双向、宽字符与标点归一、
  相关度排序和输入法组词支持。
- 改善响应式布局、播放切换与录音归属；失败录音可重试或下载，后台操作不抢占正在演唱的歌曲。
- 曲库 ETag 与条件请求、API gzip、缓存失效和轻量轮询；音频 Range 不压缩。

### 稳定性与安全

- 任务原子去重、重试代次、取消传播；worker 独立心跳、超时监督、临时输入与隔离结果发布。
- 歌词重对齐异步执行，返回操作 ID；完成前保留旧歌词，重启后恢复跟踪。
- 修正字幕格式解析、源文件归档失败保留、非 root 镜像读权限和模型缓存目录初始化。
- `/media` 限制公开格式并隔离下载内容，阻止 SVG／HTML 缩略图成为同源可执行文档。
- 取消通配 CORS；跨来源修改请求在进入处理函数前被拒绝，额外可信来源必须显式配置。
- 部署示例参数化，口令不进入 Docker 参数；排除实际环境、凭据、证书和临时媒体文件。
- 全部文档截图改为可复现的合成演示素材。

### 升级注意

1. 等待处理队列和歌词操作空闲，备份数据目录、当前镜像摘要及 worker 代码。
2. 服务端与 worker 一起更新：新领取协议为 **v2**，旧 worker 会收到 HTTP 426，不能混用。
3. 歌词重对齐接口现在返回 **202 与操作 ID**；客户端应查询 `GET /api/operations/{id}`。
4. 原经典队列仍在浏览器本地，不会自动搬入共享房间。已有歌曲、音轨和录音保留。
5. 保持单 API 进程、正确的共享目录权限和持久卷；模型缓存可放在 worker 本地，
   长期媒体仍留在服务端。浏览器重新加载后可能需要再次明确启用声音。
6. TLS 代理应透传完整 Host；若后端不能正确识别外部来源，配置
   `OPENK_ALLOWED_ORIGINS=https://openk.example:8443`（替换为实际页面来源）。
   不应把通配 CORS 当作跨设备访问的前提。

`main` 镜像是滚动开发通道；正式 `vX.Y.Z` 标签才更新 `stable`／`latest`。
Fire TV 型号差异、实体麦克风权限与现场延迟需实机确认；参见
[电视指南](docs/tv.md)与[安全边界](SECURITY.md)。
