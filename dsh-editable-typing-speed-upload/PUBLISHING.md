# 发布指南（第一次发 GitHub / npm）

按顺序照做即可。所有 `<...>` 都是占位符，换成你自己的。

## 0. 发布前改这三处

| 文件 | 改什么 |
| --- | --- |
| `package.json` | `author`（你的名字 + 邮箱）、`repository.url` / `homepage` / `bugs.url` 里的 `OWNER` |
| `LICENSE` | `Copyright (c) 2026 ...` 的署名 |
| `README.md` | 「作者与致谢」里的 `<你的名字>` |

`package.json` 里的 `OWNER` 一共出现 3 次（repository、homepage、bugs），全换成你的 GitHub 用户名即可。

## 1. 设置 Git 身份

第一次提交前，让 Git 认识你（`--global` 只做一次）：

```sh
git config --global user.name "你的名字"
git config --global user.email "你的GitHub邮箱"
```

> 邮箱要和 GitHub 账号绑定，提交才会算到你名下。不想暴露真实邮箱，就用 GitHub 设置里给你的 `12345678+用户名@users.noreply.github.com`。

本仓库已经初始化并有一次提交。如果作者信息不对，可以在**还没推送到远程**时重写：

```sh
git commit --amend --reset-author --no-edit
```

## 2. 在 GitHub 建仓库并推送

1. GitHub → New repository → 名字填 `dsh-editable-typing-speed`。
2. **不要**勾选 “Add a README file”“Add .gitignore”“Choose a license”——本地已经有了，勾选会造成冲突。
3. 建好后按页面提示执行：

```sh
git remote add origin https://github.com/<你的用户名>/dsh-editable-typing-speed.git
git branch -M main
git push -u origin main
```

## 3. 给提交加 co-author 尾注

尾注必须放在提交信息**末尾**，前面空一行：

```
feat: humanized send pacing

Co-authored-by: DeepSeek Harness <noreply@deepseek.com>
Co-authored-by: 小明 <xiaoming@example.com>
```

两种加法：

```sh
# 新提交：用两个 -m，第二个就是空行后的正文
git commit -m "feat: ..." -m "Co-authored-by: DeepSeek Harness <noreply@deepseek.com>"

# 给最近一次提交补尾注（还没推送时用）
git commit --amend --no-edit --trailer "Co-authored-by: DeepSeek Harness <noreply@deepseek.com>"
```

注意：**尾注里的邮箱如果没有绑定 GitHub 账号，GitHub 只把它当纯文本**，贡献者列表里不会出现头像。想让某人（或某个 AI 账号）成为可见贡献者，必须用一个已注册 GitHub 的邮箱。AI 的参与标注更靠 [AI-DECLARATION.md](AI-DECLARATION.md) 和 Release 说明。

## 4. 打版本 + 发 Release（推荐先做这个）

```sh
npm pack                 # 生成 dsh-editable-typing-speed-0.2.0.tgz
git tag v0.2.0
git push origin v0.2.0
```

GitHub → Releases → Draft a new release → 选 `v0.2.0` → 把 tgz 拖进附件 → 发布。

这样别人不依赖任何 registry 就能装：

```sh
dsh plugin add https://github.com/<你的用户名>/dsh-editable-typing-speed/releases/latest/download/dsh-editable-typing-speed-0.2.0.tgz
```

## 5. 发 npm（可选）

```sh
npm login                                  # 浏览器登录
npm config get registry                    # 必须是 https://registry.npmjs.org/
npm publish --access public
```

**国内镜像站不能发布**：npmmirror（淘宝源）、华为云/腾讯云镜像都是**只读同步**，`npm publish` 会直接 403（`PUT https://registry.npmmirror.com/-/user/...` 被拒）。正确姿势是发到 npmjs，镜像会在几分钟到几十分钟内自动同步。

如果 `npm config get registry` 显示的是淘宝源，先切回去再发：

```sh
npm config set registry https://registry.npmjs.org/
```

## 6. 国内分发的三种办法

| 办法 | 说明 |
| --- | --- |
| 发 npmjs，等镜像同步 | 之后用户可以用镜像加速：`npm i --registry=https://registry.npmmirror.com`。DSH 插件管理器也支持指定 registry 并在不可达时回退 |
| GitHub Release 附 tgz | 最稳，不依赖任何 registry（但 GitHub Release 下载在国内可能慢） |
| Gitee / GitCode 镜像仓库 + Release | 把仓库镜像过去，Release 附件同样能 `dsh plugin add <url>`，国内下载快 |

## 7. 开源协议怎么处理

- 本项目用 **MIT**：别人可以自由使用/修改/再分发/商用，**唯一义务是保留版权声明与协议全文**，且作者不担保。
- GitHub 建仓后会自动识别根目录的 `LICENSE`，仓库页显示 “MIT license”。
- **不要删掉 `LICENSE` 文件**：`package.json` 的 `files` 已把它打进 npm 包，去掉会让再分发不合规。
- 想换协议？改 `LICENSE` 全文 + `package.json` 的 `license` 字段即可（换 GPL 会更严格，换 Apache-2.0 会多一条专利授权）。已经发布过的版本不能再改协议，只能对之后的新版本生效。
- 你的插件**不会**影响使用者自己的 DSH 或 `dsh-im` 的授权；本项目也不打包第三方代码，所以没有额外的 NOTICE 义务（第三方依赖的许可见各自的包）。
