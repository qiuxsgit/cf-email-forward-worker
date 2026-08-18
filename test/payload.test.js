import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildPayload,
  countRealAttachments,
  findPayloadProblems,
  isPlainAddress,
  truncateToBytes,
} from '../src/payload.js';

const envelope = { envelopeTo: 'hello@mydomain.com', envelopeFrom: 'zhangsan@gmail.com' };

test('只发约定好的 7 个字段（接收端多一个字段就可能 400）', () => {
  const payload = buildPayload({ ...envelope, email: { text: '正文' } });
  assert.deepEqual(Object.keys(payload).sort(), [
    'content',
    'content_type',
    'has_attachments',
    'origin_from',
    'origin_from_name',
    'origin_to',
    'subject',
  ]);
});

test('有 HTML 时默认走 html', () => {
  const payload = buildPayload({
    ...envelope,
    email: { subject: '问询：合作事宜', text: '纯文本', html: '<p>富文本</p>' },
  });
  assert.equal(payload.content_type, 'html');
  assert.equal(payload.content, '<p>富文本</p>');
  assert.equal(payload.subject, '问询：合作事宜');
});

test('preferHtml=false 时优先 text，text 空了才退回 html', () => {
  const both = { text: '纯文本', html: '<p>富文本</p>' };
  assert.equal(buildPayload({ ...envelope, email: both, preferHtml: false }).content_type, 'text');

  const htmlOnly = buildPayload({ ...envelope, email: { html: '<p>富文本</p>' }, preferHtml: false });
  assert.equal(htmlOnly.content_type, 'html');
  assert.equal(htmlOnly.content, '<p>富文本</p>');
});

test('没有 HTML 时走 text', () => {
  const payload = buildPayload({ ...envelope, email: { text: '正文内容' } });
  assert.equal(payload.content_type, 'text');
  assert.equal(payload.content, '正文内容');
});

test('两路正文都空时填占位符——content 约定必填非空，空值会 400', () => {
  const payload = buildPayload({
    ...envelope,
    email: { text: '', html: '', attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf' }] },
  });
  assert.equal(payload.content, '（原邮件无正文）');
  assert.equal(payload.content_type, 'text');
  assert.equal(payload.has_attachments, true);
  assert.deepEqual(findPayloadProblems(payload), []);
});

test('origin_from 取信头 From 的纯地址，显示名单独放 origin_from_name', () => {
  const payload = buildPayload({
    envelopeTo: 'hello@mydomain.com',
    envelopeFrom: 'bounces+abc@mailer.gmail.com',
    email: { text: 'x', from: { address: 'zhangsan@gmail.com', name: '张三' } },
  });
  assert.equal(payload.origin_from, 'zhangsan@gmail.com');
  assert.equal(payload.origin_from_name, '张三');
});

test('信头 From 不是纯地址时退回信封发件人', () => {
  const payload = buildPayload({
    ...envelope,
    email: { text: 'x', from: { address: '张三 <zhangsan@gmail.com>', name: '张三' } },
  });
  assert.equal(payload.origin_from, 'zhangsan@gmail.com');

  const noHeader = buildPayload({ ...envelope, email: { text: 'x' } });
  assert.equal(noHeader.origin_from, 'zhangsan@gmail.com');
  assert.equal(noHeader.origin_from_name, '');
});

test('内嵌图片不算附件，不然每封带图邮件都会挂一句「含附件已忽略」', () => {
  assert.equal(countRealAttachments([{ related: true, disposition: 'inline' }]), 0);
  assert.equal(countRealAttachments([{ disposition: 'inline', filename: 'logo.png' }]), 0);
  assert.equal(countRealAttachments([{ disposition: 'attachment', filename: 'a.pdf' }]), 1);
  assert.equal(countRealAttachments([{ filename: 'a.pdf' }]), 1); // 没有 Content-Disposition
  assert.equal(countRealAttachments(undefined), 0);

  const payload = buildPayload({
    ...envelope,
    email: { html: '<img src="cid:logo">', attachments: [{ related: true, filename: 'logo.png' }] },
  });
  assert.equal(payload.has_attachments, false);
});

test('超长正文按字节截断并追加提示，不静默丢数据', () => {
  const payload = buildPayload({
    ...envelope,
    email: { text: '啊'.repeat(1000) },
    maxContentBytes: 300,
  });
  assert.ok(payload.content.includes('已截断'));
  assert.ok(new TextEncoder().encode(payload.content).length < 400);

  const html = buildPayload({
    ...envelope,
    email: { html: '<p>' + '啊'.repeat(1000) + '</p>' },
    maxContentBytes: 300,
  });
  assert.ok(html.content.includes('<hr>'));
});

test('截断不切坏多字节字符', () => {
  // '啊' 是 3 字节，上限 4 只能容下 1 个整字符。
  const cut = truncateToBytes('啊啊啊', 4);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, '啊');
  assert.equal(truncateToBytes('啊啊啊', 9).truncated, false);
});

test('地址校验挡住会被判 400 的请求', () => {
  assert.ok(isPlainAddress('me@gmail.com'));
  assert.ok(!isPlainAddress('张三 <a@b.com>'));
  assert.ok(!isPlainAddress('a@b'));
  assert.ok(!isPlainAddress(''));

  const bad = buildPayload({ envelopeTo: '', envelopeFrom: 'nope', email: { text: 'x' } });
  assert.equal(findPayloadProblems(bad).length, 2);
});
