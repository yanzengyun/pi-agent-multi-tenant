# 独立 AMR 气泡实验

用户在2026-10-14明确授权测试验证pi-connect的AMR路径。实验不改变生产插件，不重新登录、不启动第二个轮询器、不重启服务。仅发送一条女声“你好，这是AMR语音气泡测试”。客户端收到且能播放才算成功，API接受不能作为气泡验收。

来源：https://github.com/tasercake/pi-connect/blob/main/platform/weixin/media_outbound.go （SendAudio）。该实现把音频转AMR-NB，以FILE类型3上传，再发VOICE消息type3；EncodeType=0配合json omitempty实际不发送encode_type，也不发送playtime。AES字段为base64(hex)，encrypt_type=1。本实验按这一载荷复现，不直接安装整个插件。

运行代码在服务器/home/admin/.local/share/pi-voice-probe，使用生产ILinkClient发送模块及现有私有MINIMAX_CN_API_KEY。编码器使用Ubuntu包libopencore-amrnb0（约183KB安装空间），无需安装ffmpeg；Python3.12的audioop把PCM16/16kHz降为8kHz，OpenCORE按AMR-NB 12.2kbps编码。

1. `python3 encode-amr.py --self-test`：1秒音频50帧，验证编码、解码、有效能量及非法输入拒绝。
2. 先由用户给Lucy微信发一条新消息（例如“AMR测试”），待助手完成正常文字回复。Lucy不必自己执行实验，由本脚本发送。
3. admin从原私有env加载密钥，运行`node probe.mjs lucy`；只读取Lucy的绑定与最新入站上下文，要求10分钟内的新消息；测试授权来自本会话，用户后续聊天也能刷新上下文。
4. 安全元数据保存result.json（无key/bot token/context token/CDN参数），必须由用户反馈是否出现、能播放语音气泡。

`personal`参数用于用户明确选择改测原主账号时，固定原凭据userId，不接受任意收件人。该实验没有持久outbox、自动重试或常驻服务；重复运行会再发测试消息，需明确测试意图。

2026-10-14已真实发送pi_connect_exact_amr：2940ms/4710字节，API接受并返回服务端消息ID；用户反馈“啥都没”：客户端没有出现新消息/语音气泡，实验失败；不能依据API成功将该候选用于生产。详见result.json。

补充实验：`node probe.mjs lucy --complete-fields`在同种AMR载荷中显式发送encode_type=5、bits_per_sample=16、sample_rate=8000、playtime=实际毫秒数，排除候选实现缺字段；2026-10-14T01:15:38Z接口接受（3020ms/4838字节），用户确认“确实啥也没有”，客户端无消息/气泡，该补充实验也失败。详见complete-fields-result.json。新上下文最大年龄调整为10分钟，便于两轮用户确认实验；不会重新登录或轮询。

最终结论：精确复现pi-connect的AMR请求与补齐编码/时长字段的AMR请求，两轮均API接受、有消息ID，但用户确认微信无消息/气泡。两条路径不适合上线。生产女声MP3保持不变。此结论仅覆盖这两种请求与当前账号/通道，不宣称微信所有接口永远不支持语音。
