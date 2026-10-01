'use strict';
/**
 * upload-signature.test.js - XHR 上传签名一致性回归测试
 *
 * 背景：putWithProgress（XHR 上传）曾因「签名头与实际发送头不一致」导致
 * R2 返回 403 SignatureDoesNotMatch，所有上传失败。两个根因：
 *  1) 业务头（content-type / x-amz-meta-*）参与签名但发送时漏掉
 *  2) x-amz-content-sha256 被同时放入业务头与签名头，setRequestHeader
 *     追加成 "hash, hash"，与签名单值不一致
 *
 * 本测试在 mock S3 端按「请求实际收到的头」重算签名并对比 authorization，
 * 确保 XHR 上传路径签名始终一致。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const XHR = require('xhr2');

const ROOT = path.resolve(__dirname, '..');
const SigV4 = require(path.join(ROOT, 'public/js/sigv4.js'));
const S3Client = require(path.join(ROOT, 'public/js/s3.js'));

function startVerifyServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'PUT') { res.writeHead(405); res.end(); return; }
      let chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', async () => {
        const auth = req.headers['authorization'] || '';
        const m = auth.match(/SignedHeaders=([^,]+), Signature=([0-9a-f]{64})/);
        if (!m) { res.writeHead(403); res.end(); return; }
        const signedHeaders = m[1].split(';');
        const claimed = m[2];

        // 仅用请求实际收到的头重算签名
        const headersForSign = {};
        signedHeaders.forEach(h => {
          if (h === 'host') headersForSign[h] = req.headers['host'];
          else if (req.headers[h] !== undefined) headersForSign[h] = req.headers[h];
        });
        const date = new Date(headersForSign['x-amz-date']
          .replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
        const r = await SigV4.sign({
          method: 'PUT',
          url: 'http://localhost' + req.url,
          headers: headersForSign,
          accessKeyId: 'AKID', secretAccessKey: 'SECRET', region: 'auto',
          date,
          payloadHash: headersForSign['x-amz-content-sha256']
        });

        const ok = r.authorization.includes(claimed);
        if (ok) { res.writeHead(200); res.end(); }
        else {
          res.writeHead(403);
          res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>x</Message></Error>');
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('XHR 上传：签名头与实际发送头一致（含业务头，无重复 x-amz-content-sha256）', async () => {
  const server = await startVerifyServer();
  const port = server.address().port;

  // 注入全局 XHR（xhr2 模拟浏览器 XMLHttpRequest）
  const origXHR = global.XMLHttpRequest;
  global.XMLHttpRequest = XHR;
  try {
    const client = new S3Client({
      accessKeyId: 'AKID', secretAccessKey: 'SECRET',
      endpoint: `http://127.0.0.1:${port}`, bucket: 'b', region: 'auto'
    });
    const file = new Blob(['hello world'], { type: 'text/plain' });
    const buf = await file.arrayBuffer();
    let progressPct = null;
    const res = await client.putWithProgress('test.txt', buf,
      { filename: 'test.txt', contentType: 'text/plain' },
      (p) => { progressPct = p.percent; });

    assert.strictEqual(res.key, 'test.txt');
    assert.strictEqual(res.name, 'test.txt');
    // xhr2（Node 环境）不保证触发 upload.onprogress；进度回调为增强功能，不强断言
    if (progressPct != null) assert.ok(progressPct >= 0 && progressPct <= 100);

    // 中文文件名也应工作（x-amz-meta-filename 编码后参与签名）
    const buf2 = await new Blob(['x'], { type: 'text/plain' }).arrayBuffer();
    await client.putWithProgress('中文 文件.txt', buf2,
      { filename: '中文 文件.txt', contentType: 'text/plain' });
    console.log('  中文文件名上传签名一致 ✓');
  } finally {
    global.XMLHttpRequest = origXHR;
    server.close();
  }
});
