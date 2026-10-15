# 开发交接

更新时间：2026-10-15。

## note_list / note_search 开发完成（2026-10-15，待服务器许可与上线）

- 用户确认检索采用rg并要求补齐列表和搜索。已新增共享src/note-catalog.mjs，接入SilverBullet.tools与Pi SDK，系统提示补发现→检索→读原文/不完整范围说明。列表metadata-only、目录/最近修改排序/offset分页，默认20最多50；默认隐藏Library、CONFIG与归档，includeArchived显式开启。搜索按页返回URL/最多3段及原文行号，字面匹配忽略大小写，每次最多200页/2MB/200匹配行；跳过过大/并发删除页及返回上限均incomplete，权限/超时失败不当空结果。无浏览器/向量库，无持久搜索缓存。
- inventory和read均固定当前UUID/prefix/folder/token，user停用及归属篡改拒绝；rg只接stdin，不执行shell或扫描宿主机。personadraft依旧只有persona_read。新增6项catalog单测、SDK接线和实际HTTP隔离单测，完整87项Node测试通过；本机独立slim真实模块16项验收通过，报告test/note-catalog-local-verification.json（本机，不是阿里云/模型验收）。原试验脚本已移除重复算法、改调正式模块；--model额外验证真实模型list与search→read，额度耗尽单独记状态。
- 主账号适配在相邻alibaba_host/pi-agent/note-tools：固定sb --space personal fs ls/read，不读CLI凭据；复用同一catalog。2项模拟CLI适配测试通过，尚未加载到生产Pi。install.py备份并只在空闲/reload，检查notes-status、个人进程/设置/任务定义保持；源文件和部署说明均已准备。
- deploy-live/update-live在停止服务前检查rg依赖；未改变SB镜像、ACL、数据库结构、用户页面或沙箱权限。新增docs/note-search.md并补README/部署说明。源码语法与diff检查通过。
- 当前用户最新工作区SSH规则仍要求zengyuny。此用户现有密钥publickey拒绝，上轮root仅授权独立测试；本轮已异步询问是否允许root部署多用户（短暂重启）和主账号空闲加载，尚未收到回答，未用root连接/上传/部署。收到明确许可后：上传隔离stage新src和脚本→真实SB/模型验收→队列空闲时update-live→运行主账号install.py与只输出数量的CLI验证→健康/身份/主PID校验，再同步服务器Git与GitHub，更新本节。不要把当前本地通过说成已上线。

## 笔记 rg 检索独立验收（2026-10-15，已通过，未上线）

- 用户最初要求试 Silversearch、不要向量库；追问浏览器依赖后提出 grep/rg，最终改为 rg 独立验证。14 项真实检查通过，报告 test/note-search-live-verification.json、说明 docs/note-search-trial.md、重现脚本 scripts/verify-note-search.mjs。只增加试验文件，不改生产 src 或注册 note_search 工具，不能说微信助手已具备新检索功能。
- 真实阿里云独立 2.12.0-slim 容器、临时 SQLite 与合成双用户，当前 UUID 受限 token 调官方 /.fs 列表、现有 note_read 读取本人正文，rg 仅接 stdin、固定字符串和参数数组，不给目录或 shell。103 页/124680 字节约484–615ms（含逐页HTTP），中文/英文/标题、字面量与选项形查询、更新与删除立即生效、跨用户列表/正文拒绝、结果限量/非法输入均通过；Runtime数0、无模型或微信调用，所有测试容器及临时应用DB已清理。
- 额外 GNU time 合成490KB纯rg约8.19ms、峰值RSS6MiB，不含HTTP/Node；验收Node采样约105MiB，slim服务约15.53MiB且64MiB上限内无OOM。不能把纯rg数字说成整个后端成本，未做大型库/并发基准。
- 本轮用户明确允许仅本次使用 root 运行独立试验；zengyuny 配现有密钥仍 publickey 拒绝，网络和 /tmp/stockclaw-known-hosts 中服务器指纹正常。不要把本轮 root 例外解释为永久修改工作区 SSH 规则。
- 服务器保存位置 /home/admin/.local/share/pi-note-search-trial/{code,rg-result.json}。原 Pi PID2985保持，pi-multi-tenant/nginx/pi-sandbox active，/assistant/health 返回ok/mode pi；未重启生产或改真实笔记/ACL。源码/文档/报告收尾同步服务器。
- Silversearch/中文插件资产仍在本机 /tmp/pi-note-search-trial；原未跑通 Runtime 验收脚本另存该目录 verify-runtime-search.unverified.mjs，不在公开项目中。官方完整镜像拉取和大包安装下载缓慢，依用户建议在本机并行分段下载约242MiB签名APK包后上传，测试容器离线安装成功Chromium152；随后用户选择rg，未完成Silversearch搜索/浏览器内存实测，不能声称其不兼容或实测占用过大。浏览器准备容器已删除，没有生产Runtime启用。服务器stage的apk/offline是未运行的安装缓存；没有执行全局Docker清理。

## 多用户单篇笔记归档、恢复与永久删除（2026-10-15）

- 用户要求接着主助手部分代码开发多用户SB删除。已只读核对10-15聊天及主账号新增extensions/note-delete.ts：它写死personal，仅给主账号安装，未修改多用户后端；没有跟随其“装进租户沙箱”的错误架构判断。主SB3000与多用户SB32216是两套服务，多用户原有按UUID Space/受限token隔离有效。
- 多用户新增note_archive/note_restore/note_delete。普通删除默认复制原文到本人归档/YYYY-MM/<随机UUID>/原路径.md，回读一致后用调用者已读etag条件删除原页；重复归档不覆盖。恢复先读取归档版本，create-only恢复原路径，再按归档etag删除备份；原位置有内容则拒绝。永久删除要求明确用户请求、confirm=true及note_read的etag，不清理历史备份。仅单篇Markdown，归档原路径<=240字、正文<=30000字符，不增加管理台页面或批量清理。
- 文件API DELETE强制If-Match，回读404才报已移除；丢响应不盲目重复删除。复制/删除不是原子移动，中途冲突保留副本并返回preserved_copy。审计在tenants/<uuid>/notes/audit.jsonl，600权限，只记动作/路径/etag/字节数/hash/原因，不记正文/token；笔记操作期间禁止同用户重叠移动或删除用户。上下文由认证userId固定，模型参数不能选space/userId/url，persona草稿仍只读。
- 先复现旧tools.archive不存在，再通过79项Node测试（含副本损坏不删除原页、删除丢响应回读及操作互斥）。真实SB用合成两个用户验证If-Match拒绝错误版本、原文保留、恢复同名拒绝、重复归档路径唯一、彻底删除及跨租户token拒绝；真实MiniMax三轮实际note_read→archive/restore/delete通过，confirm=true已验证。脚本verify-note-lifecycle-live.mjs，临时应用DB/聊天删除，synthetic SB账号撤权并移除，仅留预期无成员测试Space；无真实用户笔记或微信消息。
- 已update-live上线，备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261015-112536；生产用户/绑定/人设摘要及主Pi PID保持。只更新多用户，没有重载主账号临时note-delete扩展。源码及文档收尾同步GitHub与服务器Git。

## 模型额度耗尽固定提醒（2026-10-15）

- 用户要求额度耗尽时主动说明，避免主助手静默失败。共享model-errors只识别明确quota/2056，不把普通429限流当额度耗尽。PiEngine不再丢掉该类别，RunQueue存model_quota_exhausted安全码，WechatManager直接用固定文字回复，无模型调用、不泄露上游错误或密钥。
- 多用户每个失败请求使用原持久outbox、稳定client_id，只回给绑定本人；发送失败照常保留重试，无新表。主账号独立quota-notice扩展覆盖聊天/定时总结，30分钟持久去重、恢复成功后重置；详情见相邻alibaba_host/pi-agent/HANDOFF。
- 先复现旧队列只存engine_failed/微信笼统提示，再修复。73项Node测试通过，含SDK错误类别保留、额度与普通429区分、固定文字/收件人隔离及同请求不重复。主扩展真实源码事件回放通过，向主账号发一条【提醒测试】消息接口接收，其他用户未发人工测试消息。
- 已update-live上线，备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261015-005252；用户/绑定/人物设定摘要及主Pi PID保持。没有切换Key或修复套餐额度；补跑总结不属于本功能的自动行为。

## 系统音色与个人声音配置第一阶段（2026-10-14）

- 用户指定只做语音增强第一步，不做音色设计。新增个人页「声音」：搜索系统音色、语速、自然/开心/平静/悲伤语气、按需/每次附带MP3、试听及独立保存。MiniMax声音查询实测303系统音色；仅使用system，不把同一Key下其他人的自定义音色开放给用户。未调用voice_design或音乐生成。
- 偏好存integrations的voice项，由登录身份/微信绑定确定user_id；Speech每次使用独立参数，不改共用默认。试听是认证后的MP3响应，限100字和并发、不会保存设置/创建聊天/发送微信；播放器支持blob且CSP仅增加media-src。新增voice_preferences_read/write，允许用户通过AI修改自己的声音偏好；persona草稿依旧不允许写配置。
- /voice文字或裸「发个语音」直接走已配置TTS，不调用模型；正常聊天按mode和语音请求自动补音频，明确不要语音时保持文字；每轮准备一次，失败保留成功文字。长回复只朗读开头，仍限制200字/60秒/1MB，MP3附件，不支持完整歌曲或原生气泡。
- 70项Node测试通过；隔离浏览器真实UI完成音色搜索、试听解码/不保存、保存后刷新、用户隔离、手机390px不溢出，JS/CSP错误0。verify-voice-settings-live.mjs在无私人数据的synthetic用户使用真实模型保存0.75/calm并验证另一用户不变，真实TTS直接/自动各成功、微信发送器为假，未发真实消息。
- 已update-live上线，备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-174942；原用户/绑定/自定义人设摘要及主Pi PID保持。公网用独立synthetic账号验证声音API和真实女声慢速平静MP3试听33204字节成功，账号清理后原用户列表一致。公网认证需Cookie，Nginx清除Authorization；测试不依赖外部Bearer。
- 原个人主助手独立偏好与微信直接入口由相邻alibaba_host/pi-agent/voice-reply维护，来源发言事件与TTS安装守卫已接入；状态与备份见对应HANDOFF。未给Lucy或主用户自动发送试验音频，微信端实际验收需用户测试。

## 完全开源与真实凭据核查（2026-10-14）

- 用户明确要求完全开源并核对密钥/key是否上传。GitHub API确认仓库已public、默认main，之前license为null；本轮加入MIT LICENSE及package/package-lock许可证元信息，README移除“未指定”并链接许可证，依赖不变。没有改变仓库可见性或生产服务。
- 从GitHub重新mirror，快照84f1d22、29提交、290源码/提交对象；当前9项实际凭据HMAC比对无匹配，随后将公开源码对象送到服务器内存，与实际私有值逐字比对，7项服务器凭据及本机GitHub/登录凭据均无匹配；SSH私钥内容/文件头无匹配，私有配置/数据库/README备份路径在历史中均未发现。没有输出实际值或凭据指纹。
- Gitleaks官方二进制下载超时，改用官方Docker镜像v8.30.1，摘要c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f；断网临时容器扫描完整Git历史，退出码0、findings空。报告在/tmp私有保存；公开docs/security-audit.md只记录安全摘要。已补auth.json/credentials.json/login.json/githup_token等忽略规则，.env.example保留空配置/占位示例。
- 历史和特化脚本仍含生产IP、用户/文件路径等部署元数据，它们不是实际凭据；没有改写历史或强推。源码当前没有发现真实密钥上传，不能说“所有个人元数据均已清除”。LICENSE/diff/JSON元信息校验通过，无依赖或生产行为变化；307bcec包含本轮开源改动的30提交/298源码提交对象再经Gitleaks与逐字凭据比对均通过。收尾同步GitHub和服务器并核对MIT识别，不重启服务。

## README 面向开源整理与页面截图（2026-10-14）

- 用户要求备份原README、改成面向开源的介绍，突出微信扫码、人与助手共享笔记、多租户管理并展示管理/邀请/个人/扫码页面。旧README逐字备份到本机docs/private-backups/README.production-20261014-151934.md（600，已gitignore），服务器另存私有documentation-backups。新版README不含真实生产IP/账号凭据路径，通用部署使用example域名；没有修改许可证或仓库可见性，README如实注明许可证尚未指定。
- 新README包含亮点表、邀请接入流程、5张截图、架构、mock快速体验、真实模型配置和当前边界。补docs/deployment.md通用部署/HTTPS/SilverBullet/常驻服务/沙箱边界/备份迁移，以及docs/screenshots.md说明截图来源和再生成。共享笔记明确为用户与自己的助手共用，各用户仍独立Space，不宣称跨用户共享已实现。
- scripts/capture-readme.mjs在隔离临时后端/SQLite通过真实当前UI截图，演示账号demo_alice/demo_bob，mock模型/笔记状态、不可绑定example二维码；不使用生产登录或数据，不发微信、不生成真实邀请。截图admin/invitation/account/wechat-connect/persona位于docs/images，已逐张检查中文字体、布局及无私人数据，JS错误0；首次清理双重close已修正，重跑通过。
- 文档相对链接/fence、PNG格式、备份与旧HEAD摘要、diff/JS语法检查通过。按README的node --env-file启动独立临时mock服务，实际health200和admin登录通过、正常退出。只是文档与截图工具改动，未重启生产服务；源码/文档与私有原README备份收尾同步服务器和GitHub。

## 多用户默认朋友设定与笔记入口（2026-10-14，已上线）

- 用户选择自然朋友型，要求默认会聊天、适时建议总结，以帮朋友记笔记为特色，并能提供自己的笔记/个人页面入口及功能介绍。新增src/persona.mjs默认设定；无自定义/留空时动态使用，页面、persona_read与模型注入一致，现有自定义设定不覆盖。
- 公共提示明确请求才写笔记、先读已有页并带etag更新、成功后才确认，凭据不写笔记。新增只读account_info，后台闭包固定userId，来自SB.view与配置Origin的个人页面，返回本轮实际工具列表；不输出密码/token，不开放选用户参数，未配置入口为null/disabled。草稿仍仅persona_read。
- 本地66项Node测试通过，覆盖默认显示/恢复/自定义保留、跨账号入口拒绝、未配置入口不编造、实际能力清单不包含未启用工具。已经部署，备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-145106；原agent_profiles、用户/绑定摘要及个人PID2985保持。首次混合时间/设定/Python多操作模型验收返回failed；改为--assistant-info分轮验证账号入口、创建与更新，真实模型全部通过，不扩大任务超时或权限。
- scripts/verify-user-sandbox.mjs --assistant-info验证默认朋友设定注入、account_info真实调用、答复包含自己的笔记/个人网址和用户名、note_write实际写入、note_read先于带etag更新且原内容保留；synthetic账号/Space均清理。公网verify-invites-ui通过默认设定显示、自定义保存、AI草稿只读、注册/角色导航/移动布局/改密/删除；笔记验收新增等待.cm-editor，登录及改密后编辑器实际加载成功，JS错误0。未向真实微信发送测试消息。本地/服务器源码与文档收尾同步。

## 移除专用查时间工具（2026-10-14，已上线）

- 用户要求已有cmd即可查时间，移除多用户SDK的time_now；系统提示改为用cmd执行TZ=Asia/Shanghai date，未配置沙箱时只参考本轮提示时间。更新原工具测试及真实模型验收脚本，不改变沙箱权限、其他12个工具或个人主账号插件。
- 本地62项Node测试通过。普通用户没有StockClaw/行情/持仓专用工具，也不加载主账号投资扩展；web_search仍可检索公开股票信息，此次没有封禁股票话题。
- 已经scripts/update-live.py在空闲时部署，备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-141503；现有用户/微信绑定摘要和原个人PID2985保持。verify-user-sandbox.mjs独立synthetic普通用户真实模型验证cmd实际执行date、persona_read/write保存及Python输出通过，context确认time_now缺席；测试账号、Space和沙箱槽位已清理，没有真实微信测试消息。原个人主账号的工具不改。

## 笔记空间 JSON 报错排查（2026-10-14）

- 用户报告 `Could not load this space: Unexpected token 'I', "Insufficie"... is not valid JSON`，询问是否因为未扫码。已用两个独立 synthetic 注册账号在生产复现：A 的 SB 登录 Cookie 打开 B 的 `.config` 返回 HTTP403 纯文本 `Insufficient access to this space`，客户端 boot.ts 把它 JSON.parse，出现完全相同弹窗。主页登录与 SB 登录分别维护，切换主页账号不会切换 SB Cookie。不能靠开放 Space 权限或扫码解决。
- 未绑定微信的新账号正常登录 SB 后 `.cm-editor` 成功加载；Lucy/test2 的 SB 账号、空间及自身 write 成员均正常，test2 未绑定微信。用户尚未提供具体出错账号/URL，不能断言其浏览器实际 Cookie；无痕窗口使用个人主页显示的笔记账号与共用密码可验证账号混用。
- 测试账号均已清理，没有改真实账号密码、ACL、生产代码，也未重启服务。SB 部署版本2.12.0/source70e58486；后续笔记验收需等待 `.cm-editor`，只等 URL 跳转或文件 API200 不足以确认编辑器启动。不要直接清空真实浏览器缓存或绕过原生退出同步，可能影响未同步笔记。

## 用户目标与授权

- 将个人助手拓展为多用户服务，优先一个Pi SDK后端，共用基础服务，用户聊天/记忆/任务/凭据/trace隔离。
- 只做管理员页面；未来管理员创建用户、展示对应微信二维码，用户扫码后在微信使用。笔记仍有SB原生页面。
- 用户已要求开始开发，并指定GitHub仓库 https://github.com/yanzengyun/pi-agent-multi-tenant.git 上传代码。
- 当前个人助手必须保持可用。没有授权把真实用户状态迁入开发环境；测试仅用虚构用户。

## 当前上线与SSH恢复（2026-10-14）

- 用户从PC重新启用网络后，本轮root SSH成功，pi-multi-tenant/nginx/pi-sandbox/watchdog全active；之前是会话沙箱禁网，未改服务器SSH权限。已继续完成待办，原个人Pi进程不重启。
- 已通过完整62项Node和5项Python池测试，部署笔记密码文案、手机退出按钮布局和删除用户功能；备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-123012。现有用户/微信绑定摘要与原个人PID保持。
- 公网verify-invites-ui完整通过（含真实模型AI草稿只读、笔记改名/共用密码/改密后登录、真实QR仅生成取消、邀请单表单/自动登录/角色跳转/手机布局无横溢出、删除确认/旧主页401与旧笔记拒绝），JS错误0，无助手Basic挑战。
- 新verify-deletion-live用独立verify_delete_账号实际占用沙箱并写测试文件，经正式HTTP管理员DELETE清理后确认slot名额返回、session失效、SB Space无成员/无公开访问、human/agent账户移除、旧Agent token读笔记拒绝；root读取该synthetic笔记确认旧文件仍在私有归档。测试断言曾遇到SB省略空members字段，改成members||{}后通过，无生产逻辑改动。没有删除真实用户，已确认无verify_ui_/verify_delete_残留应用账号；预期保留测试笔记归档和删除索引。
- 最新真实报告test/deletion-live-verification.json。此前本地“待上线”条目为历史情况，已由本节完成；旧deletion-local-verification.json保留当时离线验证记录。源码/Git和服务器文档在本轮收尾同步。

## 管理台删除用户（2026-10-14，已上线，以下为开发记录）

- 用户要求已有注册用户可删除并处理旧资源。已增加普通用户删除/重试清理按钮、输入用户名确认的dialog、DELETE /api/admin/users/:id；不能删除管理员/普通用户不能调用，正在运行任务或更新笔记凭据时拒绝。
- 新user_deletions表保存停用/清理状态，先撤销登录与目标邀请、取消排队任务/提醒，再停止微信并等待晚到扫码/投递，归档SB、release沙箱、删除用户目录和所属SQL行。失败保持停用供管理员重试；服务重启不恢复账号。新账号重新注册同名获得新UUID，不继承旧记忆。没有自动删除任何真实用户。
- SB归档方式为PATCH access:none、members:{}、shell关闭并回读，再删除UUID fullName归属的human/agent账户并回读确认；不DELETE Space、不删旧笔记文件，避免误判外部API删文件语义。archive索引写data/deleted-users/<uuid>.json（无密钥/正文）。历史备份保留。原个人Pi/SB不参与。
- 本地8项删除测试通过；加Pi工具/提醒/微信/MP3回归合计36项Node通过（使用--test-isolation=none确认实际测试计数），5项Python池测试通过，JS语法/diff检查通过。权限测试直接调真实HTTP handler，不开socket；SB归档测试通过注入admin响应验证，尚非真实SB验收。scripts/verify-invites-ui.mjs补齐真实删除确认和旧登录/笔记拒绝断言，只用于synthetic用户。
- 当前SSH仍socket Operation not permitted，功能/前几轮的CSS与笔记文案均未同步本轮新改动。网络恢复后先运行完整npm test，空闲时scripts/update-live.py部署（仅重启多用户后端，已有sandbox /release无需更新runner），再跑verify-invites-ui；测试删除成功会留下预期的私有测试笔记归档。确认旧笔记访问确实403/401和真实sandbox release通过后才标已上线。推送GitHub与同步服务器Git克隆仍待执行。

## 笔记密码文案简化（2026-10-14，已上线，以下为开发记录）

- 用户要求简化「我的笔记」密码设置。保持后端当前密码校验，不把会话当作修改凭据的唯一验证，也不缓存明文密码。已共用密码的账号只显示“默认使用主页密码，无需单独设置”，折叠项称“修改笔记用户名”；旧账号称“同步旧账号的笔记登录”。输入框明确“当前主页密码（用于验证）/不是设置新密码”，真正改密码指向账号安全。保存成功收起表单。
- 本轮只修改account.html/account.js及对应浏览器断言；后端认证逻辑未改。当前环境联网受限，SSH socket Operation not permitted；本地语法/diff检查后提交，尚未上线，也未能重跑公网浏览器验收。与上一节待同步的手机CSS及文档一起复制到服务器live，再推送GitHub/同步服务器Git克隆；静态文件变动无需重启Pi。

## 页面流程优化（2026-10-14）

- 用户要求优化管理/邀请/个人页面并去掉浏览器验证弹窗。根因是邀请页同时显示注册和登录；API注册本来已设置会话Cookie。现已单独显示邀请注册/失效邀请/缺失邀请状态，确认密码，注册后自动进入account；普通用户与管理员入口按role跳转。
- 管理台以邀请为主入口，增加复制链接、用户搜索/刷新、激活/重置密码入口，手动建用户折叠为高级操作。个人主页分连接与笔记/人物设定/账号安全；笔记用户名和统一密码设置、AI草稿需求折叠，设定未保存状态可见。
- Nginx只在/assistant及/assistant/关闭Basic，应用Cookie/Origin/管理员权限继续生效。原根路径个人trace与其他应用的Basic保持，SB保留原生账号认证。管理台现在只需admin应用密码，不再需要zengyuny网关口令。
- 主体已部署；备份/home/admin/.local/share/pi-agent-multi-tenant/backups/20261014-114938。现有用户/绑定摘要与原个人PID检查通过。54项Node测试通过；隔离浏览器验证单表单/确认密码/自动登录/角色跳转/失效邀请/手机布局/搜索。公网verify-invites-ui实测注册、人物设定保存、真实AI只读草稿、用户自选笔记登录与统一改密、扫码PNG，匿名管理API401/普通用户403/个人trace401，无Basic挑战，JS错误0；测试账号/笔记已按所有权清理。
- 公网手机截图发现长用户名会挤窄退出按钮；本地补flex-shrink:0/nowrap及用户名换行。当前续接会话网络限制SSH在socket阶段Operation not permitted，最后这一处CSS以及本轮文档/Git服务器同步尚未完成；主体已上线，无需回滚。网络恢复后同步public/style.css与文档（静态文件读取即时生效、不重启服务），推送GitHub并同步服务器Git克隆，再记录完成。不要重复注册测试或重启个人Pi。

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
