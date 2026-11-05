# dsh-remote-access

[![CI](https://github.com/zhexuany/dsh-remote-access/actions/workflows/ci.yml/badge.svg)](https://github.com/zhexuany/dsh-remote-access/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

把 **DSH Harness Desktop** 的 Web GUI 发布给另一台机器的浏览器。

插件在本机启动一条隧道，把 Desktop 的 Web GUI（同一批会话、同一个工作区、同一套工具）映射到一个 HTTPS
域名，并交给你一条带令牌的链接——在另一台机器上打开即可操作，不需要公网 IP、端口转发或路由器配置。

> ⚠️ **分享链接等同于对 Host 所在机器的控制权。** 链接里带着本进程的 launch token，谁拿到链接，谁就能执行
> 命令、读写文件、读取会话。请把它当作密码：不要贴到群聊、不要提交进 git，不用时停止隧道。

- 平台：macOS 为主要验证平台（Windows 也可用，见 §5.1）；需要 DSH Harness Desktop **0.2.1-rc.2** 及以上（macOS 默认安装在 `/Applications/DeepSeek Harness.app`）
- 通道：Cloudflare 快速隧道（默认）、Cloudflare 命名隧道、SSH 反向隧道、自定义命令；也可以完全不开隧道，只用 `ssh -L`
- 许可：Apache-2.0（见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)）；问题反馈走 [Issues](https://github.com/zhexuany/dsh-remote-access/issues)

## 目录

- [1. 它解决什么问题](#1-它解决什么问题)
- [2. 架构](#2-架构)
- [3. 工作原理](#3-工作原理)
- [4. 安全模型](#4-安全模型)
- [5. 安装](#5-安装)
- [6. 使用](#6-使用)
- [7. 配置](#7-配置)
- [8. 连接稳定性](#8-连接稳定性)
- [9. 运行时文件](#9-运行时文件)
- [10. 排错](#10-排错)
- [11. 已知限制](#11-已知限制)
- [12. 开发与测试](#12-开发与测试)
- [13. 许可证](#13-许可证)

## 1. 它解决什么问题

DSH Harness Desktop 是一个本机应用：Host 进程在回环地址上提供 Web GUI（`127.0.0.1:<port>`），平时只服务
它自己的窗口。想在另一台设备上接手同一批任务——换台机器继续、用平板看进度、给同事演示——有两道障碍：

1. **可达性**：回环地址不对外，跨网络访问需要隧道或端口转发。
2. **授权**：Host 用 `connection.trustedHosts` 围栏校验 `Host` 头，并要求请求携带本进程的 launch token；
   域名不在围栏里直接 `403`，没有令牌则是 `401`。

这个插件把两件事一起做掉：隧道就绪时把域名发布进信任围栏（停止时收回），并生成一条带令牌的分享链接。

它不做什么：不转发到其他机器（目标始终是本机 Host），不是 VPN，不修改系统或路由器配置。

## 2. 架构

```
┌──────────────┐  HTTPS   ┌──────────────────┐  隧道   ┌─────────────┐  http  ┌─────────────────────┐
│ 另一台机器的  │ ───────▶ │ Cloudflare 边缘   │ ──────▶ │ cloudflared │ ─────▶ │ 127.0.0.1:<port>    │
│ 浏览器       │          │ （或 ssh -R 通道）│         │ （本机子进程）│        │ DSH Host 进程       │
└──────────────┘          └──────────────────┘         └─────────────┘        └─────────────────────┘
```

| 文件 | 职责 |
|------|------|
| `index.js` | bundle 入口：注册 `/remote-access` HTTP API、控制套接字与设置面板 |
| `lib/tunnel.js` | 通道抽象：启动/停止/重启 cloudflared、ssh、自定义命令，解析公网地址，失败退避 |
| `lib/fence.js` | 把隧道域名写进 / 移出 `connection.trustedHosts` 围栏（只改内存，不落盘） |
| `lib/service.js` | 状态机：启动流程、访问探测、分享链接、`state.json` / `link.txt`、日志环 |
| `lib/http.js` | 插件 API（`/remote-access/*`）与供 CLI 使用的控制套接字 |
| `client.js` | **设置 → 远程协作** 面板 |
| `bin/` | `dsh-remote-access` CLI 包装与 `install` 本地安装器 |
| `cordis.patch.yml` | bundle 声明与默认配置 |

## 3. 工作原理

### 3.1 隧道通道

| provider | 行为 | 前提 |
|---|---|---|
| `cloudflare-quick`（默认） | `cloudflared tunnel --url http://127.0.0.1:<port>`，免登录、免费、随机 `*.trycloudflare.com` 域名，每次重启都会变 | 出站 443；UDP 被屏蔽时用 `protocol: http2` |
| `cloudflare-named` | 自己的 Cloudflare 账号 + tunnel token，域名固定 | 配置 `hostname` 与 `tunnelToken` |
| `ssh` | `ssh -R` 反向隧道转发到一台可访问的跳板机 | 配置 `sshDestination` / `sshRemotePort` |
| `command` | 任意自定义命令，用 `urlPattern` 从输出里提取公网地址 | 自行保证命令可复现 |

两台机器网络互通时也可以完全不开隧道，只用 `ssh -L`（见 §6.3）。

### 3.2 一次启动的生命周期

1. 等 Desktop 的 webserver 报告监听端口（`portWaitMs`），得到 `target = http://127.0.0.1:<port>`。
2. 启动通道子进程，等待公网地址出现（`startTimeoutMs`，默认 60s；quick 隧道从 cloudflared 日志中解析域名）。
3. 把该域名发布进信任围栏（`connection.trustedHosts`，仅内存），同时刷新 Web 运行时围栏。
4. 生成分享链接（`connection.authenticatedUrl()` 附加本进程的 launch token），写入 `link.txt` 与 `state.json`。
5. 做一次访问探测（§6.4），结果记录在 `access` 里。

停止是逆过程：先收回围栏、删除 `link.txt`，再停子进程。子进程异常退出时按 1s→2s→…→30s 退避重启，
最多 `maxRestarts` 次。

### 3.3 浏览器如何拿到会话

分享链接形如 `https://<隧道域名>/?token=<launch token>`：

1. 浏览器打开链接，Desktop 校验 `token` 参数后 `303` 到 `/`，并 `Set-Cookie`：签名 cookie、`HttpOnly`、
   `SameSite=Strict`、有效期 30 天；
2. 之后的请求靠这个 cookie 认证，域名在围栏内所以 `Host` 检查通过；
3. cookie 的签名与隧道域名绑定——**域名一变旧 cookie 即失效**，必须打开新链接；
4. launch token 由 Host 进程启动时生成、只在本进程内有效；Desktop 重启后旧链接全部失效。

## 4. 安全模型

隧道域名本身**不是**凭证。进入 GUI 需要同时满足两层：

### 4.1 信任围栏：`connection.trustedHosts`

Host 只接受 `Host` 头在信任列表里的请求，否则返回 `403`。Desktop 启动时会重写自己的运行时补丁
（其中只有回环与局域网地址），所以插件在隧道就绪时把域名推进**内存里的围栏**，停止时移除，不修改
Desktop 的任何配置文件。

这一层同时保护 DSH 自带的文件读取面：Session 文件预览器、`/api/file`、侧边栏的 `/sidebar/file` 与
`/sidebar/html` 走同一道围栏，不会因为开了隧道就变成公网可读的静态目录。

### 4.2 令牌 → Cookie

链接里的 launch token 只有本进程知道，`GET /?token=…` 是用它兑换 cookie 的唯一入口；cookie 由 Desktop
签名并绑定域名。没有链接就换不到 cookie，只知道域名进不来。

### 4.3 边界

- 插件**不提供**任何绕过上两层的开关。能让浏览器进来的只有「域名在围栏里」和「链接带令牌」，前者由插件
  在隧道就绪时发布、停止时收回，后者由进程内的 launch token 决定。
- 插件自己的 API（`/remote-access/status|start|stop|restart|link|logs`）同样先过这两层：没有 cookie 是
  `401`，域名不被信任是 `403`。只知道域名的人既看不到 GUI，也控制不了这条隧道。
- 传输安全由通道提供：quick / named 走 Cloudflare 的 TLS，`ssh -L` 走 SSH。
- 真正的薄弱点是人：链接一旦泄露就等于交出控制权。停止隧道会立刻回收围栏并从磁盘删除链接。

## 5. 安装

### 5.1 通过 dsh 命令（推荐）

先安装随 Desktop 分发的 `dsh` 命令（Desktop 里的 **Manage dsh Command…**），完全退出 Desktop，然后：

```sh
dsh plugin --profile desktop add git+https://github.com/zhexuany/dsh-remote-access.git
```

插件需要 `cloudflared`，任选一种方式提供：

```sh
brew install cloudflared
# 或把二进制放到 <DSH_HOME>/remote-access/bin/cloudflared
```

重新打开 Desktop，在 **设置 → 远程协作** 启动隧道。共享安装默认 `autoStart: false`，不会自动开公网隧道。

> 通过 `dsh plugin add` 安装时源码已经在 profile 的 `node_modules` 里，不要再跑下面的 `bin/install` 复制一份。

> **Windows**：核心插件是纯 Node 实现，没有 macOS 专属依赖。用 `dsh plugin add` 安装，把 `cloudflared.exe`
> 放进 `PATH`（或 `<DSH_HOME>\remote-access\bin\cloudflared.exe`），然后在 **设置 → 远程协作** 启动。
> `bin/dsh-remote-access` 与 `bin/install` 是 POSIX shell 脚本，Windows 上改用 `node bin/cli.mjs`（§6.2）。

### 5.2 本地安装器（开发 / 离线，macOS / Linux）

```sh
git clone https://github.com/zhexuany/dsh-remote-access.git
cd dsh-remote-access
./bin/install --dry-run   # 先看它会做什么，不写任何东西
./bin/install             # 装进 ~/.dsh/profiles/desktop（默认复制一份快照）
```

安装器做五件事：

| # | 动作 | 位置 |
|---|------|------|
| 1 | 把插件目录复制（或软链）进 profile | `<profile>/node_modules/dsh-remote-access` |
| 2 | 登记依赖（`file:` 或 `link:`）并把插件名加入 `dsh.profile.bundles`，原文件先备份 | `<profile>/package.json` |
| 3 | 放置一份 cloudflared | `<DSH_HOME>/remote-access/bin/cloudflared` |
| 4 | （可选 `--enable-browser-access`）置 `browserAccess: true`，只有 0.2.1-rc.2 及更旧的 Host 会读它 | `<DSH_HOME>/desktop-preferences.json` |
| 5 | 写入受管的「mux 心跳覆盖」段（见 §8），原文件先备份 | `<profile>/cordis.patch.yml` |

常用选项：

```
--home <dir>            DSH_HOME（默认 ~/.dsh）
--profile <name>        profile 名（默认 desktop）
--copy | --link         复制快照（默认）或软链（改代码即生效，适合开发）
--no-cloudflared        不放置 cloudflared（用 PATH 里或 Homebrew 的）
--heartbeat-ms <ms>     写进 profile 补丁的心跳间隔（默认 15000）
--no-heartbeat          不写（或删除）那段受管心跳覆盖
--uninstall             卸载（只回收自己写入的依赖、软链与心跳覆盖）
--dry-run / --json
```

生效方式：

- 运行中的 Desktop 会热加载新安装的 bundle，不用重启；
- **网页界面需要刷新一次**才会出现设置面板（面板来自客户端的 `client.js`，已加载的页面不会自动取新 bundle）；
- 只有改 Desktop 端口才会触发 Host 重启；替换已经加载过的插件代码也需要重启一次 Desktop（Host 不会重新
  import 已加载的模块）；
- `--copy`（默认）装的是快照，改完源码要重跑 `./bin/install`；想边改边生效用 `./bin/install --link`。

## 6. 使用

### 6.1 GUI：设置 → 远程协作

面板显示状态灯（未启动 / 启动中 / 已就绪 / 失败）、本地地址、隧道方式、隧道地址、**连接链接**、
**本机链接**，以及启动 / 停止 / 重启、「详情」与日志。

- 首次使用：点 **启动** → 等链接出现（quick 隧道通常 5–20 秒）→ 复制 → 在另一台机器的浏览器里打开，
  该浏览器此后 30 天免令牌（cookie 与域名绑定，域名一换就要重新点新链接）；
- 不用时点 **停止**，旧域名立刻失效；
- 「本机链接」配合 `ssh -L` 使用（§6.3）；
- 探测到 `403` 时面板顶部会提示先检查围栏、重启一次隧道再分享。

### 6.2 CLI

```sh
./bin/dsh-remote-access status          # 状态、公网地址、分享链接、本机链接
./bin/dsh-remote-access link            # 只打印分享链接（方便 pbcopy）
./bin/dsh-remote-access link | pbcopy
./bin/dsh-remote-access start|stop|restart
./bin/dsh-remote-access logs            # 最近 200 行（含 cloudflared 自己的输出）
./bin/dsh-remote-access open            # 用本机浏览器打开分享链接
./bin/dsh-remote-access status --json   # 完整状态 JSON
```

以上示例使用 POSIX shell 包装脚本；Windows 上的等价写法是 `node bin/cli.mjs status|link|start|stop|...`。

CLI 通过回环控制套接字（`<DSH_HOME>/remote-access/control.json`，0600）操作运行中的 Host；Host 不在时
退回读取落盘的 `state.json` / `link.txt`。所有命令都接受 `--home <dir>`。

`bin/dsh-remote-access` 只适用于 POSIX（macOS / Linux）：它会尝试用 Desktop 自带的 Node 运行
（`DSH_NEXT_APP` 可显式指定 `.app` 路径），找不到时使用 PATH 里的 `node`；Windows 上直接调用 `node bin/cli.mjs`。

`browser-access` 是旧版本的兼容入口，仍然接受但不再改变任何行为——Desktop 0.2.1-rc.3 起已经没有
「允许在浏览器中打开」这个开关。

### 6.3 只用 ssh -L（不暴露公网）

两台机器网络互通（同一局域网，或你能 ssh 到 Host 所在机器）时可以完全不开隧道：

```sh
# 在另一台机器上执行；8080 换成那台机器上任意空闲端口
ssh -N -L 8080:127.0.0.1:<Desktop 端口> user@<Host 地址>
```

然后在**那台机器**的浏览器里打开面板给出的 **本机链接**（`http://127.0.0.1:8080/?token=…`）。流量只在
SSH 里，不经过 Cloudflare。

注意 cookie 按 `host:port` 绑定签名：**换了 `-L` 端口就要重新复制一次本机链接**，`-L` 端口的 cookie 与
隧道域名的 cookie 互不通用。

### 6.4 访问探测

面板每次拉状态时会带 `sec-fetch-site: same-origin` 探一次本机端口，结果在「详情」的 `access` 里：

| 探测结果 | 含义 |
|---|---|
| `401`（`token-required`） | 健康：围栏已生效，只认带令牌 / cookie 的请求 |
| `200` / `303`（`open`） | 端口可访问且不要求令牌（通常是回环豁免） |
| `403`（`refused`） | 连隧道域名都被围栏拒绝，先重启一次隧道再分享 |

## 7. 配置

改 `cordis.patch.yml` 中 `- id: dsh-remote-access` 的 `config:`，或在 profile 的同名补丁里用同一 `id`
覆盖（**patch 的 config 是整体替换，不做深合并**），然后重启 Desktop。

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | `true` | 关掉后插件不注册任何路由 |
| `autoStart` | `false` | 共享安装默认不自动开公网隧道；改为 `true` 则 Host 启动即开。面板点「停止」会记住 `desired: stopped` |
| `provider` | `cloudflare-quick` | `cloudflare-quick` / `cloudflare-named` / `ssh` / `command` |
| `protocol` | `http2` | `http2` / `quic` / `auto`；UDP/QUIC 被屏蔽时必须用 `http2` |
| `cloudflaredPath` | 自动探测 | 顺序：本项 → `<DSH_HOME>/remote-access/bin/cloudflared` → 包内 vendor → Homebrew → PATH |
| `hostname` | — | `cloudflare-named` 用，例如 `dsh.example.com` |
| `tunnelToken` | — | `cloudflare-named` 用（`cloudflared tunnel run --token`） |
| `publicUrl` | — | 手动指定公网地址（不自动探测时用） |
| `sshDestination` / `sshRemotePort` | — | `ssh -R` 反向通道 |
| `command` / `urlPattern` | — | 自定义通道：命令数组 + 从输出里提取公网地址的正则 |
| `urlPattern` | quick 隧道内置 | 覆盖默认的 URL 探测正则 |
| `extraTrustedHosts` | `[]` | 额外要塞进围栏的域名 |
| `maxRestarts` | `5` | 通道异常退出后的重启次数（退避 1s→2s→…→30s 封顶） |
| `startTimeoutMs` | `60000` | 等待隧道就绪的上限 |
| `portWaitMs` | 内建 | 等待 Desktop 端口开始监听的上限 |
| `logLines` | `200` | 内存日志环形缓冲行数 |
| `keepAliveMs` | `65000` | 把 Host 的 `node:http` `keepAliveTimeout` 抬到多少毫秒（`0` = 不动），见 §8 |
| `proxyKeepAliveMs` | `keepAliveMs - 5000` | 传给 cloudflared 的 `--proxy-keepalive-timeout`，必须短于 origin keep-alive |
| `healthCheckMs` | `15000` | 公网 URL 健康检查间隔（`0` = 关闭）：只有落到 Host 的 200/303/401/403 算健康，见 §8 |
| `healthCheckTimeoutMs` | `8000` | 单次健康检查的超时 |
| `healthFailures` | `3` | 连续失败多少次后重启 cloudflared（quick 隧道会换新地址与链接） |
| `healthDnsGraceMs` | `120000` | 新 quick 域名刚生成时 DNS 可能还没生效；这段时间的解析失败（`ENOTFOUND`/`EAI_AGAIN`）不计入失败 |
| `tunnelLogLevel` | `info` | 传给 cloudflared 的 `--loglevel`（`debug` 能看清边缘连接细节） |
| `tunnelLogBytes` | `1000000` | 日志超过这个字节数就滚成 `tunnel.log.1` |
| `home` | 自动探测 | 强制指定 `DSH_HOME` |

`enabled` / `autoStart` 只影响隧道本身；面板上的临时开关是一次性动作，故意不落盘。

## 8. 连接稳定性

浏览器与 Host 之间是一条 WebSocket（`/api/remote.mux`）：Host 每 **2 秒** ping 一次，连续两次没有 pong
就 `terminate()` 这条 socket，前端于是显示「重新连接中」并按 0.5s→10s 退避重连。任务都在 Host 上执行，
闪断不会丢任务。

公网路径上「pong 迟到」比「链路断开」更常见：浏览器标签页被节流、网络切换、边缘连接被回收，都可能连续
错过两次心跳。插件为此先做了四件事（前两项需要**重启一次 Desktop** 才生效）：

1. **放宽心跳**：安装器往 profile 补丁写一段受管的 `typert-gateway` 覆盖，把 `websocketHeartbeatIntervalMs`
   从 2000 调到 15000——要连丢两次包得跨 30 秒才致命；
2. **让代理连接先过期**：cloudflared 默认把 origin 连接保留约 90s，而 Node 的 keep-alive 是 65s；插件默认传
   `--proxy-keepalive-timeout 60s`，避免复用已被回收的连接；
3. **抬高 origin keep-alive**：把 `webServer.server.keepAliveTimeout` 抬到 `keepAliveMs`（默认 65s），并把
   `headersTimeout` 提到至少 70s；
4. **日志落盘**：cloudflared 输出与插件日志都追加进 `tunnel.log` 并按大小滚动，边缘连接有没有在重连才有
   证据可查，而不是只有一个内存环。

这些手段只能降低「重新连接中」的概率，不能消除：公网隧道本身会抖。

还有一类故障不走「重新连接中」：cloudflared 的进程不退出，但它和边缘的连接已经作废——典型是 quick 隧道在
Cloudflare 侧的记录被回收，日志里反复出现 `Unauthorized: Tunnel not found`。这时面板仍显示「已就绪」，链接
却只会返回 502/530/1033。插件为此再做了第五件事：

5. **公网 URL 看门狗**：隧道就绪后每 `healthCheckMs`（默认 15s）请求一次公网地址，不带令牌；只有拿到 Host
   的应答（401 是健康答案，200/303/403 也算通）才记为健康。连续 `healthFailures`（默认 3）次失败就杀掉
   cloudflared 并重新拉起——quick 隧道会生成新地址、写一份新链接。新域名刚生成时 DNS 可能还没生效，这段时间的
   解析失败不算失败（`healthDnsGraceMs`，默认 120s），否则换了新域名反而会被自己误杀。`healthCheckMs: 0` 可以关掉它。

## 9. 运行时文件

```
<DSH_HOME>/remote-access/          # 目录权限 0700
├── state.json      # desired / state / url / pid / target / provider / attempts（0600）
├── link.txt        # 分享链接纯文本（0600）
├── control.json    # CLI 用的回环控制端口 + 令牌（0600）
├── tunnel.log      # 隧道输出与插件日志（0600，超过 1MB 滚成 tunnel.log.1）
└── bin/cloudflared # 安装时放置的二进制（可选）
```

`state.json` 记住上次是运行还是停止，Desktop 重启后由 `autoStart` 与它共同决定是否恢复隧道。

## 10. 排错

| 现象 | 处理 |
|------|------|
| 403 `host not trusted`，或探测 `refused` | 域名没进围栏。重启一次隧道（停止→启动），再看「详情」里的 `trustedHosts` |
| 链接打开 401 | 用了旧链接或书签。隧道域名换过，重新复制最新链接 |
| 一直「启动中」，日志 `failed to dial to edge with quic: timeout` | UDP 被屏蔽，改用 `protocol: http2` |
| 刚看到域名，本机 curl 解析不了 | 本机缓存了 NXDOMAIN，等一分钟或换 DNS；`curl --resolve <域名>:443:<边缘 IP>` 可绕过 |
| 页面反复「重新连接中」 | 见 §8。确认心跳覆盖与 `keepAliveMs` 已随 Desktop 重启生效，再看 `tunnel.log` |
| 端口不对 | 端口来自 Desktop 的 `desktop-preferences.json`（0 为随机）；插件直接读 Host 实际监听的端口，通常不用管 |
| 想彻底关掉自动隧道 | 默认就是关的；若被覆盖成 `true`，面板点一次停止（记住 `desired: stopped`），或改回 `false` 后重启 Desktop |
| `ssh -L` 打开却 401 | 本机链接按 `host:port` 签发，换端口后重新复制一次 |
| 改了源码但界面没变化 | 面板改动刷新页面即可；Host 侧改动必须重启 Desktop，因为 Host 不会重载已 import 的模块 |

## 11. 已知限制

- 目标只能是本机回环上的 DSH Host（不做「转发到另一台机器」）。
- 主要验证平台是 macOS。Windows 上核心逻辑（隧道、围栏、面板）是纯 Node，可以运行；但 `bin/dsh-remote-access`
  与 `bin/install` 是 POSIX shell 脚本，仓库内 vendor 的 cloudflared 也只有 darwin-arm64——Windows 需要自备
  `cloudflared.exe`，并用 `dsh plugin add` 安装、`node bin/cli.mjs` 调 CLI。
- `cloudflare-quick` 的域名每次重启都会变（Cloudflare 免费行为）；需要固定域名请用 `cloudflare-named`。
- `ssh` / `command` 通道是通用后备，需要自备可用的 SSH 目标或命令；这两条路径没有随项目做端到端验证。
- 单实例：面板与 CLI 操作的都是同一条隧道（同一个 Host 进程）。
- 访问模型跟着 Host 走：跨机访问完全依赖「围栏 + 链接令牌」两层，插件不提供第三层开关。
- 面板是用自带的轻量 React 组件实现的（不依赖 Harness 内部包），颜色跟随主题变量，深色/浅色都可用，但
  视觉细节不会与 Desktop 自带设置页完全一致。
- 「重新连接中」只能被降低概率，不能被消灭（§8）。

## 12. 开发与测试

```sh
./test/run-tests.sh   # 离线测试：service-unit + installer-unit + client-smoke
npm test              # service-unit + installer-unit
```

| 套件 | 覆盖 |
|------|------|
| `test/service-unit.mjs` | Host 侧逻辑：本机链接签发、访问探测分类、keep-alive 调优、隧道日志落盘、`browser-access` 兼容入口行为 |
| `test/installer-unit.mjs` | 安装器：bundle 注册、清单备份、受管心跳块、重复安装幂等、`--dry-run`、`--uninstall` |
| `test/client-smoke.mjs` | 无头加载 `client.js`，验证面板注册、渲染、请求路径与状态提示；离线可跑，也可 `--live <url>` 打真隧道 |
| `test/client-react.mjs` | 用真实 React 渲染面板，守住 hook 顺序等不变量；依赖装在仓库外，缺失时跳过 |

CI（`.github/workflows/ci.yml`）在 `macos-latest` + Node 22 上跑语法检查与三个离线套件。

欢迎 issue 与 PR；提交信息使用 Conventional Commits。

## 13. 许可证

Apache License 2.0，全文见 [LICENSE](LICENSE)。著作权与归属见 [NOTICE](NOTICE)：

```
dsh-remote-access
Copyright 2026 Zhexuan Yang
```

---

## English summary

`dsh-remote-access` is a DSH bundle + web client plugin that publishes a running DSH Harness Desktop Web GUI
to a browser on another machine. It starts a tunnel to the Desktop's loopback port (a Cloudflare quick tunnel
by default; named tunnels, `ssh -R` and custom commands are also supported), hands you a link carrying the
process launch token, and publishes the tunnel hostname into `connection.trustedHosts` while the tunnel is up.
No public IP, port forwarding or router changes are required. If the two machines can already reach each
other, `ssh -N -L 8080:127.0.0.1:<port>` plus the panel's loopback link works without any tunnel.

Access is guarded by two independent layers: the trusted-host fence (a request whose `Host` is unknown gets
`403`) and the launch-token-to-cookie exchange (`GET /?token=…` mints a signed, `HttpOnly`, `SameSite=Strict`
cookie bound to the tunnel hostname, valid for 30 days). The plugin never offers a switch that bypasses
either layer, and its own `/remote-access/*` endpoints are authenticated the same way. A share link is
equivalent to full control of the host machine — treat it as a secret, and stop the tunnel when done.

Because the GUI talks to the Host over a single WebSocket that is pinged every 2s and killed after two missed
pongs, the installer writes a managed `typert-gateway` override (`websocketHeartbeatIntervalMs: 15000`) into
the profile patch, passes `--proxy-keepalive-timeout 60s` to cloudflared, raises the origin `keepAliveTimeout`
(`keepAliveMs`, default 65s) and rotates tunnel logs on disk. The first two need one Desktop restart. The
supervisor also polls the public URL itself (`healthCheckMs`, 15s) and restarts cloudflared after
`healthFailures` (3) consecutive misses, because a dead edge connection — a quick tunnel whose record is gone,
for instance — retries forever without exiting and would otherwise leave a "ready" panel behind a URL that
answers 502/530/1033. These measures reduce, but cannot eliminate, transient reconnects on a public tunnel.

The plugin is developed and validated on macOS. The tunnel service, the trusted-host fence and the settings
panel are plain Node/DOM code, so a Windows host works too once the plugin is installed with `dsh plugin add`
and a `cloudflared` binary is on `PATH`; the shell wrappers under `bin/` are POSIX-only.

Licensed under the Apache License 2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
