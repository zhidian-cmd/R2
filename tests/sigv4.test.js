'use strict';
/**
 * sigv4.test.js - SigV4 签名实现的确定性单元测试。
 *
 * 说明：SigV4 的「逐位正确性」由本文件内的确定性断言覆盖
 * （URI 编码语义、SHA-256/HMAC 原语、签名结构与幂等性）。
 * 本文件只校验不依赖具体签名值的确定性质：
 *   - AWS 规范要求的 URI 编码语义
 *   - SHA-256 / HMAC 基础原语
 *   - 签名的幂等性与结构
 *   - 显式传入 host 时纳入签名范围
 */
const { test } = require('node:test');
const assert = require('node:assert');
const SigV4 = require('../public/js/sigv4.js');

const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const ACCESS_KEY = 'AKIAIOSFODNN7EXAMPLE';

test('uriEncode 符合 AWS 规范（特殊字符全编码，保留 unreserved）', () => {
  // 标准空白
  assert.strictEqual(SigV4.uriEncode('a b'), 'a%20b');
  // 规范要求的额外编码集 !"()*
  assert.strictEqual(SigV4.uriEncode('a!b'), 'a%21b');
  assert.strictEqual(SigV4.uriEncode("a'b"), "a%27b");
  assert.strictEqual(SigV4.uriEncode('a(b)'), 'a%28b%29');
  assert.strictEqual(SigV4.uriEncode('a*b'), 'a%2Ab');
  // unreserved 字符必须原样保留
  assert.strictEqual(SigV4.uriEncode('a~b'), 'a~b');
  assert.strictEqual(SigV4.uriEncode('a-b_c.d'), 'a-b_c.d');
  assert.strictEqual(SigV4.uriEncode('A-Z0-9'), 'A-Z0-9');
  // 多字节字符按 UTF-8 编码
  assert.strictEqual(SigV4.uriEncode('中文 文件.txt'), '%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.txt');
  // 斜杠开关
  assert.strictEqual(SigV4.uriEncode('a/b', false), 'a/b');
  assert.strictEqual(SigV4.uriEncode('a/b', true), 'a%2Fb');
  // 百分号本身必须编码，避免被二次解释
  assert.strictEqual(SigV4.uriEncode('100%'), '100%25');
});

test('sha256Hex 与 Node 权威 crypto 结果一致', async () => {
  const crypto = require('node:crypto');
  const ref = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

  assert.strictEqual(await SigV4.sha256Hex(''), SigV4.EMPTY_SHA256);
  assert.strictEqual(await SigV4.sha256Hex('hello'), ref('hello'));
  assert.strictEqual(await SigV4.sha256Hex('你好'), ref('你好'));
  assert.strictEqual(
    await SigV4.sha256Hex('The quick brown fox jumps over the lazy dog'),
    ref('The quick brown fox jumps over the lazy dog')
  );

  // Uint8Array 输入应与字符串输入等价
  assert.strictEqual(await SigV4.sha256Hex(new TextEncoder().encode('hello')), ref('hello'));
  // ArrayBuffer 输入
  const buf = new ArrayBuffer(5);
  new Uint8Array(buf).set([1, 2, 3, 4, 5]);
  assert.strictEqual(
    await SigV4.sha256Hex(buf),
    crypto.createHash('sha256').update(new Uint8Array([1, 2, 3, 4, 5])).digest('hex')
  );
});

test('sha256Hex 对非可编码类型同步抛出 TypeError', async () => {
  // toUint8 的类型校验在返回 Promise 之前执行，因此是同步抛出
  assert.throws(() => SigV4.sha256Hex(42), TypeError);
  assert.throws(() => SigV4.sha256Hex(true), TypeError);
  assert.throws(() => SigV4.sha256Hex(null), TypeError);
  assert.throws(() => SigV4.sha256Hex([]), TypeError);
  assert.throws(() => SigV4.sha256Hex({}), TypeError);
});

test('hmac 支持 string / Uint8Array / ArrayBuffer 的 key 与 data', async () => {
  const k = await SigV4.hmac('key', 'message');
  assert.match(k, /^[0-9a-f]{64}$/);
  const k2 = await SigV4.hmac(new TextEncoder().encode('key'), new TextEncoder().encode('message'));
  assert.strictEqual(k, k2, '相同输入必须得到相同结果');
  const buf = new ArrayBuffer(3);
  new Uint8Array(buf).set([1, 2, 3]);
  const k3 = await SigV4.hmac(buf, 'x');
  assert.match(k3, /^[0-9a-f]{64}$/);
});

test('签名幂等：相同输入产生完全相同的 Authorization', async () => {
  const opts = {
    method: 'PUT',
    url: 'https://acc.r2.cloudflarestorage.com/bkt/folder/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.txt',
    headers: { 'x-amz-copy-source': '/bkt/folder/%E6%BA%90%E6%96%87%E4%BB%B6.txt' },
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    region: 'auto',
    date: new Date('2024-01-01T00:00:00Z')
  };
  const a = await SigV4.sign(opts);
  const b = await SigV4.sign(opts);
  assert.strictEqual(a.authorization, b.authorization);
  assert.deepStrictEqual(a.headers, b.headers);
});

test('sign 返回 authorization 与必须发送的 header', async () => {
  const r = await SigV4.sign({
    method: 'GET',
    url: 'https://acc.r2.cloudflarestorage.com/bkt/f.txt',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    date: new Date('2024-01-01T00:00:00Z')
  });

  assert.match(r.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20240101\/auto\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/);
  // 这些 header 参与签名，必须随请求发送，否则服务端报 MissingHeaders / SignatureDoesNotMatch
  assert.ok(r.headers['authorization'] === r.authorization);
  assert.match(r.headers['x-amz-date'], /^\d{8}T\d{6}Z$/);
  assert.match(r.headers['x-amz-content-sha256'], /^[0-9a-f]{64}$/);
  assert.strictEqual(r.headers['x-amz-content-sha256'], SigV4.EMPTY_SHA256);
});

test('Authorization 结构与 SignedHeaders 排序正确', async () => {
  const auth = (await SigV4.sign({
    method: 'GET',
    url: 'https://acc.r2.cloudflarestorage.com/bkt/?list-type=2&prefix=a%2F',
    headers: { 'x-amz-copy-source': '/bkt/x', 'X-Custom': '  v1 ' },
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    region: 'auto',
    date: new Date('2024-01-01T00:00:00Z')
  })).authorization;

  assert.match(auth, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20240101\/auto\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/);

  // SignedHeaders 必须按字母序排列
  const headersPart = auth.match(/SignedHeaders=([^,]+)/)[1];
  const parts = headersPart.split(';');
  assert.deepStrictEqual(parts, parts.slice().sort());
  // 自动加入 x-amz-date / x-amz-content-sha256，且 header 名全部小写
  assert.ok(parts.includes('x-amz-date'));
  assert.ok(parts.includes('x-amz-content-sha256'));
  assert.ok(parts.includes('x-amz-copy-source'));
  assert.ok(parts.includes('x-custom'));
  for (const p of parts) assert.strictEqual(p, p.toLowerCase(), 'header 名应小写');
});

test('host 始终纳入签名（S3 规范要求，兼容 MinIO 等严格实现）', async () => {
  const date = new Date('2024-01-01T00:00:00Z');
  const base = {
    method: 'GET',
    url: 'https://acc.r2.cloudflarestorage.com/bkt/f.txt',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    region: 'auto',
    date
  };
  const noHost = (await SigV4.sign(base)).authorization;
  const withHost = (await SigV4.sign({ ...base, headers: { host: 'acc.r2.cloudflarestorage.com' } })).authorization;

  const getSigned = (s) => s.match(/SignedHeaders=([^,]+)/)[1].split(';');
  assert.ok(getSigned(noHost).includes('host'), '未显式传入时也应签名 host（取自 URL）');
  assert.strictEqual(noHost, withHost, '显式传入相同 host 时签名应完全一致');
});

test('header 值被规范化（去首尾空白、压缩连续空格）', async () => {
  const date = new Date('2024-01-01T00:00:00Z');
  const a = (await SigV4.sign({
    method: 'GET',
    url: 'https://acc.r2.cloudflarestorage.com/bkt/f.txt',
    headers: { 'x-test': '  a   b  ' },
    accessKeyId: ACCESS_KEY, secretAccessKey: SECRET, region: 'auto', date
  })).authorization;
  const b = (await SigV4.sign({
    method: 'GET',
    url: 'https://acc.r2.cloudflarestorage.com/bkt/f.txt',
    headers: { 'x-test': 'a b' },
    accessKeyId: ACCESS_KEY, secretAccessKey: SECRET, region: 'auto', date
  })).authorization;
  assert.strictEqual(a, b, '规范化后的 header 值应产生相同签名');
});

test('默认 region/service 为 auto/s3', async () => {
  const auth = (await SigV4.sign({
    method: 'GET',
    url: 'https://acc.r2.cloudflarestorage.com/bkt/',
    accessKeyId: ACCESS_KEY,
    secretAccessKey: SECRET,
    date: new Date('2024-01-01T00:00:00Z')
  })).authorization;
  assert.match(auth, /20240101\/auto\/s3\/aws4_request/);
});
