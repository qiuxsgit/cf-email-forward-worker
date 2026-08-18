// 用一个假的转发服务跑真正的 email() 处理函数。
// src/index.js 只用了 fetch / AbortSignal.timeout / setTimeout，Node 20 上都有，
// 所以不必起 workerd 就能验证请求体字段名、鉴权头和三条失败路径。

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';

import worker from '../src/index.js';

const RAW = [
  'From: =?utf-8?B?5byg5LiJ?= <zhangsan@gmail.com>',
  'To: hello@mydomain.com',
  'Subject: =?utf-8?B?6Zeu6K+i?=',
  'Content-Type: text/plain; charset=utf-8',
  '',
  '正文内容',
].join('\r\n');

/** @returns {Promise<{url: string, requests: object[], close: () => void}>} */
async function stubService(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests.push({ method: req.method, auth: req.headers.authorization, body: JSON.parse(body) });
      handler(res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/forward`;
  return { url, requests, close: () => server.close() };
}

function fakeMessage() {
  const calls = { forwarded: [], rejected: [] };
  return {
    to: 'hello@mydomain.com',
    from: 'zhangsan@gmail.com',
    raw: RAW,
    rawSize: RAW.length,
    forward: async (addr) => calls.forwarded.push(addr),
    setReject: (reason) => calls.rejected.push(reason),
    calls,
  };
}

const baseEnv = (url) => ({
  FORWARD_API_URL: url,
  FORWARD_API_TOKEN: 'secret-forward-token',
  MAX_ATTEMPTS: '2',
  REQUEST_TIMEOUT_MS: '2000',
});

test('200：请求体就是约定的那 7 个字段', async () => {
  const svc = await stubService((res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ forwarded_to: 'me@gmail.com' }));
  });
  after(svc.close);

  const message = fakeMessage();
  await worker.email(message, baseEnv(svc.url), {});

  assert.equal(svc.requests.length, 1);
  const req = svc.requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.auth, 'Bearer secret-forward-token');
  assert.deepEqual(req.body, {
    origin_to: 'hello@mydomain.com',
    origin_from: 'zhangsan@gmail.com',
    origin_from_name: '张三',
    subject: '问询',
    content: '正文内容',
    content_type: 'text',
    has_attachments: false,
  });
  assert.deepEqual(message.calls.forwarded, []);
  assert.deepEqual(message.calls.rejected, []);
});

test('404 no_rule：默认退信，不重试', async () => {
  const svc = await stubService((res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no_rule', message: '没有 hello@mydomain.com 的转发规则' }));
  });
  after(svc.close);

  const message = fakeMessage();
  await worker.email(message, baseEnv(svc.url), {});

  assert.equal(svc.requests.length, 1, '永久失败不该重试');
  assert.deepEqual(message.calls.rejected, ['该地址未配置转发规则']);
});

test('404 no_rule：配了兜底地址就转发过去', async () => {
  const svc = await stubService((res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no_rule', message: 'x' }));
  });
  after(svc.close);

  const message = fakeMessage();
  await worker.email(message, { ...baseEnv(svc.url), FALLBACK_FORWARD_TO: 'me@gmail.com' }, {});

  assert.deepEqual(message.calls.forwarded, ['me@gmail.com']);
  assert.deepEqual(message.calls.rejected, []);
});

test('500 smtp_failed：重试到上限后抛出，邮件交回上游 MTA', async () => {
  const svc = await stubService((res) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'smtp_failed', message: 'SMTP 投递失败' }));
  });
  after(svc.close);

  const message = fakeMessage();
  await assert.rejects(() => worker.email(message, baseEnv(svc.url), {}), /转发服务不可用（试了 2 次）/);
  assert.equal(svc.requests.length, 2);
  assert.deepEqual(message.calls.rejected, [], '服务不可用时不能退信');
  assert.deepEqual(message.calls.forwarded, []);
});

test('500 之后恢复：第二次成功就算成功', async () => {
  const svc = await stubService((res, n) => {
    if (n === 1) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: '数据库查询失败' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ forwarded_to: 'me@gmail.com' }));
  });
  after(svc.close);

  const message = fakeMessage();
  await worker.email(message, baseEnv(svc.url), {});
  assert.equal(svc.requests.length, 2);
  assert.deepEqual(message.calls.rejected, []);
});

test('401：当可重试，最终抛出而不是退信（token 改回来还能救）', async () => {
  const svc = await stubService((res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized', message: 'token 缺失或不匹配' }));
  });
  after(svc.close);

  const message = fakeMessage();
  await assert.rejects(() => worker.email(message, baseEnv(svc.url), {}));
  assert.equal(svc.requests.length, 2);
  assert.deepEqual(message.calls.rejected, []);
});

test('连不上服务：抛出，邮件不丢', async () => {
  const message = fakeMessage();
  const env = { ...baseEnv('http://127.0.0.1:1/forward'), MAX_ATTEMPTS: '1' };
  await assert.rejects(() => worker.email(message, env, {}), /不可用/);
  assert.deepEqual(message.calls.rejected, []);
});

test('配置缺失或非法：直接抛，绝不静默收下邮件', async () => {
  const message = fakeMessage();
  await assert.rejects(() => worker.email(message, {}, {}), /FORWARD_API_URL 未配置/);
  await assert.rejects(
    () => worker.email(message, { FORWARD_API_URL: 'https://x/forward' }, {}),
    /FORWARD_API_TOKEN 未配置/,
  );
  await assert.rejects(
    () => worker.email(message, { ...baseEnv('https://x/forward'), UNDELIVERABLE_ACTION: 'bogus' }, {}),
    /UNDELIVERABLE_ACTION 只能是/,
  );
  await assert.rejects(
    () => worker.email(message, { ...baseEnv('https://x/forward'), UNDELIVERABLE_ACTION: 'forward' }, {}),
    /需要同时配置 FALLBACK_FORWARD_TO/,
  );
});

test('网关的裸 404：当服务不可用抛出，不能误判成 no_rule 把邮件丢掉', async () => {
  const svc = await stubService((res) => {
    // FORWARD_API_URL 配错、服务没上线时，前面的网关就是这个返回。
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html><head><title>404 Not Found</title></head><body>nginx</body></html>');
  });
  after(svc.close);

  const message = fakeMessage();
  const env = { ...baseEnv(svc.url), UNDELIVERABLE_ACTION: 'drop' };
  await assert.rejects(() => worker.email(message, env, {}), /不可用/);
  assert.equal(svc.requests.length, 2, '认不出的返回要重试');
});

test('413：请求体超上限，重投同一封没意义，走兜底', async () => {
  const svc = await stubService((res) => {
    res.writeHead(413, { 'Content-Type': 'text/html' });
    res.end('<html>413 Request Entity Too Large</html>');
  });
  after(svc.close);

  const message = fakeMessage();
  await worker.email(message, baseEnv(svc.url), {});
  assert.equal(svc.requests.length, 1);
  assert.deepEqual(message.calls.rejected, ['邮件过大，转发服务无法接收']);
});

test('UNDELIVERABLE_ACTION=drop：只留日志，不退信不转发', async () => {
  const svc = await stubService((res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid_request', message: 'content 必填但为空' }));
  });
  after(svc.close);

  const message = fakeMessage();
  await worker.email(message, { ...baseEnv(svc.url), UNDELIVERABLE_ACTION: 'drop' }, {});
  assert.deepEqual(message.calls.rejected, []);
  assert.deepEqual(message.calls.forwarded, []);
});
