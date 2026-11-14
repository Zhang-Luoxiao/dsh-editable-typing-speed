# Contributing

感谢你愿意花时间。这个项目很小，规则也短。

## 报 Bug / 提需求

- 先搜一下 [Issues](../../issues) 有没有重复。
- 报 Bug 请带上：DSH 版本、`dsh-im` 版本、渠道（目前仅 QQ）、复现步骤、`/dsh-editable-typing-speed/status` 的输出（会告诉你适配器有没有挂上）。
- 安全相关问题**不要**开公开 Issue，见 [SECURITY.md](SECURITY.md)。

## 提交代码

1. Fork 并新建分支：`feat/xxx`、`fix/xxx`。
2. 改动要有测试：`node --test` 必须全绿（当前 20 个用例）。
3. 提交信息用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：`feat:`、`fix:`、`docs:`、`chore:`、`refactor:`、`test:`。
4. PR 描述里写清楚：改了什么、为什么、怎么验证的。

## 代码约定

- ESM，Node ≥ 22，不引第三方运行时依赖（渠道 SDK 由使用者的 DSH 环境提供）。
- `lib/engine.js` 保持**纯函数**：不碰 Node API、不碰渠道 SDK，方便测试。
- 任何挂钩渠道 SDK 的代码必须满足三条：**幂等**（原型上留标记）、**自愈**（5 秒探针）、**失败即放行**（异常不能吞掉回复）。
- 用户可见文本用中文，代码注释用中文；标识符用英文。

## 提交里标注 AI 参与

如果你用 AI 参与了改动，请在提交信息末尾加尾注（本项目默认这么做）：

```
Co-authored-by: DeepSeek Harness <noreply@deepseek.com>
```
