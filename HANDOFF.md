# 开发交接

更新时间：2026-10-13。

## 用户目标与授权

- 将个人助手拓展为多用户服务，优先一个Pi SDK后端，共用基础服务，用户聊天/记忆/任务/凭据/trace隔离。
- 只做管理员页面；未来管理员创建用户、展示对应微信二维码，用户扫码后在微信使用。笔记仍有SB原生页面。
- 用户已要求开始开发，并指定GitHub仓库 https://github.com/yanzengyun/pi-agent-multi-tenant.git 上传代码。
- 当前个人助手必须保持可用。没有授权把真实用户状态迁入开发环境；测试仅用虚构用户。

## 后续语音方案调研（2026-10-14）

- 用户要求继续探索。直接读取npm最新版2.4.10发布包，音频仍走FILE，无新增原生VOICE发送实现；issue209曾成功后失败、issue290的10月3日反馈VOICE不呈现均是用户证据，不能当腾讯根因确认。另一个Go SDK的SendVoice只有载荷实现，未找到真机成功证明，不盲目换插件。
- 已用urllib实际读取腾讯微信客服官方94677/90253文档：明确voice/media_id，AMR≤2MB/60秒；回复窗口48小时/5条，需客服接待状态和应用权限，也有发送失败事件。这是值得隔离验证的新通道，需企业微信客服账号/应用/回调配置；用户进入新的客服会话，不是现有ClawBot原地升级。没有该通道凭据，未真实发送、未声称已可用。
- 方案与接入/验证条件见docs/wechat-voice-options.md。最小体验改善是有期限私有网页播放链接，无需另开容器，但并非原生气泡；本轮只完成调研与文档，没有实现/部署页面、新通道，也没有发测试消息或重启服务。生产女声MP3保持。

## 独立AMR气泡实验（2026-10-14）

- 用户明确要求测试GitHub pi-connect的AMR候选。新增scripts/voice-probe，源码复现FILE上传/type3 VOICE消息，encode_type0因omitempty不发，playtime不发，AES base64(hex)，encrypt_type1。
- 服务器仅安装libopencore-amrnb0（183KB），未重启任何服务。独立目录/home/admin/.local/share/pi-voice-probe，不新建微信登录或轮询器；现有插件保持。
- Python3.12 OpenCORE AMR-NB编码/解码自测通过：1秒50帧1606字节且解码有非零能量。用户已确认发送新消息，读取到66秒前的Lucy入站、任务已结束；移除不必要的AMR字面匹配，仍固定Lucy绑定且要求10分钟内上下文。2026-10-14T01:09:48Z已按pi-connect精确载荷真实发送一次（2940ms/4710字节），API接受、有服务端消息ID；用户反馈“啥都没”，确认客户端无新消息/气泡，实验失败；结果已记scripts/voice-probe/result.json。AMR候选不能直接作为修复上线；生产保持已验证的女声MP3附件。该失败只验证这一具体路径，不能据此断言所有微信通道永远不支持语音。补测--complete-fields显式AMR编码5/8kHz/16bit/时长3020ms，2026-10-14T01:15:38Z API接受、有服务端消息ID，用户确认“确实啥也没有”，补齐字段实验也失败；见complete-fields-result.json。两轮AMR均无客户端消息/气泡，生产保持女声MP3；无需改插件、音色、重启服务或继续重复相同测试。

## 女声与主账号接入（2026-10-14）

- 用户确认Lucy已收到MP3，但需要下载，要求继续查原生气泡、改女声、原主账号上线。默认音色改为官方female-tianmei（甜美女性），ASSISTANT_TTS_VOICE可配置；保持现有key，默认文字与按需音频。
- 原生气泡：核对最新官方协议、候选PR9与issue215，2026-09-02实测包含MP3直接VOICE、SILK24kHz/8kHz及不同playtime均API成功但不显示。尚无可验证的参数修复，原生产继续发送用户已验证收到的MP3附件；不能承诺免下载原生气泡。
- 女声已上线，多用户备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-014115，原个人Pi已空闲/reload上线voice_reply，注册/启用/女声/key状态均通过，原进程与任务保持。
- 原个人Pi扩展源码位于相邻alibaba_host/pi-agent/voice-reply，独立主账号模块复用本项目语音/微信发送代码，自己的凭据/上下文，固定收件人；不迁移到多用户库。部署/备份/reload与原进程保持检查由该项目install.py完成。

## 语音气泡不可见修复（2026-10-14）

- 用户确认Lucy收不到。Lucy在北京时间01:21的真实运行voice_reply成功，14.26秒，出站队列记录接口接受，但客户端不可见。不能把sent/API成功当成端侧收到了。腾讯仓库issue215同样实测VOICE上传+VOICE消息无显示，包括silk-wasm/24kHz；没有官方权限或字段根因结论。https://github.com/Tencent/openclaw-weixin/issues/215 。
- 改用官方插件的音频FILE路径：MiniMax直接生成MP3，media_type3上传/type4文件消息，voice-reply.mp3；保留voice_reply工具名、每轮200字/60秒、隔离outbox与重试。移除silk-wasm依赖，不再提供原生气泡。工具提示与system说明MP3附件；准备不等于送达。
- 已部署，服务健康检查与用户/绑定保持检查通过，原个人PID未变；备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-013006。本地54项Node测试通过，独立临时库真实模型调用voice_reply、现有key合成MP3（3432ms/28788字节）及微信FILE上传通过。未向真实聊天额外发送测试消息，客户端收到与播放待用户确认。
- 新增非零业务errcode失败校验（HTTP200/ret0也不能忽略errcode），trace新增audio_api_accepted，clientPlaybackConfirmed固定false。模型/合成/上传成功不代表客户端已经验证。

## 历史：MiniMax微信语音回复（2026-10-14）

- 用户指定官方API文档并授权复用当前key。现有MINIMAX_CN_API_KEY真实调用t2a_v2成功；没有读取/输出密钥。MiniMax speech-2.8-turbo、male-qn-qingse、PCM16/24kHz转SILK，新增voice_reply工具，默认文字，明确要求“用语音回复”时准备每轮最多一段200字/60秒。
- 仅当前运行的微信inbox提供工具，用户与run固定在后端闭包中；网页与人物设定草稿不可用。准备完成后文字与语音通过原微信队列投递，微信语音消息type3/encode_type6，上传media_type4；新增私有wechat_voice表保留音频和CDN引用至发送完成，重试不再次合成、不重复已成功发送的文字，解绑清理。CDN只允许微信HTTPS域名，不携带模型或bot凭据。
- 本地53项Node测试通过；服务器独立临时库真实Pi模型调用voice_reply、现有key TTS、SILK编码解码、微信真实CDN上传通过（3380ms/11424字节测试音频），未发送真实用户微信消息。客户端实际播放尚待用户用“请用语音回复一句你好”验收。
- 已上线并确认运行进程ASSISTANT_TTS=on、voice表存在；服务器53项Node测试通过，服务与沙箱/watchdog健康，用户/绑定与原个人PID保持不变。备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-011744。ASSISTANT_TTS=on启用多用户版；原个人Pi未修改。更新部署脚本支持锁文件变化安装依赖与回滚；新依赖silk-wasm@3.7.1，不改变SDK版本。验证脚本scripts/verify-speech-live.mjs --verify-upload不会发送真实消息。

## 微信处理提示（2026-10-14）

- 用户要求与主用户一致，每次处理前发送“✅ 已收到，pi 处理中...”。RunQueue新增await beforeRun，WechatManager按run所属用户与原inbox发送，稳定client_id带processing后缀；普通重放不重跑也不重复提示。
- 提示失败或5秒超时不阻塞任务，不进入最终回复重试队列，避免结果后又补发处理提示。网页任务、人物设定草稿及定时提醒没有该提示。无需数据库迁移。
- 已上线，45项Node测试通过，新增执行前顺序/重放去重/用户上下文/失败继续测试；生产健康检查通过，用户/绑定保持不变，原个人Pi进程未重启。备份：/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-005210。

## 最新上线：轻量命令沙箱与复用池（2026-10-13）

- 用户授权按推荐方案开发，允许合适的池复用。已上线Bubblewrap独立runner及cmd；c0051ca时间/persona修复同时已部署。真实模型和普通合成用户均调用time_now、persona_read/write、cmd成功；未发真实微信消息、未改Lucy的设定/密码。原个人Pi PID2985保持不变。
- 进程每次新建隔离环境，复用8个UUID独占的128MiB磁盘镜像工作槽位与只读运行依赖；每槽实际可用约100MiB，跨命令及服务重启保留文件。没有跨用户进程复用或常驻Shell池，简单命令中位约105ms（前一轮119ms）。池上限包括验收appadmin已占1槽，普通合成账号已清理。
- pi-sandbox.service以pi-sandbox用户运行，socket/run/pi-sandbox/runner.sock，仅后端通过pi-sandbox-client组连接。源码/opt/pi-sandbox/code，磁盘/opt/pi-sandbox/disks，挂载/var/lib/pi-sandbox/slots，owners.json绑定用户。主服务drop-in/etc/systemd/system/pi-multi-tenant.service.d/10-sandbox.conf。未给Pi Docker权限。
- AppArmor为bwrap定向授予userns，全局apparmor_restrict_unprivileged_userns仍为1。seccomp与namespace限制读取/写入、socket、ptrace/新增namespace/io_uring；默认离线。任务192MiB/0.5CPU/64PID/30s/32KiB原始输出，执行服务256MiB，结束杀整个任务cgroup。不回退宿主机执行。
- 43项Node测试和5项池测试通过；真实资源/隔离/取消/超时/重启/普通用户模型验收见test/sandbox-live-verification.json、test/live-readiness.json。发现并修复清理符号链接时提前stat不可访问目标的问题，防泄漏与脏槽复用；二进制输出JSON膨胀也已覆盖。
- 更新脚本备份增加sandbox/docs目录；首次安装deploy-sandbox.py，验证后enable-sandbox.py再update-live.py。最后代码更新备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261013-233555。安装脚本运行会短暂重启独立执行服务，需等无任务。备份/扩容/恢复见README。

## 最新调研：Vibe 与轻量沙箱（2026-10-13）

- 移动端联网问题已解决，用户重启服务并勾选联网后root SSH成功；不能继续说当前会话禁网。该调研时Lucy时间和agent.md补丁c0051ca待上线，现已随沙箱上线。
- 用户要求了解Vibe容器原理及轻量沙箱，已只读检查本会话Docker cgroup、NoNewPrivs/seccomp及挂载，阅读移动端身份映射/socket复用代码；未确认每Vibe用户是否独占容器。
- Alibaba2CPU/1613MiB、available约665MiB；cgroupv2，userns开启但AppArmor限制=1；该调研时无/dev/kvm，未安装bwrap/nsjail/runsc。方案文档docs/sandbox-research.md，首选按命令Bubblewrap+资源控制的原型，NsJail/SRT备选，陌生用户扩大前评估gVisor。该调研阶段未安装沙箱；后续已按上文方案上线。
- pi-safe默认全盘可读且网络不限制，不能当多租户隔离。Lite执行器必须同时阻断跨用户读取、写入、网络、进程/socket访问，并控制整组子进程资源；不得因沙箱失败自动退回宿主机命令。

## 历史：查询时间与 agent.md 自助修改（已上线）（2026-10-13）

- 用户反馈Lucy无cmd，无法查时间或改自己的agent.md。通用cmd/bash原本不开放；此阶段共用Linux admin，不能直接开宿主机命令。生产Lucy实际trace尚未读取，不能断言是缺工具还是模型拒绝。
- 本地增加零参数time_now，返回UTC及北京时间；系统提示和persona工具描述明确agent.md/AGENTS.md是自己的人物设定，通过persona_read/write保存，不依赖命令工具。旧会话拒绝不应覆盖当前工具清单。
- 新增test/pi-tools.test.mjs，通过SDK适配器与真实队列/Store验证查时间、自己配置保存/镜像、跨用户不能修改以及草稿只读，3项通过。测试使用模拟SDK模型，不代表生产Lucy或真实模型验收。
- 此补丁开发时移动端禁止网络socket，SSH报Operation not permitted；后已修复移动联网并验证root SSH。c0051ca现已部署，verify-live.mjs自然语言agent.md与时间请求验收已通过，另通过普通合成用户验收。

## 当前补充：笔记认证修复与人物设定AI（2026-10-13）

- 真实根因：SB原生登录自动请求根路径/.auth/central/public，误入trace Basic网关触发浏览器验证；同时primaryUrl错误为loopback。Nginx专用/.auth/central/免Basic转发SB，原生SB自己认证；primaryUrl热更新为https://123.56.157.198:32651。Node fetch会替换Host，内部dashboard请求改用标准http.request保留公网Host及HTTPS代理头。后台/个人trace保持保护，不能为修复用户登录移除全站保护。
- 永久用户主页/assistant/account；invite7天只用于注册/激活。页面称人物设定，网页AI生成草稿只允许persona_read，run_modes持久化只读模式，未保存不覆盖设定；微信persona_read/write固定当前UUID，明确请求才保存。
- 网页与笔记密码统一：新注册同步SB；笔记同步异常返回notesPending，用户验证主页密码重试；改密先同步SB成功再更新主页hash。现有Lucy密码不自动重置，验证主页密码才统一。凭据更新按用户互斥，防并发改密造成不一致。
- 已验证37项测试、真实模型persona工具；浏览器测公共认证无WWW-Authenticate挑战且读到自身index.md。浏览器已验证AI草稿只读且不保存、统一改密后重新登录笔记，JS错误0，结果见test/live-readiness.json。
- 当前更新备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261013-215411，保持原用户/绑定及个人Pi PID不变。生产代码与Git目录分开，交接需同步两处。

## 最新进度：邀请注册与自助配置已上线（2026-10-13）

- 用户要求分享链接让用户受邀注册、设置笔记账号密码、页面管理AGENTS，已实现并上线。管理员原/assistant/不变，用户页/assistant/account，无需管理员网关口令。Nginx仅豁免account/join、必要静态文件、登录/注册及account自助API；管理员接口及个人trace仍受原网关保护。
- 一次性邀请7天有效、可撤销，数据库只存hash；分享token放URL fragment，POST消费。注册强制role=user，事务防重复消费。管理员可邀请已有账号激活，保留原UUID/记忆/微信，设置网页登录密码并撤销旧会话；新激活邀请和改密码会使旧目标邀请失效。
- 用户可选择笔记用户名/密码，保留Space和Agent token，改名更新人类成员ACL，删除旧人类账号；冲突账号不覆盖。自设密码应用DBhumanPassword=null，不返回管理员。主页与笔记密码统一，新注册同步，改密同步，旧用户必须主动验证当前主页密码再统一；不在普通登录时覆写Lucy原笔记密码。
- 每用户AGENTS由agent_profiles表保存，镜像到UUID/workspace/AGENTS.md，固定服务端路径、文件0600；数据库为注入来源，下一次模型请求读取该用户配置，不启用全局AGENTS发现或宿主机工具。仍属应用隔离、共享Linux admin，未宣称OS沙箱。
- 37项本地自动测试通过；浏览器实测受邀注册、一次性拒绝、AGENTS保存、自选笔记凭据登录、密码不留明文、自己的扫码PNG、网页改密码和旧会话撤销；普通用户访问管理员接口和个人trace401，JS错误0。真实SDK上下文验证AGENTS注入且工具白名单不扩张。
- 更新前私有备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261013-210737。update-live.py检查队列空闲、备份DB/源码/路由，健康失败恢复旧代码和路由、不覆盖数据库；已有用户/绑定摘要与个人PID2985确认未变。验收账号已清理，未改真实用户密码/偏好/笔记。
- 新代码/scripts：verify-invites-ui.mjs；浏览器运行python3 scripts/verify-ui-container.py verify-invites-ui.mjs。临时依赖playwright-core1.51.1位于/tmp/pi-backend-browser，使用缓存公开Playwright容器；不要给页面加unsafe-eval来适配测试。
- 真实账户扫码、运行完成和微信接口发送确认已只读验证，未读/导出聊天正文。此前“真实收发待确认”是历史状态。

## 历史：独立多用户服务已上线（2026-10-13）

- 用户要求继续开发到可直接使用并提供管理后台，已部署独立正式实例。地址https://123.56.157.198:32651/assistant/，网关仍使用原zengyuny账号；后台admin密码私有保存本机alibaba_host/config/multi-tenant-login.json、服务器/home/admin/.config/pi-agent-multi-tenant/login.json，不输出或写Git。
- 代码/home/admin/pi-agent-multi-tenant-live，状态/home/admin/.local/share/pi-agent-multi-tenant/data，私有配置/home/admin/.config/pi-agent-multi-tenant。pi-multi-tenant.service开机enabled、异常重启，监听32215，仅loopback；MemoryHigh256MiB/Max384MiB/CPUQuota50%。旧开发实例仍停止。
- 独立SB容器silverbullet-multi-tenant，loopback32216，数据/opt/pi-agent-multi-tenant-sb/data，restartunless-stopped，128MiB/0.25CPU。个人SB不改。/users/<uuid>/使用SB自身账号/Space权限；管理员后台和个人trace仍由原密码网关保护，不向笔记用户分享网关口令。
- 新增一次性/每日文本提醒，数据库持久化、按用户工具和管理员UI、启动恢复、漏执行每日提醒合并一条；未绑定或没有首条微信上下文则waiting_for_wechat。微信旧上下文或token失效不保证主动送达，需要用户再发消息/扫码。未实现定时LLM复盘或复杂cron。
- 最终28项本地自动测试通过，服务器真实模型调用memory_read、提醒工具加载、真实SB隔离、真实二维码生成通过。公网严格TLS、匿名401、Cookie路径/Secure、注销撤销通过。
- 临时Playwright容器实测管理登录、建用户、提醒创建取消、trace页面、笔记账号弹窗、原生笔记用户登录、笔记用户访问个人trace401、真实二维码PNG显示；JS错误0。未真人扫码、未主动发送测试微信；最终微信收发须用户绑定后确认。
- 验收使用虚构用户；浏览器账号/任务/Space与SB账号已按所有权清理，后台保留管理员和其虚构模型验收会话。二维码只生成未扫码。个人Pi PID2985不变。
- 部署脚本scripts/deploy-live.py，远程验收verify-live.mjs，浏览器verify-ui-container.py/verify-ui.mjs及cleanup-ui-probe.py。依赖锁定SDK；发布前内存预检，队列有任务拒绝部署。重新发布有短暂停机，不宣称原子回滚。

## 历史：个人助手已恢复，继续本地开发（2026-10-13）

- 服务器已重启，个人Pi继续原会话，微信显示连接、9个scheduled、trace32213 HTTP200。用户批准后已启用个人pi-wechat-watchdog开机监控，PID2985不变；详见alibaba_host/pi-agent/autostart和对应HANDOFF。
- 二阶段已提交并推送GitHub main，提交4c96fca；微信真实收发和服务器新版尚未验收。独立开发/实验模型实例仍保持停止，减少小主机资源占用。
- 本轮新增管理员运行记录页面及API：最近50条、逐次提示词/记忆/工具/SDK事件、结果错误。普通用户访问403，用户与run ID错配404；23项本地自动测试全通过，前端语法通过，未做浏览器自动化验收。
- 继续开发下一项为独立持久化调度及微信主动投递；不能直接加载个人助手现有任务或凭据。

## 历史：服务器重启期间继续本地开发（2026-10-13）

- 用户报告个人微信消息无回复，随后确认服务器突然出问题并正在重启；要求继续本地开发，允许当前暂不做服务器验收。不连接、部署或重载服务器；恢复后先验证个人助手。
- 本轮微信/SB二阶段代码仍在本地未提交；两个部署脚本的首次SSH均失败于认证前，没有成功执行二阶段远程部署或重载生产。
- 目前SSH连接在banner exchange超时；带鉴权的生产trace API及SilverBullet443请求均读取超时。微信公开接口从本机返回HTTP404，说明该接口主机可达，不能由此推断服务器到微信的网络情况。
- 尚未获取服务器当前进程、内存、OOM日志或微信状态，原因未确定，不能声称已恢复。不要继续部署或盲目重启生产。
- 本地二阶段已有独立微信绑定/身份保留、防串用户、SB非管理员Space/Agent token、管理员扫码UI及锁定SDK依赖。真实隔离SB与Pi工具验证已通过；真实扫码绑定与服务器验收未完成。
- 身份保护测试已通过；新增关闭期间迟到二维码/扫码回包测试，防止服务关闭后访问已关闭数据库或建立绑定。二维码及状态请求接入关闭abort信号。
- README已更新二阶段功能、配置、账号/Space映射、备份恢复和待验收限制；部署脚本改用独立锁定SDK，并修正SB启动Space的revisions枚举。脚本仅做本地静态检查，未远程执行。
- 最终本地21项自动测试全通过；Python部署/验证脚本AST检查、前端JS语法和git diff --check通过。npm run setup:pi已从独立锁文件安装121依赖，SDK导入及8个配套包全部1.1.0检查通过。无需服务器即可重现这些检查。

## 第一阶段服务器基线（重启前，不代表当前运行状态）

- Node原生HTTP与SQLite、管理员登录/建用户页面、按用户限定的记忆/聊天/运行/trace API。
- SQLite持久化队列、全局并发1、任务超时abort、重启恢复；SDK每轮创建独立AgentSession，结束dispose，JSONL按用户UUID保存。
- 原版Pi SDK1.1.0真实模型模式已验证；显式模型、auth、resourceLoader，不发现生产资料；仅memory_read/write和可选官方web_search。
- 真实开发环境测试：两个虚构用户记忆工具及注入、跨用户trace拒绝、SDK历史恢复、官方网页搜索、个人助手配置/进程不变。报告test/live-verification.json。
- 服务器开发实例源码/home/admin/pi-agent-multi-tenant-dev、状态/home/admin/.local/share/pi-agent-multi-tenant-dev、tmux pi-multi-tenant-dev，回环端口32214；没有新增公网路由。
- 管理员登录文件/home/admin/.config/pi-agent-multi-tenant-dev/login.json私有0600；不读出或打印密码。此后端复用私有环境中的模型密钥，不把密钥写Git。
- 现有个人助手admin/pi-wechat、现有SB、Nginx、任务、记忆均未修改；不可为开发重载或升级这些设施。

## 待做

1. 二阶段微信适配及管理台已经实现，真实扫码、消息收发和异常网络验收待做；不要用个人生产微信扫码开发二维码。
2. SB自动配置及真实本地隔离验证已完成，服务器部署验收待做。
3. 常驻调度与按用户消息投递；不依赖AgentSession常驻。
4. 受限健康/投资工具、聊天检索、trace管理页面、用户禁用和限额、备份恢复。
5. 通用脚本只在独立沙箱执行。公网发布前补HTTPS、安全Cookie、Origin和容量测试。

## Git与测试

- 工作区Git凭据只引用/home/q/vibe/projects/zengyuny/.git-credentials-zengyuny，不能读取/打印内容。
- 环境Git HTTPS需用/opt/vibe/ca/mitmproxy-ca-cert.pem的已配置代理CA，不能禁用TLS校验。
- 原GitHub main只有初始README，已基于origin/main开发，保留历史，禁止强推。
- npm test需Node>=22.19并先npm ci --omit=peer --ignore-scripts；本地沙箱禁止监听端口时需对回环测试请求outside-sandbox执行。
- scripts/deploy-dev.py只重启pi-multi-tenant-dev，不碰pi-wechat；重新部署前确认没有开发运行中的任务。

## Git 上传当前状态

- 用户更新token权限后重试成功，GitHub main已收到第一版开发代码；初始提交dbda1b2及后续本地提交历史保留，没有强推。
- GitHub仓库：https://github.com/yanzengyun/pi-agent-multi-tenant.git 。此前完整服务器Git副本/home/admin/pi-agent-multi-tenant，开发运行副本/home/admin/pi-agent-multi-tenant-dev；本轮二阶段不向服务器同步。
- 上传认证通过限定github.com及此仓库路径的Git credential helper读取用户授权私有文件；只引用文件，不输出token，不将凭据加入Git。临时helper在/tmp/pi-github-credential-helper.py；环境重建后若丢失，需重建同等限定的helper。
- 历史认证问题已解决：环境代理CA、失效IDE askpass、token最初缺少仓库写权限。后续不要禁用TLS校验；调用Git时移除GIT_CURL_VERBOSE等调试环境变量。
- 第一阶段本地Node24与服务器Node22环境的7项集成测试均通过；独立真实Pi SDK验证通过。二阶段增加微信及SB自动配置，但真实微信和服务器新版仍未验收。
