# 怎么让插件出现在「插件市场」里

DSH 的插件市场有**两层**，机制完全不同，别混：

| 层 | 谁在读 | 数据从哪来 |
| --- | --- | --- |
| **① 宿主内置的「发现」页** | DSH 自己（`插件 → 发现 → 管理索引源`） | 你填进去的 **format 1 索引文档**（JSON），例如 `cdn.dsh.so/market/index.json`、`cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json` |
| **② 社区索引站** | dsh.so、awesome-dsh-plugin.com、dshmarket 等 | 它们自己扫 **npm registry + GitHub**（topic / keyword / 元数据），再人工审核收录 |

两条路可以同时走：②收录之后，你大概率也能在①里通过它们发布的索引源看到自己。

---

## 路线 A：自己发一份索引（半小时内生效，完全可控）

这是最快让「本机 DSH 的发现页」列出你的插件的办法，不需要等任何人审核，也不需要发 npm。

**1. 把 `package.json` 里的 `repository` / `homepage` / `author` 换成你的真实信息**（现在是 `OWNER` 占位符）。

**2. 生成索引文档：**

```sh
node scripts/build-index.mjs            # 用 GitHub 上的固定 commit 作为安装来源
# 或者发过 npm 之后：
node scripts/build-index.mjs --npm 0.2.0
```

产物是仓库根目录的 `index.json`（format 1）。它有一个最简骨架：

```json
{
  "format": 1,
  "title": { "en": "dsh-editable-typing-speed", "zh": "可调打字速度" },
  "metadata": { "categories": [], "labels": [], "sortKeys": {} },
  "plugins": [{
    "name": "dsh-editable-typing-speed",
    "versions": [{
      "version": "0.2.0",
      "publishTimestamp": 1794400000,
      "source": { "type": "git", "url": "https://github.com/OWNER/dsh-editable-typing-speed", "commit": "<sha>" },
      "engines": { "dsh": ">=0.2.0-rc.1" }
    }]
  }]
}
```

`source` 二选一：`{ "type": "npm" }`（dsh 装 `name@version`）或 `{ "type": "git", "url", "commit" }`（钉定 commit）。

**3. 把 `index.json` 推上 GitHub**，然后挑一个地址作为索引源：

- `https://raw.githubusercontent.com/<owner>/<repo>/main/index.json`
- 发过 npm 之后更省事：`https://cdn.jsdelivr.net/npm/dsh-editable-typing-speed/index.json`（`index.json` 已在 `files` 里，会随包发布）

**4. 在 DSH 里加索引源**：`插件 → 发现 → 管理索引源` → 粘贴上面的 URL。或者直接写进 profile 的 `cordis.patch.yml`：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://raw.githubusercontent.com/<owner>/<repo>/main/index.json
```

**硬性要求**（不满足会被整份拒收）：

- 地址必须**直接返回 200**，不能有跳转（DSH 用 `redirect: "error"` 抓取），不要带尾斜杠或 `www`；
- `Access-Control-Allow-Origin: *`（上面两种托管都满足）；
- 15 秒内能返回（所以别把索引放在慢的 Pages 上，jsdelivr/raw 更快）；
- `name` 唯一、是合法 npm 包名；`versions[]` 非空、精确 SemVer、`publishTimestamp` 是 Unix **秒**；
- 文档头声明的 `categories` / `labels` / `sortKeys` 才允许被条目引用。

---

## 路线 B：进社区市场（被更多人搜到）

社区站的收件标准大同小异（以 dsh.so 的公开规则为例）：

- ✅ DSH 兼容信号，至少其一：`package.json` 的 `dsh` 字段、`cordis` manifest、GitHub topic `dsh-plugin`。本项目已有 `dsh.bundle.patch` + `dsh.client`，天然满足。
- ✅ README 有安装说明（本项目有）。
- ✅ SPDX 可识别的开源许可证（MIT，有 `LICENSE`）。
- ✅ 插件 id 符合 `^[a-z0-9]+(-[a-z0-9]+)*$`（`dsh-editable-typing-speed` 符合）。
- ✅ 仓库里有可扫描的源码（JS/TS）。
- ✅ 安全扫描无阻断项：硬编码密钥、数据外传端点、破坏性操作、挖矿特征。

做法：

1. 推 GitHub 时给仓库加两个 topic：`dsh-plugin`、`deepseek-harness`（设置页 “Topics”）。这几乎是**所有**索引站的自动发现入口。
2. `package.json` 的 `keywords` 里保留 `dsh-plugin`（本项目已有）。
3. 到 **<https://www.dsh.so/zh/submit/>** 粘贴仓库地址或 npm 包名：它会自动拉源码、跑安全扫描、生成符合 schema 的条目，再让你提交审核。投稿追踪在 <https://github.com/ihuajiu/dsh-plugin-submissions>。
4. awesome-dsh-plugin 的收录走它仓库的 `contributing.md` 流程；**dshmarket（可视化市场）只允许安装 awesome-dsh-plugin 精选列表里的来源**，所以想进 dshmarket 必须先进精选列表。
5. 收录初期只会是 **Declared（声明兼容）**，不会被标成 Verified——除非有人真的在某个 DSH 版本上跑过并报告。

### 提交后多久生效

- 路线 A：立刻。
- 路线 B：每个站点的抓取节奏不同，通常数小时到一两天；npm 上的版本是它们的抓取源，所以**先发版本再提交**。

---

## 常见坑

- **索引源一直是空的**：九成是地址有跳转（`http→https`、`www`、尾斜杠），或返回了 HTML 错误页而不是 JSON。把 URL 丢进浏览器确认返回的就是 JSON。
- **收进市场但装不上**：`source.type = "npm"` 但包里缺 `lib/`（`files` 写漏）；或 `git` 源的 commit 不是 release tag 指向的那个。
- **dshmarket 里搜不到**：它只认精选列表，和 DSH 内置发现是两套数据。
- **兼容性被标红**：`engines.dsh` 写得比实际测试版本窄；先在真实 DSH 上装一遍再决定区间。
