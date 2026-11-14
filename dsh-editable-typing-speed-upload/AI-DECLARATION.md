# AI 参与声明 / AI Contribution Declaration

本文件说明本项目（`dsh-editable-typing-speed`）中人工智能参与的范围与方式，供使用者、贡献者和法律审查参考。

## 1. 谁写了什么

| 部分 | 主要作者 | 说明 |
| --- | --- | --- |
| 需求、取舍、验收、发布决定 | 人类维护者 | 决定做什么、做不做、何时发布 |
| `lib/`（宿主插件） | AI 编码代理 | 在人类指令下编写与迭代 |
| `client.js`（设置面板） | AI 编码代理 | 同上 |
| `test/`（20 个用例） | AI 编码代理 | 同上 |
| `README.md`、本声明、发布文档 | AI 编码代理起草 | 人类审阅 |

AI 编码代理指 **DeepSeek Harness**（模型标识 `deepseek-flash`）。编写过程由人类逐步指令驱动，并在每一步由人类确认结果；人类维护者对最终发布的代码负责。

## 2. 不存在第三方代码复制

- 本项目的全部实现为独立编写。
- 设计思路上参考了 [`@johnnren/dsh-im-humanize`](https://github.com/john-walks-slow/dsh-im-humanize)（MIT）的「读延迟 + 打字」两阶段模型，但**没有复制其源码**；两者实现方式不同：humanize 是 `dsh-im` 的完整分叉，本项目是独立插件，通过挂钩渠道 SDK 的原型方法实现。
- 运行时依赖 [`@tencent-connect/qqbot-nodejs`](https://www.npmjs.com/package/@tencent-connect/qqbot-nodejs)（MIT）由使用者的 DSH 环境提供，本项目**不打包、不改写、不再分发**该依赖；插件只是在运行中的进程里包裹其原型方法。

## 3. 版权与许可

- 本仓库以 **MIT** 协议发布，全文见 [LICENSE](LICENSE)。
- 部分司法辖区对「完全由 AI 生成的内容」是否享有著作权有不同规定。本项目不主张超出法律允许范围的额外权利；使用者在 MIT 条款下使用、修改、再分发即可。
- 如果某段内容被认定不可主张著作权，MIT 协议中的许可条款对「由人类维护者贡献的部分」仍然有效；两者在本项目中的边界并不影响日常使用。

## 4. 风险提示（请在使用前阅读）

- 本项目通过**修改第三方 SDK 的原型方法**（`QQBot.prototype.emit / send / sendText / sendMarkdown`）实现节奏控制。这属于注入式改动：
  - SDK 或 `dsh-im` 升级后，原型方法可能改名或改变调用约定，插件可能自动失效（不会破坏消息内容，最坏情况是节奏不再生效）；
  - 与同样修改这些方法的插件（如 `dsh-split-reply`）同时启用会互相叠加，请只保留一个。
- 本项目**不对送达结果做保证**：延迟、拆条都受平台限流与 `msg_seq` 条数限制影响。

## 5. 建议的 AI 参与标注方式

如果你要对外发布，建议同时使用以下三种标注，读者才看得到：

1. 本文件（`AI-DECLARATION.md`）；
2. Release 说明里写一句「代码由 AI 编码代理在人类指令下完成，人类维护者负责审阅与发布」；
3. 提交信息里的 co-author 尾注（见 [PUBLISHING.md](PUBLISHING.md#3-给提交加-co-author尾注)），例如：

```
Co-authored-by: DeepSeek Harness <noreply@deepseek.com>
```

> 尾注里若使用未绑定 GitHub 账号的邮箱，GitHub 只把它当作普通文本，不会在贡献者列表里生成头像；要让它成为可见贡献者，需要使用一个已注册到 GitHub 的邮箱。

## 6. 变更记录

- 2026-11-11：首次发布，代码由 DeepSeek Harness 的 `deepseek-flash` 模型在人类指令下完成。
