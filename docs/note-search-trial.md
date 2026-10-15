# 笔记关键词检索试验

2026-10-15 已在独立 SilverBullet 2.12.0-slim 实例通过真实 HTTP 验收。本文保留最初原型的试验结果；列表与检索现已接入代码，工具参数见[笔记列表与搜索](note-search.md)，实际部署状态见 [HANDOFF](../HANDOFF.md)。

用户选择先使用 `rg`，不引入向量库或浏览器。原 Silversearch 插件约 116 KiB，中文分词 WASM 约 3.8 MiB；其官方 Runtime API 调用路线需要服务器浏览器。本轮完成了浏览器依赖离线下载准备，随后按用户方向切换到 `rg`，没有完成 Silversearch 实际搜索或内存测量。

## 方法与隔离

后端用当前用户受限的 SilverBullet token，通过官方文件 API 列出自己 Space 的 Markdown，并通过现有 `note_read` 传输读取正文。文件名和行号由后端保存映射，正文经 stdin 交给 `rg --fixed-strings --ignore-case --json`，查询通过参数数组传入。`rg` 没有宿主机搜索目录参数，不调用 shell；模型不能选择用户、Space、token 或服务器路径。

试验排除 `Library/` 和 `CONFIG.md`，每次最多读取 200 页、约 2 MB 正文，返回最多 20 个匹配片段。触及扫描或结果上限会返回 `limited`，不把未完整扫描说成全库无结果。结果含页名、正文行号和受限片段，标题命中行号为 0。数据来自已保存的服务器文件，不包含浏览器里未保存的编辑。

这是关键词和连续文本匹配；例如“游泳”可匹配连续中文句子中的该词。助手需要从自然语言问题中提取适当关键词，不提供同义词、向量或语义召回。

## 实测结果

原始结果：[验收报告](../test/note-search-live-verification.json)。均为虚构笔记，无真实用户内容、模型请求或微信发送。

| 检查 | 结果 |
| --- | --- |
| 中文正文、连续中文词、英文大小写、标题 | 通过 |
| `.*` 按字面匹配、`--files` 不解释为命令选项 | 通过 |
| 无结果、非法查询、返回数量上限 | 通过 |
| 修改后立即命中新词并移除旧词、删除后不再命中 | 通过 |
| A/B 搜索结果分别隔离、A token 不能列出或读取 B Space | 通过 |
| 浏览器 Runtime 实例数 | 0 |

共 14 项检查。A Space 实际扫描 103 页、124,680 字节；端到端查询约 484–615 ms，包含逐页 HTTP 读取。独立 slim 服务在采样时约 15.53 MiB，64 MiB 容器上限内没有 OOM。

另用约 490 KB 合成文本单独测量 `rg`：约 8.19 ms、最大 RSS 6 MiB，不含 SilverBullet HTTP 或 Node 后端。完整验收 Node 进程采样 RSS 约 105 MiB，包含测试数据库、HTTP、JSON 和正文缓冲，不能将 rg 的 6 MiB 当作完整服务开销。该样本只验证小型笔记空间，不代表大量笔记或并发下的性能。

## 重现

Linux 上需 Node 22.13+、Docker、`rg`，以及缓存的 slim 镜像：

```sh
docker pull ghcr.io/silverbulletmd/silverbullet:2.12.0-slim
node scripts/verify-note-search.mjs /tmp/note-search-result.json
```

脚本自行创建只绑定 loopback 的临时实例、两个虚构用户和笔记，使用临时 SQLite；结束删除本次容器与应用临时目录，仅保留指定报告。它不接受生产 URL，也不读取生产账户配置。脚本现验证正式 `NoteCatalog`，输出 `items` 和 `incomplete`，还包含分页和归档检查；上面的报告保留早期原型字段 `hits/limited`。报告中的额外 `rgStandaloneBenchmark` 为另行使用 GNU time 和合成文本采样的结果，不由上述脚本生成。
