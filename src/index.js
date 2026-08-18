// Cloudflare Email Worker：收下发往你域名的邮件，解析后 POST 给你自己的转发服务，
// 由它决定投给谁、怎么投（接收端要实现什么见 README）。
//
// 三条投递结局：
//   delivered   —— 200，收下这封邮件，结束。
//   unavailable —— 500 / 401 / 网络错误 / 超时 / 认不出的返回，重试若干次仍不行就 throw。
//                  抛出去意味着这封邮件没被 Worker 收下，由上游 MTA 按 SMTP 规则重投，
//                  这比静默丢掉好：服务重启或 token 修好之后邮件还能自己进来。
//   undelivered —— no_rule / invalid_request / 413，重试也不会变好，按
//                  UNDELIVERABLE_ACTION 兜底（转发到备用地址 / 退信 / 丢弃）。

import PostalMime from 'postal-mime';

import { buildPayload, findPayloadProblems, DEFAULT_MAX_CONTENT_BYTES } from './payload.js';

/**
 * 只有这两个错误码算「重试也不会变好」的永久失败：no_rule（这个收件地址没有对应的
 * 投递目标）和 invalid_request（请求体不合法）。
 *
 * 刻意**按返回体里的 error 字段判定，而不是按状态码**：裸的 404 可能是你的服务在说
 * no_rule，也可能是它前面的网关在说「这个路径没有这个服务」（FORWARD_API_URL 配错、
 * 服务还没上线）。后者要是被当成 no_rule，配上 UNDELIVERABLE_ACTION=drop 就是每一封
 * 邮件都无声消失。所以认不出的返回一律当可重试，最后抛出去交回上游——宁可让发件人
 * 收到延迟或退信，也不要静默丢邮件。
 *
 * 因此 5xx（数据库挂了、SMTP 投递失败…）都会重试。401 也会：多半是 token 刚轮换错了，
 * 改回来之后上游重投还能救回来。
 */
const PERMANENT_ERRORS = new Set(['no_rule', 'invalid_request']);

/** 服务端返回体只取一小段进日志，避免把几 KB 的 HTML 错误页糊满日志。 */
const MAX_DETAIL_CHARS = 500;

const UNDELIVERABLE_ACTIONS = ['forward', 'reject', 'drop'];

export default {
  /**
   * @param {ForwardableEmailMessage} message
   * @param {Record<string, string>} env
   */
  async email(message, env, ctx) {
    // 配置不全直接抛：这时候什么都做不了，抛出去让邮件留在上游，
    // 而不是收下来再丢掉。
    const cfg = readConfig(env);
    const started = Date.now();

    const email = await PostalMime.parse(message.raw);
    const payload = buildPayload({
      envelopeTo: message.to,
      envelopeFrom: message.from,
      email,
      preferHtml: cfg.preferHtml,
      maxContentBytes: cfg.maxContentBytes,
    });

    const base = {
      origin_to: payload.origin_to,
      origin_from: payload.origin_from,
      content_type: payload.content_type,
      has_attachments: payload.has_attachments,
      // 不记录 content：隐私，且日志体积会失控。与服务端的口径一致。
      content_bytes: payload.content.length,
      raw_size: message.rawSize,
    };

    const problems = findPayloadProblems(payload);
    if (problems.length > 0) {
      log('error', '请求体不合法，不发了', { ...base, problems });
      await handleUndeliverable(message, cfg, '邮件缺少可用的收发件地址', base);
      return;
    }

    const result = await postForward(payload, cfg);
    const done = { ...base, attempts: result.attempts, elapsed_ms: Date.now() - started };

    switch (result.kind) {
      case 'delivered':
        log('info', '已交给转发服务', { ...done, forwarded_to: result.forwardedTo });
        return;

      case 'undelivered':
        log('warn', '转发服务拒收', { ...done, status: result.status, error: result.error, detail: result.detail });
        await handleUndeliverable(message, cfg, rejectReason(result), done);
        return;

      default:
        log('error', '转发服务不可用，交回上游重投', { ...done, detail: result.detail });
        // throw 而不是 setReject：setReject 是永久拒收，发件人立刻收到退信；
        // 抛异常是这封邮件没被收下，上游 MTA 会在之后几小时里反复重投。
        throw new Error(`转发服务不可用（试了 ${result.attempts} 次）: ${result.detail}`);
    }
  },
};

/** 读取并校验环境变量，顺手把默认值补齐。 */
function readConfig(env) {
  const url = trimmed(env.FORWARD_API_URL);
  const token = trimmed(env.FORWARD_API_TOKEN);
  if (!url) throw new Error('FORWARD_API_URL 未配置');
  if (!token) throw new Error('FORWARD_API_TOKEN 未配置（wrangler secret put FORWARD_API_TOKEN）');

  const fallbackTo = trimmed(env.FALLBACK_FORWARD_TO);
  // 配了兜底地址就默认转发过去，没配就默认退信——两者都比静默丢弃好。
  const action = trimmed(env.UNDELIVERABLE_ACTION).toLowerCase() || (fallbackTo ? 'forward' : 'reject');
  if (!UNDELIVERABLE_ACTIONS.includes(action)) {
    throw new Error(`UNDELIVERABLE_ACTION 只能是 ${UNDELIVERABLE_ACTIONS.join(' / ')}，得到 ${action}`);
  }
  if (action === 'forward' && !fallbackTo) {
    throw new Error('UNDELIVERABLE_ACTION=forward 需要同时配置 FALLBACK_FORWARD_TO');
  }

  return {
    url,
    token,
    fallbackTo,
    action,
    maxAttempts: int(env.MAX_ATTEMPTS, 3, 1, 5),
    timeoutMs: int(env.REQUEST_TIMEOUT_MS, 10_000, 1_000, 30_000),
    maxContentBytes: int(env.MAX_CONTENT_BYTES, DEFAULT_MAX_CONTENT_BYTES, 1_024, 4_500_000),
    preferHtml: trimmed(env.CONTENT_TYPE_PREFERENCE).toLowerCase() !== 'text',
  };
}

/** POST /forward，带重试。返回 delivered / undelivered / unavailable。 */
async function postForward(payload, cfg) {
  const body = JSON.stringify(payload);
  let detail = '未发出';
  let attempts = 0;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    if (attempt > 1) await sleep(backoffMs(attempt));
    attempts = attempt;

    let resp;
    try {
      resp = await fetch(cfg.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.token}`,
        },
        body,
        // Workers 的 fetch 自己不超时，不设 signal 就可能一直挂着。
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (err) {
      detail = `请求失败: ${err}`; // 连不上 / DNS / 超时，都可重试
      continue;
    }

    const parsed = await readBody(resp);
    const verdict = classifyResponse(resp.status, parsed);
    if (verdict.kind !== 'retry') return { ...verdict, attempts };
    detail = `HTTP ${resp.status} ${parsed.raw}`;
  }

  return { kind: 'unavailable', detail, attempts };
}

function classifyResponse(status, parsed) {
  if (status >= 200 && status < 300) {
    return { kind: 'delivered', forwardedTo: parsed.json?.forwarded_to ?? '' };
  }
  // 413 是请求体超上限（你的服务或它前面的网关限的），重投同一封没有意义。
  if (status === 413) {
    return { kind: 'undelivered', status, error: 'payload_too_large', detail: parsed.raw };
  }
  const error = parsed.json?.error ?? '';
  if (PERMANENT_ERRORS.has(error)) {
    return { kind: 'undelivered', status, error, detail: parsed.raw };
  }
  return { kind: 'retry' };
}

/** 永久失败时的兜底。哪条路走不通都要抛出去，不能把邮件吞了。 */
async function handleUndeliverable(message, cfg, reason, fields) {
  switch (cfg.action) {
    case 'forward':
      // forward 失败（兜底地址没在 Email Routing 里验证过是最常见的原因）不 catch：
      // 让它抛到上游去重投，总比这封邮件在这里凭空消失好。
      await message.forward(cfg.fallbackTo);
      log('warn', '已转发到兜底地址', { ...fields, fallback_to: cfg.fallbackTo, reason });
      return;

    case 'reject':
      // setReject 是同步的，调用后这封邮件被永久拒收，发件人会收到退信。
      message.setReject(reason);
      log('warn', '已退信', { ...fields, reason });
      return;

    default:
      log('warn', '已丢弃（UNDELIVERABLE_ACTION=drop）', { ...fields, reason });
  }
}

function rejectReason(result) {
  if (result.error === 'no_rule') return '该地址未配置转发规则';
  if (result.error === 'payload_too_large') return '邮件过大，转发服务无法接收';
  return '邮件无法被转发服务接收';
}

/** 读一小段返回体，顺带尝试解析服务端统一的 {"error","message"} 结构。 */
async function readBody(resp) {
  let raw = '';
  try {
    raw = (await resp.text()).slice(0, MAX_DETAIL_CHARS);
  } catch {
    return { raw: '<返回体读取失败>', json: null };
  }
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    return { raw, json: null }; // 网关返回的 HTML 错误页之类
  }
}

/** 1s、3s、7s…上限 10s。 */
function backoffMs(attempt) {
  return Math.min((2 ** (attempt - 1) - 1) * 1_000, 10_000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function int(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 一行 JSON 打到 stdout，和服务端的 slog 一个路子，wrangler tail 里好筛。 */
function log(level, msg, fields) {
  const line = JSON.stringify({ level, msg, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
