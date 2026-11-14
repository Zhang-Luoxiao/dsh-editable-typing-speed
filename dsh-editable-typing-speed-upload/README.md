# dsh-editable-typing-speed

让 IM 机器人的回话**一条一条地**发出来，并且先「读」一会儿再回——只做节奏这一件事的独立插件。

它不 fork `dsh-im`，而是挂在渠道 SDK 的收发口上：装/卸本插件都在你的 profile 里，`dsh-im`（含 `@johnnren/dsh-im-humanize`）照常升级。

## 三个旋钮

| 旋钮 | 作用 | 参数 |
| --- | --- | --- |
| `readDelay` 读延迟 | 收到消息后先静默一会儿再发第一条，像“过一会儿才看到” | `baseMs` 固定反应时间、`minCharsPerSecond`–`maxCharsPerSecond` **阅读速度区间**、`maxTotalMs` 封顶 |
| `segmentGap` 段间隔 | 拆出来的两条之间的停顿，像“正在打下一条” | `baseMs` 固定停顿、`minCharsPerSecond`–`maxCharsPerSecond` **打字速度区间**、`maxTotalMs` 封顶 |
| `split` 拆条 | 一条回复怎么变成几条 | `minChars` 短于它不拆、`maxSegments` 最多几条、`sentences` 按句末标点、`paragraphs` 按空行、`protectCodeAndTables` 代码块/表格整条不拆 |

**随机只发生在速度上**：每个回合在速度区间里随机取一个速度，时间由字数算出来；`baseMs` 是固定的反应/停顿，不参与随机。

```
读延迟 = baseMs + 用户消息字数 ÷ uniform(阅读速度下限, 上限) × 1000   ≤ maxTotalMs
段间隔 = baseMs + 本条字数     ÷ uniform(打字速度下限, 上限) × 1000   ≤ maxTotalMs
```

所以同一条消息，有时快一点有时慢一点；消息越长，速度差异被放大得越明显。旧版配置（`minMs`/`maxMs` + 单一 `charsPerSecond`）会自动迁移：旧下限变成 `baseMs`，旧速度的 0.6x–1.4x 变成速度区间。

拆条是**原文的连续切片**，拼回去与原文逐字一致；带按钮（keyboard）、媒体、ark、embed 的消息一律不拆不延迟。

## 文本处理与写作风格

**纯文本处理**（不花 token，发送前做）：

- **只留对话**：去掉 `（旁白）`、`（动作）`、`*动作*`、`【提示】` 和成对引号，只发实际说出来的内容。
- **加颜文字**：每 2–3 句（可调）补一个颜文字。
- **拆称呼**：句首的称呼单独拆成一条（「张落晓。」一条、「你别磨叽。」另一条）。
- **让模型自己判别拆不拆**：写作提示里要求模型用独占一行的 `---` 分隔；没给标记就回落本地按句/段拆。

**写作风格**（注入系统提示，**全局生效**，见下）：

| 档位 | 效果 |
| --- | --- |
| 关闭 | 不注入任何写作提示 |
| 转译 | 模型原文用**英文**写，插件把英文**译回中文**再发送（**每条回复只翻译一次**，只译最后一段正文；会多一次 LLM 调用） |
| 文言 | 模型原文直接写**文言文**，原样发送 |
| 文言转译 | 模型原文写文言文 + 附信达雅白话译文，两段一起发 |
| 回答简短 | 提示模型一两句说完（与拆条无关） |

提示是**全局**的（同一 Host 下所有会话共用），所以在某个会话里输入：

```
/coding      # 这个会话进入「编码模式」：不再注入写作提示（拿不到会话作用域时退化为全局关闭）
/persona     # 恢复拟人模式
```

> 宿主只接受 `^[a-z][a-z0-9_-]*$` 的命令名，所以中文的 `/编码模式` 注册不了，实际命令是 `/coding`（描述里标注了对应关系）。

## 设置面板

插件页里 `dsh-editable-typing-speed` 这一行会多出一个「配置」入口（注册在 `plugins.row.config`，键 `dsh-editable-typing-speed#dsh-editable-typing-speed`），点开就是面板：

- 总开关、QQ 渠道开关（附带适配器是否挂上的实时状态）
- 一键预设：轻拟人 / 慢性子 / 即刻应答
- 读延迟：下限、上限、阅读速度、单回合封顶
- 段间隔：下限、上限、打字速度、单次封顶
- 拆条：按句/段拆、短于此不拆、最多几条
- 底部显示本轮统计（读延迟次数、段间隔次数、拆出条数、最近错误）

面板不依赖宿主表单契约，直接读写本插件自己的两个 HTTP 接口，所以宿主升级不会把它带崩。

## 开关

- 总开关 `enabled`，默认**关**。关掉时插件完全不介入，出站调用原样透传。
- 按渠道 `channels`，目前 `channels.qq`（默认开）；以后加渠道不改上层逻辑。

三种改法，任选：

```
/pacing                  # 看状态
/pacing on               # 全局开
/pacing off              # 全局关
/pacing qq off           # 只关 QQ 渠道
```

```
GET  /dsh-editable-typing-speed/status     # 状态、统计、适配器挂钩情况
POST /dsh-editable-typing-speed/config     # 部分配置，例如 {"enabled":true,"readDelay":{"minMs":1200}}
```

或者直接改插件配置里的 `config`（插件页的配置表单 / `cordis.patch.yml` 的该行）。改配置会让插件重启，重启期间状态（“刚刚才回过话”）保存在 `globalThis` 上，不会丢。

## 覆盖范围

| 渠道 | 状态 |
| --- | --- |
| QQ | ✅ 已实现：包 `QQBot.prototype.send / sendText / sendMarkdown`，入站借 `bot.on('message')` 采集用户消息长度 |
| 其他渠道 | 未实现。`channels` 里预留了槽位，但适配器还没写，状态接口会诚实报“未生效” |

为什么只有 QQ：dsh-im 的 Telegram / 飞书 / Discord 等桥使用它们自己的 HTTP 客户端或 SDK，没有一个「所有出站文字都经过这里」的方法可以包。QQ 是唯一有干净单点（`QQBot` 原型）的渠道。要加渠道，就在 `lib/adapters/` 下按 `qq.js` 的形状写一个：`install(bag)` 里找出站单点并 `patchPrototype`。

## 注意

- 如果同时开着会拆句/延迟的东西（`dsh-split-reply`、humanize 的「发送延迟」），会叠加成双倍停顿。**只留一个。**
- QQ 的**被动回复**对同一条用户消息的 `msg_seq` 条数有平台限制，拆得太多会被平台拒。默认 `maxSegments: 3`；某条被拒时插件停在该条、记日志、不重发（避免重复消息）。
- 读延迟只对「两分钟内有用户消息、且这条消息还没被回应过」的回合生效；主动投递、定时任务这类没有用户消息的出站不会被拖慢。
- 同批回话的后续消息走段间隔（上一条发出后 60 秒内算同一批），不会每条都重新“读”一次。

## 安装

从 GitHub / Release 附件（不依赖任何 registry，国内最省事）：

```sh
dsh plugin --profile <profile> add https://github.com/<你的用户名>/dsh-editable-typing-speed/releases/latest/download/dsh-editable-typing-speed.tgz
```

从 npm（发过之后）：

```sh
dsh plugin --profile <profile> add dsh-editable-typing-speed
```

本地目录（开发用，会以链接方式装进 profile，改代码即生效）：

```sh
dsh plugin --profile <profile> add /绝对路径/dsh-editable-typing-speed
```

装好后插件页会出现一行 `dsh-editable-typing-speed`，点「配置」进设置面板。

## 发布与协议

- 协议：**MIT**（见 [LICENSE](LICENSE)）。
- 代码全部为本仓库原创实现；思路参考了 `@johnnren/dsh-im-humanize`（MIT）的「读延迟 + 撰写」两阶段模型，但没有复制其代码。运行时依赖 `@tencent-connect/qqbot-nodejs`（MIT）由使用者的环境提供，本项目不打包、不再分发。
- AI 参与范围与责任划分见 [AI-DECLARATION.md](AI-DECLARATION.md)。
- 第一次发 GitHub / npm 的逐步操作（含 co-author 尾注、国内镜像能不能发）见 [PUBLISHING.md](PUBLISHING.md)。
- 包名 `dsh-editable-typing-speed` 在 npm 与 npmmirror 上均未被占用（2026-11-11 查过）。

## 插件市场收录

DSH 的「插件市场」是两层，机制不同：

1. **宿主内置的「发现」页** 读 **format 1 索引文档**——你可以自己发一份，不用等任何人审核：`node scripts/build-index.mjs` 生成 `index.json`，推上 GitHub（或用 jsdelivr 托管 npm 包里的那份），然后在 `插件 → 发现 → 管理索引源` 粘贴地址即可。
2. **社区索引站**（dsh.so、awesome-dsh-plugin、dshmarket）自己扫 **npm + GitHub**，再人工审核收录；它们要求 `dsh` 字段、README 安装说明、SPDX 许可证、合规的插件 id、可扫描源码与安全扫描通过，并在 GitHub 仓库加 topic `dsh-plugin`。

完整步骤、索引文档的字段与硬性要求（必须直返 200、CORS、15 秒超时）、常见坑：见 [docs/market-listing.md](docs/market-listing.md)。

## 作者与致谢

- 维护者：Zhang-Luoxiao（[GitHub](https://github.com/Zhang-Luoxiao)）。
- AI 编码代理：DeepSeek Harness（`deepseek-flash`），在人类指令下完成实现与文档初稿。
- 思路来源：[`@johnnren/dsh-im-humanize`](https://github.com/john-walks-slow/dsh-im-humanize)（MIT）。

提交里的共同署名（co-author）写法：

```
Co-authored-by: DeepSeek Harness <noreply@deepseek.com>
```

放在提交信息末尾，前面空一行。更多用法见 [PUBLISHING.md](PUBLISHING.md#3-给提交加-co-author尾注)。

## 开发

```sh
node --test                        # 20 个用例：纯函数 + 用假原型跑真实的挂钩代码路径 + 宿主生命周期
node scripts/verify-manifest.mjs   # 校验打包清单（CI 也跑这个）
node scripts/build-index.mjs       # 生成插件市场索引 index.json
```

仓库结构：

```
lib/                  宿主插件
  engine.js           纯函数：归一化、字数、读延迟、段间隔、拆条
  pacer.js            决策：这次该等吗、等多久（读 or 段间隔）
  store.js            每个聊天的状态，挂在 globalThis 上跨代际存活
  resolve.js          从当前 profile 解析渠道 SDK（同一物理文件 = 同一模块实例）
  adapters/qq.js      QQ 挂钩（幂等 + 自愈 + 失败即放行）
  index.js            apply：配置读写、/pacing 命令、HTTP 接口、5 秒自愈探针
client.js             设置面板（注册到 plugins.row.config）
cordis.patch.yml      插件行声明
locale/               插件页的标题与说明
test/                 20 个用例
scripts/              清单校验、市场索引生成
docs/                 市场收录说明
.github/              CI 与 Issue/PR 模板
```
