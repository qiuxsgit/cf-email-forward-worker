# cf-email-forward-worker

Cloudflare Email Worker：把发往你域名的邮件解析成 JSON，`POST` 给你自己的转发服务。用 [postal-mime](https://github.com/postalsys/postal-mime) 解析 MIME。

```
发往你域名的邮件
      │
      ▼
Cloudflare Email Routing ──▶ 本 Worker（解析 MIME → JSON）
                                   │  POST + Bearer token
                                   ▼
                              你的转发服务
                                   │
                                   ▼
                             你的 SMTP ──▶ 目标邮箱
```

Worker 只做四件事：解析 MIME、映射字段、带重试地投递、投不出去时兜底。不存状态、不自己发邮件。

## 接收端要你自己写

**这个仓库不带服务端实现**，只定契约。接收端要做的事就三步——按收件人查出投递目标、拼一封邮件、交给 SMTP。几十行的量，而用什么语言、规则存哪（写死在配置里/数据库/KV）、走哪家 SMTP、要不要留投递日志，全是各人的偏好，硬塞一个实现进来只会碍事。

### Worker 发出的请求

```http
POST <FORWARD_API_URL>
Authorization: Bearer <FORWARD_API_TOKEN>
Content-Type: application/json

{
  "origin_to":        "hello@mydomain.com",
  "origin_from":      "zhangsan@gmail.com",
  "origin_from_name": "张三",
  "subject":          "问询：合作事宜",
  "content":          "正文内容",
  "content_type":     "text",
  "has_attachments":  false
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `origin_to` | string | 原始收件人，**纯地址**。你按它决定投给谁 |
| `origin_from` | string | 原始发件人，**纯地址**，不带显示名 |
| `origin_from_name` | string | 原始发件人显示名，可能是空串 |
| `subject` | string | 主题，可能是空串。RFC 2047 编码的中文主题已解码 |
| `content` | string | 正文，**保证非空** |
| `content_type` | string | `text` 或 `html`，说明 `content` 是哪种 |
| `has_attachments` | bool | 原邮件是否有附件。**附件本身不传**，见下 |

字段名不合口味就改 `src/payload.js` 里 `buildPayload` 那一处，单测在 `test/payload.test.js`。

### Worker 期望的响应

**按返回体里的 `error` 字段判定，不看裸状态码。** 裸的 404 可能是你的服务在说「这个收件地址没配」，也可能是它前面的网关在说「这个路径没这个服务」（URL 配错、服务没上线）。后者要是被当成前者，再配上 `UNDELIVERABLE_ACTION=drop`，就是每一封邮件都无声消失。所以：

| 响应 | Worker 怎么理解 | 它接下来做什么 |
|---|---|---|
| 2xx | 送到了 | 收下邮件。返回体里有 `forwarded_to` 的话会进日志（可选） |
| 任意状态码 + `{"error": "no_rule"}` | 永久失败：这个收件地址没有投递目标 | 按 `UNDELIVERABLE_ACTION` 兜底，不重试 |
| 任意状态码 + `{"error": "invalid_request"}` | 永久失败：请求体不合法 | 同上 |
| 413 | 永久失败：请求体超上限 | 同上 |
| **其他一切**：5xx、401、网关的 HTML 错误页、连不上、超时 | 服务不可用 | 重试，仍不行就抛异常把邮件交回上游 MTA |

也就是说，接收端只需要在「这个地址我不认」时回 `{"error": "no_rule"}`，其余失败随便回什么，Worker 都会当成暂时性故障去重试。

另外建议给接收端加一个不鉴权的 `GET /health`。Worker 不会调它，是给你部署完 `curl` 一下用的——**能确认它真的回源到你的服务，而不是网关自己返的一句 OK**。

## 部署

```bash
npm install

# 1. 先确认服务真的在那儿
#    必须 HTTPS 公网可达——Worker 的 fetch 出不去内网
curl https://你的域名/health

# 2. URL 和 token 都存成 secret，不进配置文件（见下节）
npx wrangler secret put FORWARD_API_URL     # 形如 https://你的域名/forward
npx wrangler secret put FORWARD_API_TOKEN

# 3. 部署
npx wrangler deploy
```

然后在 Cloudflare 控制台 **Email Routing → Routes** 里，把要转发的地址（或 catch-all）的动作选成 **Send to a Worker → cf-email-forward-worker**。Email Routing 得先在这个域名上启用并验证过 MX 记录。

注意 **Email Routing 收得下、但你的服务不认的地址**会走「永久失败」分支，别忘了配 `UNDELIVERABLE_ACTION`。

## URL 和 token 放哪

两个都**不写进 `wrangler.jsonc`**——那文件要进 git。token 是密钥不必解释；`FORWARD_API_URL` 不是密钥，但它是你自建服务的公网入口，仓库公开之后就等于把这个端点挂出去让人扫，所以一起存成 secret。secret 在 Cloudflare 那边就是加密存储的环境变量，Worker 里读法完全一样。

| 场景 | 放哪 | 怎么配 |
|---|---|---|
| 线上 | Cloudflare 的加密 secret | `npx wrangler secret put FORWARD_API_URL`、`npx wrangler secret put FORWARD_API_TOKEN`（或控制台 Worker → Settings → Variables and Secrets → 类型选 Secret） |
| 本地 `wrangler dev` | `.dev.vars`（已 gitignore） | `cp .dev.vars.example .dev.vars` 再填 |

**别在 `wrangler.jsonc` 的 `vars` 里留同名条目。** 两边都写的话，`wrangler deploy` 会用配置文件里的明文值覆盖掉同名 secret——secret 白配了，明文值还进了 git。

轮换 token 时先在服务端加新的、再 `wrangler secret put`、最后撤旧的；轮换窗口里 Worker 拿到的 401 会被当成可重试，邮件不会丢。`wrangler secret put` 会在 Worker 还不存在时问你要不要顺手建一个，所以先配 secret 再 `deploy` 也行。

## 字段是怎么来的

| 请求体字段 | 来自 |
|---|---|
| `origin_to` | `message.to`（信封收件人） |
| `origin_from` | 信头 `From` 的地址，退化到 `message.from`。信头优先是因为人类回复时要找的是它，信封地址常是 `bounces+xxx@` |
| `origin_from_name` | 信头 `From` 的显示名 |
| `subject` | `email.subject` |
| `content` | `email.html` 或 `email.text` |
| `content_type` | 同上二选一，默认优先 `html` |
| `has_attachments` | `email.attachments`，**只数真附件** |

三个容易踩的地方：

- **正文两路都空时填 `（原邮件无正文）`。** 「只有附件、没有正文」的邮件很常见，`content` 透传空串多半会被接收端判成非法请求，邮件就进兜底分支了，所以这里保证它非空。
- **`cid:` 内嵌图片不算附件。** postal-mime 把 HTML 里 `cid:` 引用的图片也放进 `attachments`；算成附件的话，每封带图的营销邮件都会被标成「有附件」。
- **正文超 `MAX_CONTENT_BYTES` 按 UTF-8 字节截断**，并在尾部追加一句「已截断」（HTML 用 `<hr>` 分隔），不静默丢数据，也不切坏多字节字符。注意接收端前面的网关可能有更小的请求体上限（nginx 默认 `client_max_body_size` 只有 1MB）。

**附件本身不转发**，只传 `has_attachments` 这个布尔值。真要带附件，在 `buildPayload` 里 base64 编码 `a.content` 即可，但得在 `wrangler.jsonc` 里加 `"compatibility_flags": ["nodejs_compat"]` 才能用 `Buffer`，而且很容易撞上请求体上限。

## 投不出去的时候

| 结局 | 行为 |
|---|---|
| 送到了 | 收下邮件，记一行日志 |
| 服务不可用 | 重试 `MAX_ATTEMPTS` 次（退避 1s、3s…），仍不行就 **throw**：这封邮件没被 Worker 收下，上游 MTA 会在之后几小时里按 SMTP 规则重投。服务重启完、token 修好之后邮件自己就进来了 |
| 永久失败 | 按 `UNDELIVERABLE_ACTION` 兜底 |

`throw` 而不是 `setReject`：`setReject` 是永久拒收、发件人立刻收到退信；抛异常只是这封邮件没被收下，还有重投的机会。所以「服务挂了」这种明显会恢复的情况一律抛。

`UNDELIVERABLE_ACTION` 三选一，**必须自己选**，因为永久失败之后这封邮件在 Worker 这侧就结束了：

| 值 | 行为 | 代价 |
|---|---|---|
| `reject`（没配兜底地址时的默认） | `message.setReject()`，发件人收到退信 | 发件人知道这地址不通 —— 通常这正是你想要的 |
| `forward` | `message.forward(FALLBACK_FORWARD_TO)` | 兜底地址**必须先在 Email Routing 里验证过**，否则 forward 自己会失败（失败不吞，抛出去交回上游重投） |
| `drop` | 只留一行日志 | **邮件真的没了**，只有日志能看出来 |

## 配置项

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `FORWARD_API_URL` | 是 | — | 接收端的完整 URL，HTTPS 公网可达。用 secret 配，别进 git |
| `FORWARD_API_TOKEN` | 是 | — | 请求带的 Bearer token。用 secret 配，别进 git |
| `UNDELIVERABLE_ACTION` | 否 | 配了兜底地址则 `forward`，否则 `reject` | `reject` / `forward` / `drop` |
| `FALLBACK_FORWARD_TO` | `forward` 时必填 | — | 兜底地址，须在 Email Routing 里验证过 |
| `MAX_ATTEMPTS` | 否 | `3` | 含首次，夹在 1–5 |
| `REQUEST_TIMEOUT_MS` | 否 | `10000` | 单次请求超时，夹在 1000–30000。Workers 的 fetch 自己不超时，靠这个 abort |
| `MAX_CONTENT_BYTES` | 否 | `2000000` | 正文字节上限，夹在 1024–4500000 |
| `CONTENT_TYPE_PREFERENCE` | 否 | `html` | `html` 或 `text`，指同时有两路正文时优先哪个 |

配置缺失或非法时 Worker 直接抛异常，不会「收下邮件再丢掉」。

## 本地测试

```bash
npm test          # 22 个用例：字段映射 + 用假服务跑真 email() 的各条失败路径，不需要 workerd
```

跑真运行时（`wrangler dev` 用的是本地 workerd）：

```bash
cp .dev.vars.example .dev.vars   # FORWARD_API_URL 可以指向本机的假服务
npx wrangler dev

# 另开一个终端，给本地 Worker 投一封测试邮件
curl -X POST 'http://localhost:8787/cdn-cgi/handler/email' \
  --url-query 'from=zhangsan@gmail.com' \
  --url-query 'to=hello@mydomain.com' \
  -H 'Content-Type: message/rfc822' \
  --data-binary @mail.eml
```

`mail.eml` 是一封原始 MIME 邮件。看到 `Worker successfully processed email` 表示 `email()` 没抛异常，具体投递结果看 `wrangler dev` 那侧的日志行。

线上看日志：`npx wrangler tail --format pretty`。日志是一行 JSON，字段有 `origin_to`、`origin_from`、`content_type`、`has_attachments`、`attempts`、`elapsed_ms`。**不记录 `content`**——隐私，且日志体积会失控。

## 两个已知行为

1. **不幂等。** Worker 重试（和上游 MTA 重投）会让收信人收到重复邮件。想收紧就把 `MAX_ATTEMPTS` 设成 1，或者在接收端按 `Message-ID` 去重（那需要 Worker 也传这个字段）。
2. **`compatibility_date` 得 ≤ 本地 workerd 支持的日期。** 写成未来的日期时 `wrangler deploy --dry-run` 能过，但 `wrangler dev` 会直接起不来（报 `newest date supported by this server binary is ...`）。升 wrangler 才能往前挪。

## License

MIT
