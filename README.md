# workbuddy-router

轻量的 WorkBuddy / CodeBuddy 多账号工具。纯 Node（无依赖、无 Docker、无 Go），约 600 行。

两个用途：

1. **多账号每日自动签到**（已可用）——一次领完所有账号当天的 Buddy 加油站赠送积分。
2. **多账号积分统一给一个 CodeBuddy 用**（第二阶段，见文末）——不切换登录态。

## 快速开始（部署即用）

要求：macOS + Node.js ≥ 18（用到内置 fetch）。本项目**不附带任何账号凭据**，`accounts/` 目录在首次添加账号时自动生成。

```bash
# 1) 添加账号：浏览器里用【目标账号】完成授权（每个账号跑一次）
node wb.mjs login

# 2) 验证
node wb.mjs list        # 列出账号
node wb.mjs checkin     # 所有账号签到一次
node wb.mjs status      # 各账号积分余额

# 3) 起网关（要把账号池积分给 CodeBuddy 用时才需要；用完 zsh gw.sh stop 成对关闭）
zsh gw.sh start
```

## 为什么不用桌面端

桌面端点「领取」的链路是：渲染进程 → `window.wb.invoke('auth:claimDailyCheckin')` → 主进程 IPC → HTTP。
登录态存在 macOS 系统钥匙串里，脱离 GUI 拿不到，所以旧方案必须启动应用、等 50 秒、占一个调试端口。

本方案直接调**同一批 HTTP 接口**，鉴权只要 `accessToken` + `uid`（都在账号 JSON 里）：

| 用途 | 接口 |
|---|---|
| 插件授权（加账号） | `POST https://copilot.tencent.com/v2/plugin/auth/state?platform=CLI` |
| 换取 token | `GET  https://copilot.tencent.com/v2/plugin/auth/token?state=` |
| 取账号信息 | `GET  https://copilot.tencent.com/v2/plugin/login/account?state=` |
| token 续期 | `POST https://copilot.tencent.com/v2/plugin/auth/token/refresh`（refresh token 走 `X-Refresh-Token` 头） |
| **签到** | `POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin` |
| **查积分** | `POST https://www.codebuddy.cn/v2/billing/meter/get-user-resource` |

请求头：`Authorization: Bearer <accessToken>`、`X-User-Id: <uid>`、`X-CodeBuddy-Request: 1`。
不需要桌面端，单账号约 1 秒。

## 用法

```bash
cd workbuddy-router   # 进入本项目目录

# 加账号：浏览器里用【目标账号】完成登录授权（每个账号跑一次）
node wb.mjs login

# 或者：从本机 WorkBuddy 桌面端导入当前登录的那个账号
node wb.mjs import [--relaunch]

node wb.mjs list        # 列出账号
node wb.mjs status      # 各账号积分余额
node wb.mjs checkin     # 所有账号签到一次
node wb.mjs refresh     # 手动续期 token
node wb.mjs remove <uid>  # 删除账号
```

## 定时任务：每日积分日报

用任意定时任务（cron / launchd / Hermes cron 均可）每天跑一次 `node wb.mjs report`，
输出是纯文本，可直接投递到 IM / 邮箱。

日报内容 = 全部账号签到 + 各账号余额 + 较上次快照的变动 + 7 天内到期提醒。
积分快照存在 `state/credits.json`（保留最近 60 天），所以「较昨日 +300」这种对比是真实数据。

输出的样子：

```
📊 WorkBuddy 积分日报 · 2026/9/22

签到（3 个账号）
☑️ 138****0001        今日已领过
☑️ 138****0002        今日已领过
☑️ 昵称C              今日已领过

积分
     2094  138****0001
     2097  138****0002
     1750  昵称C
   ──────
     5941  合计

消耗顺序（网关按此选号）
   1. 138****0002  余额 2097  最早到期 2026/9/30
   2. 138****0001  余额 2094  最早到期 2026/9/30
   3. 昵称C  余额 1750  最早到期 2026/10/16
```

`⏰ … 有积分 X 到期（剩 N 天）` 只在 7 天内到期时出现，且只统计**还有余额**的套餐——
空套餐的到期日会造成假提醒。`node wb.mjs status` 也会列出同样的消耗顺序。

日报**不依赖网关**（纯 HTTP 直连上游），网关关着也照常发。

## 账号存储

`accounts/wb-<uid>.json`，一个账号一个文件，与官方插件 OAuth 输出同形：

```json
{
  "auth":    { "accessToken": "…", "refreshToken": "…", "expiresAt": 1794…, "domain": "www.workbuddy.cn", "realm": "cn" },
  "account": { "uid": "…", "enterpriseId": "", "nickname": "…" }
}
```

- 目录权限 `700`、文件 `600`，原子写（tmp + rename）。
- `accounts/.lock` 文件锁把「读 token → refresh → 写回」串行化——refresh token 会轮换，
  两套进程各自刷新会把对方踢下线，第二阶段网关必须复用同一份存储和同一把锁。
- 签到脚本与（未来的）网关共用这一份账号，不重复实现。

## 已知限制

- `import` 走桌面端 IPC，只拿得到 `accessToken`，**没有 refreshToken**（约 60 天有效）。
  想要自动续期就用 `login` 重新授权一次。
- 登录态失效（refresh 返回 12153 类）时该账号标记需重新登录，`checkin` 会报 `❌ …需重新登录`。

## 第二阶段：多账号积分统一给一个 CodeBuddy（已完成并实测）

`proxy.mjs` 是纯 Node 单文件网关，按需监听 `127.0.0.1:7863`（手工 `gw.sh` 受管，不使用 KeepAlive 自启）。
CodeBuddy 的请求进来后，它按剩余积分选号、把身份头换成该账号、原样透传到
`https://copilot.tencent.com/v2/chat/completions`，再流式回传。**CodeBuddy 自身登录态完全不参与。**

两个关键发现（都是实测得出，不是推测）：

1. CodeBuddy 用自定义端点时走的是 **OpenAI 协议**：`POST {CODEBUDDY_BASE_URL}/chat/completions`
   （起假服务器抓包确认），上游收的是同一格式，所以网关可以是纯透传，不需要协议转换。
2. **`models.json` 里自定义模型的 `url` 优先级高于 `CODEBUDDY_BASE_URL` 环境变量。**
   所以日常用「注册一个自定义模型」而不是设环境变量。

### 日常用法：用 `gw.sh` 开关（推荐）

网关**不常驻**。`start` 会把网关和模型注册一起做掉，`stop` 把两者一起撤掉——
这样就不会出现「选了 `wb-*` 但网关没开」的情况。**网关没开时用 `wb-*` 模型，CodeBuddy 不会
报错，而是静默卡住**（实测挂满 300 秒无任何输出），所以必须成对操作。

```bash
cd workbuddy-router   # 进入本项目目录
zsh gw.sh start      # 起网关 + 注册 wb-* 模型
zsh gw.sh status     # 网关状态 + 账号池 + 已注册模型
zsh gw.sh stop       # 移除 wb-* 模型 + 关网关（你原有模型不受影响）
zsh gw.sh log        # 网关日志
```

`panel-start.zsh` 是前台受管入口（供面板类工具挂载）：启动前注册 `wb-*`，退出时撤销注册；与手工 `gw.sh` 二选一，勿交叉启停。

之后在 codebuddy 里 `/model` 选「WorkBuddy · xxx」，或命令行指定：

```bash
codebuddy --model custom-local:wb-glm-5.3-flash
```

### 手动管理模型注册（一般不需要）

**模型名由客户端决定，网关只剥掉 `wb-` 前缀后原样透传给上游**，不锁死模型。

```bash
node wb.mjs models                # 看上游给这批账号开放了哪些模型及积分倍率
node add-to-codebuddy.mjs         # 注册 cli 推荐名单全部模型（自动备份 models.json）
node add-to-codebuddy.mjs --only glm-5.3-flash,kimi-k3-1   # 只注册指定的
node add-to-codebuddy.mjs --list  # 看已注册的 wb-* 条目
node add-to-codebuddy.mjs --remove  # 全部移除，你的原有模型不受影响
```

实测映射链路（三种客户端形态都验证过）：

```
codebuddy --model custom-local:wb-glm-5.3-flash
  → CLI 发出 model=wb-glm-5.3-flash
  → 网关剥离前缀 → model=glm-5.3-flash
  → 上游按 glm-5.3-flash 服务，积分记在账号池
网关日志: model 重写: wb-glm-5.3-flash -> glm-5.3-flash
          200 glm-5.3-flash -> 138****0001 (14058ms)
```

**选便宜模型能省很多**：倍率从 `hy3` x0.00、`deepseek-v4.1-flash` x0.03、`glm-5.3-flash` x0.06
一直到 `kimi-k3-1` x1.62、`default` x2.20（注意 `default` 实际映射到 `minimax-m3`，是最贵档）。

### 接入第二个客户端：Hermes / 任意 OpenAI SDK（已实测）

网关同时接受 OpenAI SDK 习惯的「base_url 以 /v1 结尾」形态：转发前剥掉一层 `/v1` 前缀，
`http://127.0.0.1:7863` 和 `http://127.0.0.1:7863/v1` 两种写法都行（上游没有 `/v2/v1/...` 路由，实测 404，所以必须剥）。
非流式聚合会把 tool_calls 分片按 index 拼回，agent 客户端流式/非流式都能用。

Hermes 接法（config.yaml 增加 providers 段，不动现有默认 provider；本机实际配置的 provider 名是 `codebuddy`）：

```yaml
providers:
  codebuddy:
    name: codebuddy
    base_url: http://127.0.0.1:7863
    api_key: wb-local
    api_mode: chat_completions
    models:  # 17 个 wb-* 模型（wb.mjs models 的 cli 推荐名单）
      - wb-hy3
      - wb-step-5-preview
      # …（完整清单见 config.yaml providers.codebuddy.models）
```

单次使用：`hermes chat --provider custom:codebuddy -m wb-glm-5.3-flash -q "..."`；
设为默认：`hermes config set model.provider custom:codebuddy` + `hermes config set model.default wb-glm-5.3-flash`。
实测（2026/10/12）：纯对话、终端工具调用、流式/非流式+tools、/v1 前缀路径全部通过；
wb-hy3 / wb-glm-5.3-flash / wb-deepseek-v4.1-flash 三个模型经 Hermes 实测出话正常。

**上游只支持流式**（非流式请求回 `11101 Non-stream chat request is currently not supported`），
所以网关一律以 `stream:true` 上行：客户端要流式就原样透传 SSE；要非流式（`stream:false`）
则由网关把 SSE 收全、合成一个标准 `chat.completion` 返回（tool_calls 分片会按 index 拼回，
非流式的 agent 客户端也能正常拿到工具调用）。两种客户端都不用改。

### 实测证据

```
网关日志：2026-09-22T09:34:45.165Z 200 default -> 138****0001 (2030ms)
CLI 输出：收到
积分变化：2100 -> 2098   ← 消耗的是账号池的积分，不是 CodeBuddy 自己的
```

### 选号与冷却 —— 优先消耗快到期的额度

- **按「额度到期紧迫度」排序**：先磨最早到期的那部分积分，避免积分过期作废。
  到期时间相同的，余额多的优先（少换号）。
- **粘性只在无害时保留**：当前活跃号本来就是最该用的那个才不动（利于上游 prompt cache）；
  它若不是最紧迫的就切过去——浪费快过期的额度比 cache 未命中更贵。
- **空套餐不算**：到期时间只统计 `remain > 0` 的套餐。忽略这点会把早已用完的套餐也算进来，
  让某个号看起来「马上要过期」（假信号），既选错号、日报也会误报提醒。
- **号内部不用你操心**：实测上游扣积分时**自己就优先扣最早到期的那个套餐**（见下）。
  所以「按号的最早到期时间排序」就是正确且足够的粒度，不需要也做不到更细的套餐级控制。
- 余额为 0 的号在还有其它可用号时直接跳过，不必等它 402。
- 402/额度不足 → 冷却到次日 00:01（等签到补上）；401/403 → 30 分钟；429 → 5 分钟。
- 单次请求失败会自动换号重试；`GET /pool` 按优先级排序列出各号，`GET /health` 探活。

环境变量：`WB_GATEWAY_PORT`(7863)、`WB_UPSTREAM_MODEL`（**设了会锁死模型，不要设**）、
`WB_MODEL_PREFIX`(wb-)、`WB_GATEWAY_DEBUG`、`WB_UPSTREAM_BASE`。

### 实测：积分是按「最早到期」扣的

用 `node probe-packs.mjs <昵称>` 看某个号每个套餐的余额和到期日。

取 `138****0002`（500@9/30 + 1500@10/22 + 100@10/22），发一个消耗 2.93 积分的请求，几分钟后：

```
改动前            改动后
  500  2026-09-30   497  2026-09-30   ← 只有这个动了，正好 -2.93
 1500  2026-10-22  1500  2026-10-22
  100  2026-10-22   100  2026-10-22
```

结论：**上游自己就优先扣最早到期的套餐**，且**计费有几分钟延迟**（不是实时落地）。
所以网关只需在「号」这一层做到期优先级；套餐级不用管。

⚠️ 计费延迟的副作用：刚消耗完立刻查积分可能看到**没变**，别据此判断「没扣到积分」或「走的是别的号」，
等几分钟再看。

### 卡住 / 报错的两种故障模式（别搞混）

`wb-*` 出问题只有两种形态，按症状就能定位，**不要一看到卡就先怀疑 7863**：

| 症状 | 成因 | 判据 |
|---|---|---|
| 一直转圈、几十秒到几分钟**没有任何输出也不报错** | 模型已注册（`models.json` 里有 `wb-*`、url 指向 7863），但**网关没在跑** | `lsof -nP -iTCP:7863 -sTCP:LISTEN` 为空；`state/gateway.log` 里没有任何 `<-` 行 |
| 每次都**立刻报 400** `model [...] service info not found` | 模型**没注册**。CodeBuddy 会把请求发给**它自己的官方后端**，根本不经过 7863 | 报错里的 url 是 `https://copilot.tencent.com/v2/chat/completions`；网关日志零记录 |

**关键**：`gw.sh stop` 会同时摘掉 `wb-*` 模型注册，`gw.sh start` 才重新注册。
所以「只把网关进程拉起来、没注册模型」= 第二种形态，选 `wb-*` 会一直 400。
**判断一次请求到底有没有到网关，只看网关日志里有没有 `<-` 行。** 日志位置按启动方式分两处：

- `gw.sh` 手工启动 → `state/gateway.log`（gw.sh 设了 `WB_GATEWAY_DEBUG=1`，有逐请求行）
- 其他方式启动（如 `panel-start.zsh` 被面板托管）→ 日志位置跟随托管方配置，且**可能没设 DEBUG**——
  「日志里没有记录」≠「请求没到网关」，此时改用 `lsof -nP -iTCP:7863 -sTCP:LISTEN` 确认进程在跑、
  用上游积分变动确认请求到达。

> 网关自己会不会被卡死：会——上游接了连接却不回响应头时，没有超时的 `fetch` 永不返回，
> 客户端就一直转圈。已加「等响应头」超时（默认 120s，可用 `WB_UPSTREAM_HEADER_TIMEOUT_MS` 调），
> 超时自动换号，全部号都超时则回 503。
> 用「接受连接但永不回包」的假上游实测：3 个号各 3s → **10 秒返回 503**（修复前会无限挂着）。

### 网络抽风不是网关问题

日报/签到若报 `fetch failed` / `The operation was aborted due to timeout`，那是**网络层**的瞬时问题
（常见于休眠唤醒后 VPN 隧道未重连）。过一会儿重跑 `node wb.mjs status` 通常就好了——别去改网关。
