# 程序与脚本索引

按职责组织 OpenK 仓库；这里不搬迁部署数据、不运行维护或重启服务。
所有命令从仓库根目录执行，`python` 应指向项目虚拟环境。
日常点歌和录唱请先阅读[使用说明书](user-guide.md)。

## 程序分类

| 分类 | 位置 / 入口 | 运行位置与职责 |
| --- | --- | --- |
| Web / API | `backend/`；`./run.sh` 或 `python -m backend.main` | NAS / 服务主机；曲库、下载、房间、队列、媒体、录音和 worker API |
| 浏览器客户端 | `frontend/` | 由同一个 API 服务提供静态文件，无前端构建步骤 |
| 经典点歌 / 管理 | `frontend/index.html`、`app.js`、`styles.css` | `/`、`/admin` |
| 电视 / 手机 | `tv.*`、`remote.*`、`room-client.js`、`stage.css` | `/tv`、`/remote`；共享房间与播放状态 |
| 共用搜索 / 依赖 | `frontend/search.js`、`frontend/vendor/` | 经典端和手机端复用搜索，第三方文件保留署名 |
| 远程推理 | `worker/openk_worker.py` | 算力机；`python worker/openk_worker.py`，主动领取任务 |
| 内部处理 | `backend/steps/`、`backend/remote/` | 由 API / worker 调用；`align_runner.py` 是监督子进程，不是日常维护命令 |
| 运维工具 | `tools/`；`python -m tools` | 下表按在线 / 离线分类；选择命令后才加载实现 |
| 自动化 / 兼容 | `scripts/` | 测试运行器与旧命令的薄转发入口，不再重复实现生成器 |
| 部署模板 | `deploy/`、根 `Dockerfile` | 服务端容器、TLS、worker 环境及开机启动 |
| 回归 | `tests/python/`、`tests/frontend/`、`tests/browser/` | 独立测试工作区，使用合成媒体；不运行真实模型 |
| 文档 | `docs/`、`README.md`、`CHANGELOG.md`、`SECURITY.md` | 使用、部署、维护、安全边界与公开截图 |

服务端与 worker 的生产入口保持不变，不需要因为此次目录整理改启动命令。
长期曲库、音轨、歌词及录音保存在 NAS 的持久卷；算力机只保留模型缓存与可清理的推理临时文件。
不要把真实环境文件、证书、口令或曲库放进 Git。

## 统一工具入口

```bash
python -m tools --help
python -m tools library --help
python -m tools lyrics align --help
```

| 命令（`python -m tools` 之后） | 实现 | 模式与写入范围 |
| --- | --- | --- |
| `library dedupe` | `tools/dedupe.py` | **在线 API**；默认不删除，可更新音质缓存；`--apply` 删除淘汰任务并搬移源文件 |
| `library fix-meta` | `tools/fix_meta.py` | **离线**；默认预览，可能查询 LRCLIB；`--apply` 更新歌名 / 歌手元数据 |
| `library rename` | `tools/rename_files.py` | **离线**；默认预览；`--apply` 重命名源文件并更新 `local_path` |
| `lyrics refetch` | `tools/refetch_lyrics.py` | **离线**；默认联网预览；`--apply` 补取逐行歌词或标记无歌词，不做 ML 对齐 |
| `lyrics resplit` | `tools/resplit_lyrics.py` | **离线**；默认只读；`--apply` 发布切行后的 JSON / LRC，保留原词级时间戳和旧文件 |
| `lyrics align JOB_ID` | `tools/align_lyrics.py` | **离线、本机 ML**；默认只读；`--apply --offline` 才推理和发布，不重做分离 |
| `setup cert [地址…]` | `tools/certificates.py` | 生成 / 覆盖自签证书；需要可选依赖 `cryptography`；`--help` 不写文件 |
| `demo seed [工作区]` | `tools/demo.py` | 生成两首虚构曲目；`--showcase` 生成八首及封面；已有同 ID 目录会失败，不覆盖 |

现有各工具的参数继续由其自身解析，详情使用对应 `--help`。
`refetch`（换歌词来源）、`resplit`（排版）、`align`（词级时间轴）是不同操作，
不要因为都处理歌词就互相替代。

### 在线除重

在能访问 API、任务音轨及源文件的服务主机或维护容器执行。
配置 `OPENK_API`（默认 `http://127.0.0.1:8000`）、`OPENK_DATA_DIR`
（此历史工具默认 `/data`）；任务目录可单独用 `OPENK_JOBS_DIR` 指定。
API 返回的源文件绝对路径也必须在工具进程中可访问；不要直接在路径不同的远端机器上运行。

先等待导入 / 处理 / 录唱空闲，再预览结果。`--apply` 会通过 API 删除任务，
其中的音轨、歌词和录音也会删除；源文件默认移入 `_重复/`，不是完整数据备份。
需要保留源文件原地时加 `--keep-sources`。媒体只读、质量无法比较时不要强行删除。

```bash
python -m tools library dedupe
python -m tools library dedupe --apply
```

### 离线维护

写入前等待任务完成、备份任务元数据和将修改的媒体，停止 API 与 worker，
并确保没有其他维护进程。使用正确的文件属主 / 组权限，维护后重启服务重新加载曲库。
**仅刷新网页不会让内存里的 JobManager 读取外部修改的 `status.json`。**

这些工具遵循 `OPENK_DATA_DIR` / `OPENK_JOBS_DIR`；可先对备份副本预览：

```bash
OPENK_JOBS_DIR=/path/to/backup/jobs python -m tools library fix-meta --limit 20
OPENK_JOBS_DIR=/path/to/backup/jobs python -m tools lyrics resplit --max-width 24
```

离线对齐必须在装有 `requirements-ml.txt` 依赖、且能读写共享任务目录的算力机执行；
不会利用 `OPENK_REMOTE_STEPS` 把任务送入运行中的服务器。
API 仍在线时应优先用页面的「搜歌词、重对齐」，让正常 worker 队列完成。
切行与对齐按元数据读取嵌套的 `.openk-results/…`，发布新文件组，不覆盖旧歌词或音轨。
本机没有产生词级时间戳时，对齐命令返回失败并保留原歌词。

### 演示与测试夹具

```bash
python -m tools demo seed /tmp/openk-demo
OPENK_DATA_DIR=/tmp/openk-demo ./run.sh
```

位置参数指工作区根目录，任务放在其 `jobs/`；`--jobs-dir` 可直接指定任务目录，
不能与位置参数同时使用。不传路径则使用配置的任务目录。
演示 ID 为 `000000000001` 起的有效 12 位十六进制 ID；生成前检查所有目标，
存在任一同 ID 目录或符号链接就拒绝执行。旧的无效 `demo` 目录不会被修改或自动删除。

`tools.demo.create(root, showcase=False)` 是回归与演示共用的生成器，
不下载商业歌曲、不读取真实麦克风。

## 部署文件

| 文件 | 用途 |
| --- | --- |
| `Dockerfile` | API 镜像；`WITH_ML=0` 将推理交给远程 worker |
| `deploy/deploy-openk.sh.example` | 参数化容器更新模板；原根目录示例已迁入此处，保留可执行权限 |
| `deploy/openk.env.example` | 服务端配置模板 |
| `deploy/nginx-tls.conf.example` | TLS 反代与媒体 / 上传配置 |
| `deploy/worker.env.example` | 算力机环境与服务端路径映射 |
| `deploy/ensure-mount.sh.example` | macOS worker 启动前确认共享挂载 |
| `deploy/org.openk.worker.plist.example` | macOS LaunchAgent 模板 |
| `.github/workflows/tests.yml` | Python / Node / Chrome 回归 |
| `.github/workflows/docker-publish.yml` | 多架构镜像与版本 / 稳定通道 |

模板需要复制、填写本机配置后使用，不能直接替换定制部署。
真实环境文件留在部署机器，不随源代码移动。详细步骤见[分布式部署](distributed.md)。

## 回归入口

```bash
python -m pip install -r requirements-test.txt
npm install --ignore-scripts
python scripts/run_tests.py
python scripts/run_tests.py --group python
python scripts/run_tests.py --group frontend --group browser
python scripts/run_tests.py test_tools.py test_config.py
python scripts/run_tests.py frontend/test_search.js python/test_search.py
```

无参数仍运行全部套件，浏览器最后执行；分组可重复，文件名或分组相对路径可选择单套。
未知选择或没有匹配时退出失败，不会显示 `0/0` 成功。
运行器隔离每套的任务目录和环境，缺依赖 / Chrome、超时或跳过不会算完整通过。
Python 用例之间的辅助导入、JS 相对资源路径均以新目录布局工作。

真实浏览器场景与公开截图命令见[电视指南](tv.md#回归测试)。

## 旧命令迁移

| 旧入口 | 推荐入口 / 变化 |
| --- | --- |
| `python tools/dedupe.py` | `python -m tools library dedupe` |
| `python -m tools.fix_meta` | `python -m tools library fix-meta` |
| `python -m tools.rename_files` | `python -m tools library rename` |
| `python -m tools.refetch_lyrics` | `python -m tools lyrics refetch` |
| `python -m tools.resplit_lyrics` | `python -m tools lyrics resplit` |
| `python scripts/make_cert.py` / `python -m scripts.make_cert` | `python -m tools setup cert`；旧入口保留 |
| `python scripts/seed_demo.py` | `python -m tools demo seed`；改为共享的两首有效 ID 演示，不覆盖旧任务 |
| `python scripts/test_fixtures.py DIR` | `python -m tools demo seed DIR`；旧函数 `create` 与脚本继续可用，旧夹具入口仍要求显式目录 |
| `python -m scripts.upgrade_word_align JOB_ID` | `python -m tools lyrics align JOB_ID`；旧入口也改为安全预览，写入需显式 `--apply --offline` |
| 根目录 `test_*.py` / `test_*.js` | 已移入 `tests/`，不保留大量根目录转发文件；使用统一运行器 |
| 根目录 `deploy-openk.sh.example` | `deploy/deploy-openk.sh.example`；自定义自动化需更新此示例路径 |

保留兼容入口是为了已有脚本无需一次性迁移；实现只维护一份。
