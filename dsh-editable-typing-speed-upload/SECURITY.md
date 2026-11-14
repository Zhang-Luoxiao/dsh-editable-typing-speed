# Security Policy

## 支持范围

只有最新发布版本接收安全修复。当前：`0.2.x`。

## 报告漏洞

**不要开公开 Issue。** 请用 GitHub 的 [Private vulnerability reporting](../../security/advisories/new)，或邮件联系维护者（见 `package.json` 的 `author`）。

请包含：影响版本、复现步骤、影响面（例如“能让任意本机进程改插件配置”）、以及你建议的修复方向。

## 已知的设计取舍（不是漏洞，但值得知道）

- 本插件通过**修改第三方 SDK 原型方法**实现节奏控制（`QQBot.prototype.emit / send / sendText / sendMarkdown`）。这属于注入式改动，权限等同于同进程内的任何 Cordis 插件。
- HTTP 控制接口 `GET/POST /dsh-editable-typing-speed/*` **没有鉴权**，只应监听本机回环地址（DSH Web 默认如此）。如果你的 DSH 暴露到局域网或公网，请自行在外层加认证，或关闭本插件。
- 插件不读取、不存储任何凭据；配置里只有数字与布尔值。
