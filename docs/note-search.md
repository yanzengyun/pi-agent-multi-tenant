# 笔记列表与 rg 搜索

`note_list` 和 `note_search` 通过当前用户受限的 SilverBullet token 访问自己的 Space。不需要浏览器、向量库或额外模型接口。当前部署状态见 [HANDOFF](../HANDOFF.md)。

| 工具 | 用途 | 参数 |
| --- | --- | --- |
| `note_list` | 只列标题、路径、修改时间、大小与链接，按最近修改排序 | `prefix` 目录，`limit` 默认20/最多50，`offset` 默认0 |
| `note_search` | rg 搜索标题和正文，返回页面链接与原文片段 | `query` 短关键词，`prefix` 目录，`limit` 默认20/最多50 |

二者均默认隐藏 `Library/`、`CONFIG.md` 和 `归档/`；明确查旧归档时传 `includeArchived: true`。列表返回 `nextOffset`，不为列目录读取每篇正文。搜索结果按页分组，每页最多3段，正文行号从1开始，标题匹配行号为0；核对全文继续调用 `note_read`。

示例：

```text
我有哪些笔记？
最近记了些什么？
列出 Journal 目录的前20篇笔记。
帮我找之前关于游泳的记录，读原文告诉我安排。
找一下归档里的旅行计划。
```

检索按字面匹配连续中文、忽略英文大小写，`.*` 等字符不解释为正则，`--files` 不解释为命令选项。助手应提取适当短关键词；它不做同义词或语义召回。数据来自服务器已保存文件，不包含浏览器未保存的编辑。

每次搜索最多扫描200页、约2MB正文；单页过大或并发删除时会计入跳过数。`incomplete` 表示扫描、匹配行或返回数量触及上限，或者有笔记被跳过；不能据此回答“整个知识库没有”。可缩小 `prefix` 或调整关键词重查。查询超时或权限失败会报错，不冒充空结果。只有受限片段返回模型，完整正文不直接注入系统提示。

后端用参数数组调用 rg，只传固定选项、字面查询和 stdin，不传宿主机目录，不执行 shell。用户身份与 Space 固定在后端闭包里；工具不接受用户ID、URL、token或本地目录。人物设定草稿仍只开放 `persona_read`。

## 部署与验证

后端运行用户的 PATH 需有 `rg`。Ubuntu 可安装：

```sh
sudo apt-get update
sudo apt-get install -y ripgrep
```

不需要更换 SilverBullet slim 镜像或启用 Runtime API。现有部署脚本会在停止服务前检查 rg 是否存在。

```sh
npm test
node scripts/verify-note-search.mjs /tmp/note-catalog-result.json
```

第二条使用独立临时 slim 容器、合成双用户和笔记，验证真实生产模块的分页、关键词匹配、归档、更新/删除刷新与隔离，结束清理临时容器和应用库。可加 `--model`，复用已配置 SDK、模型配置及环境中的 Key，额外验证真实模型调用列表及搜索→读取；明确额度耗尽时单独记录状态，不将其说成模型验证通过。测试不发送微信消息或访问真实用户笔记。

2026-10-15阿里云真实HTTP与模型18项验收通过，见[正式模块报告](../test/note-catalog-live-verification.json)：模型实际调用列表及搜索→读取，测试Space彼此隔离。

早期独立试验及资源数据见 [试验记录](note-search-trial.md)。主账号使用相同搜索模块与固定 `sb --space personal` CLI 连接，个人扩展部署在相邻私有配置项目，不读取或复制 CLI 凭据。
