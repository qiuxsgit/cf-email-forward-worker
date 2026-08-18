// 把 postal-mime 解析出的邮件映射成转发服务的请求体（字段约定见 README）。
//
// 这个模块刻意不 import 任何东西（连 postal-mime 都不 import），所以能用
// `node --test` 直接跑单测，不必起 workerd。

/** 正文字节上限的默认值。留足余量给 JSON 结构和接收端/网关的请求体上限。 */
export const DEFAULT_MAX_CONTENT_BYTES = 2_000_000;

/** content 约定为必填非空，只有附件没有正文的邮件必须填个占位符。 */
const EMPTY_CONTENT_PLACEHOLDER = '（原邮件无正文）';

const TRUNCATED_NOTICE_TEXT = '\n\n---\n（正文过长，Worker 转发时已截断）';
const TRUNCATED_NOTICE_HTML = '<hr><p>（正文过长，Worker 转发时已截断）</p>';

// 纯地址的粗校验。接收端多半也会校验地址，非法地址换来 400 invalid_request——
// 那是不可重试的，邮件会走兜底分支。所以这里先自己挑出
// 「看起来是纯地址」的那个，别把 `张三 <a@b.com>` 这种带显示名的塞进 origin_from。
const PLAIN_ADDRESS = /^[^\s<>@,;:"]+@[^\s<>@,;:"]+\.[^\s<>@,;:"]+$/;

export function isPlainAddress(value) {
  return typeof value === 'string' && PLAIN_ADDRESS.test(value.trim());
}

/**
 * 构造 POST /forward 的请求体。
 *
 * 返回的对象**只含约定好的 7 个字段**：接收端可能拒绝未知字段（多一个就是 400），
 * 所以别往里加。
 *
 * @param {object}  args
 * @param {string}  args.envelopeTo    信封收件人（message.to），用于匹配规则
 * @param {string}  args.envelopeFrom  信封发件人（message.from）
 * @param {object}  args.email         PostalMime.parse 的结果
 * @param {boolean} [args.preferHtml]  同时有 html 和 text 时优先哪个
 * @param {number}  [args.maxContentBytes]
 */
export function buildPayload({
  envelopeTo,
  envelopeFrom,
  email,
  preferHtml = true,
  maxContentBytes = DEFAULT_MAX_CONTENT_BYTES,
}) {
  const html = str(email?.html).trim();
  const text = str(email?.text).trim();

  // 首选那一路为空就退到另一路，两路都空再用占位符。
  const useHtml = preferHtml ? html !== '' : text === '' && html !== '';
  const contentType = useHtml ? 'html' : 'text';
  const body = useHtml ? html : text;

  let content = body === '' ? EMPTY_CONTENT_PLACEHOLDER : body;
  const cut = truncateToBytes(content, maxContentBytes);
  content = cut.truncated
    ? cut.text + (useHtml ? TRUNCATED_NOTICE_HTML : TRUNCATED_NOTICE_TEXT)
    : cut.text;

  // origin_from 要纯地址：优先信头 From（人类回复时想找的那个地址，服务端会放进
  // Reply-To），信头不可用才退到信封发件人（信封地址可能是 bounces+xxx@ 之类）。
  const headerFrom = str(email?.from?.address).trim();
  const originFrom = isPlainAddress(headerFrom) ? headerFrom : str(envelopeFrom).trim();

  return {
    origin_to: str(envelopeTo).trim(),
    origin_from: originFrom,
    // 显示名里的 CR/LF 由服务端剥掉（头部注入防护），这里只做 trim。
    origin_from_name: str(email?.from?.name).trim(),
    subject: str(email?.subject).trim(),
    content,
    content_type: contentType,
    has_attachments: countRealAttachments(email?.attachments) > 0,
  };
}

/**
 * 数真附件，不数内嵌图片。
 *
 * postal-mime 把 HTML 正文里 cid: 引用的图片也放进 attachments，把它们算成附件
 * 会让每封带图的营销邮件都在正文尾部挂一句「原邮件含附件，转发时已忽略」。
 */
export function countRealAttachments(attachments) {
  if (!Array.isArray(attachments)) return 0;
  return attachments.filter((a) => a && a.related !== true && a.disposition !== 'inline').length;
}

/**
 * 校验请求体能不能被接收端接受。命中的话就别发了——换来的只是一个 400
 * invalid_request，白跑一趟网络，而且日志里看不出到底哪个字段不对。
 *
 * @returns {string[]} 问题描述，空数组表示可以发
 */
export function findPayloadProblems(payload) {
  const problems = [];
  if (!isPlainAddress(payload.origin_to)) {
    problems.push(`origin_to 不是合法地址: ${JSON.stringify(payload.origin_to)}`);
  }
  if (!isPlainAddress(payload.origin_from)) {
    problems.push(`origin_from 不是合法地址: ${JSON.stringify(payload.origin_from)}`);
  }
  if (payload.content === '') problems.push('content 为空');
  return problems;
}

/**
 * 按 UTF-8 字节数截断，不切坏多字节字符。
 *
 * 先整体编码再按字节切、退到字符起始字节，是一遍 O(n)；按字符二分再反复编码
 * 是 O(n log n)，几 MB 的正文上差别肉眼可见。
 */
export function truncateToBytes(value, maxBytes) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return { text: value, truncated: false };

  let end = maxBytes;
  // UTF-8 续字节是 10xxxxxx，退到序列的起始字节为止。
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: new TextDecoder().decode(bytes.subarray(0, end)), truncated: true };
}

function str(value) {
  return typeof value === 'string' ? value : '';
}
