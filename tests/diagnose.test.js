'use strict';
/**
 * diagnose.test.js - 连接错误分类测试
 *
 * 验证 S3Error.code 解析（SignatureDoesNotMatch / AccessDenied / NoSuchBucket /
 * 网络层无状态码），这是页面「测试连接」给出针对性提示的基础。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const S3Client = require('../public/js/s3.js');

function startMock() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    const auth = req.headers['authorization'] || '';
    if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
      if (auth.includes('AKIDBAD')) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>bad signature</Message></Error>');
        return;
      }
      if (auth.includes('AKIDNOPERM')) {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>');
        return;
      }
      if (auth.includes('AKIDINVALID')) {
        res.writeHead(400, { 'content-type': 'application/xml' });
        res.end('<Error><Code>InvalidAccessKeyId</Code><Message>invalid key</Message></Error>');
        return;
      }
      if (u.pathname.includes('nobucket')) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchBucket</Code><Message>no bucket</Message></Error>');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0"?><ListBucketResult><KeyCount>1</KeyCount><IsTruncated>false</IsTruncated>' +
        '<Contents><Key>a.txt</Key><LastModified>2024-01-01T00:00:00Z</LastModified><Size>5</Size></Contents></ListBucketResult>');
      return;
    }
    res.writeHead(405); res.end();
  });
  return server;
}

test('S3 错误分类：code 解析正确（连接诊断基础）', async () => {
  const server = startMock();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const ep = `http://127.0.0.1:${server.address().port}`;
  const base = { accessKeyId: 'AKIDGOOD', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', endpoint: ep, region: 'auto' };

  try {
    const page = await new S3Client({ ...base, bucket: 'good' }).list({ prefix: '' });
    assert.strictEqual(page.items.length, 1);
  } finally { /* keep going */ }

  // 签名不匹配
  await assert.rejects(
    () => new S3Client({ ...base, accessKeyId: 'AKIDBAD', bucket: 'good' }).list({ prefix: '' }),
    (e) => e.code === 'SignatureDoesNotMatch' && e.status === 403 && /SignatureDoesNotMatch/.test(e.message)
  );

  // 权限不足
  await assert.rejects(
    () => new S3Client({ ...base, accessKeyId: 'AKIDNOPERM', bucket: 'good' }).list({ prefix: '' }),
    (e) => e.code === 'AccessDenied' && e.status === 403
  );

  // 桶不存在
  await assert.rejects(
    () => new S3Client({ ...base, bucket: 'nobucket' }).list({ prefix: '' }),
    (e) => e.code === 'NoSuchBucket' && e.status === 404
  );

  // Access Key 无效
  await assert.rejects(
    () => new S3Client({ ...base, accessKeyId: 'AKIDINVALID', bucket: 'good' }).list({ prefix: '' }),
    (e) => e.code === 'InvalidAccessKeyId' && e.status === 400
  );

  // 网络层失败：无 status / 无 code（对应浏览器 CORS 场景的表现）
  await assert.rejects(
    () => new S3Client({ ...base, endpoint: 'http://127.0.0.1:1', bucket: 'good' }).list({ prefix: '' }),
    (e) => !e.status && !e.code
  );

  server.close();
});
