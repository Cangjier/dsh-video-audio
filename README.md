# dsh-video-audio

DSH Host 插件：**造声音、修声音、量声音**。它只做能写成「同输入必得同输出」的事，
并且**只报数字、不出判断**——哪一段好听、噪声底该压到多少、这条 take 能不能用，都是调用方的决定。

| 工具 | action | 覆盖 |
| --- | --- | --- |
| `audio_build` | `tone` `assemble` `restore` `record` | 写一个参数完全指定的测试信号；把片段按**采样点**放到一条时间线上；跑一条**显式**修复链并回测；从指定设备录固定秒数 |
| `audio_measure` | `identify` `speech_map` `loudness` `levels` `integrity` `sync` `noise` `devices` `audio_events` `audio_status` | 声明 vs 实际、语音/静音分布、EBU R128、采样域削波、MPEG 帧链完整性、两段录音的偏移与漂移、噪声底成分、采集设备、AudioSet 521 类声学事件 |
| `audio_setup` | `status` `install` `remove` | 装/删/查 YAMNet 模型与共享 ONNX 运行时（28 MB） |
| `audio_guide` | `overview` `tool` `action` `rules` | 按需读取的完整参考：参数、返回、耗时、陷阱、实测数据 |

共 **4 工具 / 21 action**。常驻 schema 约 17 KB（`node src/bin/surface-report.mjs` 可复现）。

## 安装

profile 里以 `link:` 挂载即可，无需构建步骤（纯 ESM，无第三方运行时依赖）：

```yaml
- insert:
    - id: dsh-video-audio
      name: 'dsh-video-audio'
      config: { projectRoot: null, ffmpegPath: null, ffprobePath: null }
```

出厂默认见 [`cordis.patch.yml`](cordis.patch.yml)：路径类全部留空，自动推导。

## 依赖是「借」来的，不是自带的

ffmpeg 有几百 MB，而产出音频的机器通常已经在用它——兄弟插件
[`video-factory`](https://github.com/Cangjier/video-factory) 为了渲染视频早就装好了。所以本插件
**不自带** ffmpeg，发现顺序是：

```
config.ffmpegPath → DSH_AUDIO_FFMPEG → 本插件 vendor/ffmpeg/bin
                  → 同级 video-factory/vendor/ffmpeg/bin → PATH
```

同理，YAMNet 模型与推理运行时优先读本插件 `vendor/audio`，其次读同级 video-factory 的旧位置
（那份是能力迁出之前装在那里的），并且 `audio_setup {action:"install"}` 会**把它复制过来而不是重下**。
每一次报告里都带 `vendorSource`，说明是哪一条命中的——「在我机器上是好的」必须可解释。

## 与 video-factory 的分工

- **声音本身**（造、修、量、分类）在这里，工具族 `audio_*`。
- **把声音放进片子里**（混音、闪避、响度归一、烧字幕）在 `video-factory` 的
  `video_render {action:"finalize"}`；写 `plan.json` 的是那边的 `video_*` 工具。
- `video_qc {action:"check"}` 也会测量成片的响度与削波——它检查的是**交付物**，这里检查的是**素材**。
- 抠像（matting）用的 ONNX 运行时由本插件的 `audio_setup {action:"install"}` 提供，两边共用一份。

## 测试

```bash
node --test "tests/*.test.mjs"     # 单元 + 端到端（真实 ffmpeg）
node src/bin/va.mjs doctor         # 报出 ffmpeg 与模型分别来自哪条规则
node src/bin/surface-report.mjs    # 常驻 schema 字节预算
```

测试会自动把 ffmpeg 指到本机 vendor 或同级 video-factory 的构建（`tests/helpers.mjs`），
所以一个从未装过 ffmpeg 的 checkout 也能跑。没有 ffmpeg 时，依赖它的用例会**跳过并说明原因**，
而不是失败。

## 命令行

`node src/bin/va.mjs <命令>` 暴露同一批操作，用于「不经过 agent 调试某一阶段」：

```
doctor  status  install [--force|--remove]
tone  assemble  restore  record  devices
identify  levels  loudness  speech-map  integrity  noise  sync  events
```

没有「一键处理这段音频」命令：顺序编排与取舍是调用方的职责，这正是本插件的设计。

## 状态

⚠️ **四个核心模块尚未实现**：`audio-build`、`audio-integrity`、`audio-record`、`audio-restore`
的内容在 2026-10-04 的迁移事故中被毁，没有干净副本，现在只有会明确抛错的占位实现。
原因、证据与重建依据见 [`docs/事故记录.md`](docs/事故记录.md)。其余部分（`audio_measure` 的十个
action、`audio_setup`、`audio_guide`、CLI、跨插件发现）完整可用。

## 许可

MIT。
