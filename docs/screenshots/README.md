# 公开截图

本目录只保存隔离演示环境生成的图片，不使用真实曲库、真实录音、
部署地址或有效配对码。音轨、歌词和封面由 `tools/demo.py` 生成，
浏览器录唱使用合成 `MediaStream`，不打开真实麦克风。
Chrome 配置和套接字使用独立的短路径临时目录，避免深层 CI 工作区超出 Unix 路径限制；
测试结束后连同合成媒体工作区一起清理。

| 文件 | 场景 |
| --- | --- |
| `songboard.png` | 桌面经典点歌台与悬浮播放条 |
| `classic-phone.png` | 手机经典列表 |
| `classic-covers-phone.png` | 窄屏封面视图 |
| `player.png` | 经典歌词与播放器 |
| `controls.png` | 混音、监听和录唱控件 |
| `processing.png` | 无活跃任务的导入后台 |
| `tv-stage.png` | 电视演唱舞台 |
| `remote.png` | 手机房间点歌 |
| `remote-search.png` | 手机拼音搜索 |
| `remote-queue.png` | 手机共享队列 |

## 重新生成

从仓库根目录、已安装测试依赖和 Chrome 的环境执行：
还需要 Node.js，版本可参考[回归工作流](../../.github/workflows/tests.yml)；
它用于前端 / 浏览器回归，不是 Web 服务的运行依赖。

```bash
python -m pip install -r requirements-test.txt
npm install --ignore-scripts
export OPENK_TEST_ARTIFACTS="$PWD/.test-artifacts/screenshots/images"
.venv/bin/python scripts/run_tests.py --group browser
```

确认整套场景完成后，只复制公开清单中的图片：

```bash
for name in songboard classic-phone classic-covers-phone player controls processing \
            tv-stage remote remote-search remote-queue; do
  cp "$OPENK_TEST_ARTIFACTS/$name.png" "docs/screenshots/$name.png"
done
```

不要把 `failure-*.png`、诊断日志、配对页面或整个产物目录一起提交。
发布前检查缩略图、歌词、按钮和窄屏裁切，并确认所有图片链接有效。
截图对应当前源码，不代表 Fire TV 实机、真实麦克风或现场延迟已经验证。

返回 [项目首页](../../README.md)或[使用说明书](../user-guide.md)。
