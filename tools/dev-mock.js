'use strict';
/**
 * dev-mock.js - 本地开发/演示服务器（不参与部署）
 *
 *   http://127.0.0.1:8788  静态站点（public/）
 *   http://127.0.0.1:9999  带 CORS 的 mock S3（代理 tests/mock-s3.js），预置演示文件
 *
 * 用法：
 *   node tools/dev-mock.js
 *   浏览器打开 http://127.0.0.1:8788，在配置页填写：
 *     AccessKeyId=MOCK_ACCESS_KEY  Secret=MOCK_SECRET_ACCESS_KEY
 *     Endpoint=http://127.0.0.1:9999  Bucket=test-bucket
 *     公共开发 URL=http://127.0.0.1:9999/test-bucket   （列表缩略图/预览直接可用）
 *
 * 说明：mock S3 本身不带 CORS 头，浏览器直连会被预检拦截，
 * 因此这里用一层转发代理补上 Access-Control-* 响应头。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createMockS3 } = require('../tests/mock-s3');

const STATIC_PORT = 8788;
const S3_PORT = 9999;
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function startStatic() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      let filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(PUBLIC_DIR)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('not found: ' + urlPath);
          return;
        }
        res.writeHead(200, {
          'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
          'cache-control': 'no-cache'
        });
        res.end(data);
      });
    });
    server.listen(STATIC_PORT, '127.0.0.1', () => resolve(server));
  });
}

function startCorsProxy(innerPort) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'etag, last-modified, content-length, content-type, x-amz-meta-filename, x-amz-meta-content-type'
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(200, CORS);
        res.end();
        return;
      }
      const headers = Object.assign({}, req.headers, { host: '127.0.0.1:' + innerPort });
      const upstream = http.request({
        host: '127.0.0.1',
        port: innerPort,
        method: req.method,
        path: req.url,
        headers
      }, (ur) => {
        const out = Object.assign({}, ur.headers, CORS);
        res.writeHead(ur.statusCode || 502, out);
        ur.pipe(res);
      });
      upstream.on('error', () => {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('mock upstream error');
      });
      req.pipe(upstream);
    });
    server.listen(S3_PORT, '127.0.0.1', () => resolve(server));
  });
}

/** 生成带填充的真实体积 buffer */
function buf(sizeKB, fill) {
  const b = Buffer.alloc(sizeKB * 1024, fill);
  return b;
}

// 1x1 红色 PNG，用于演示相册缩略图（三个字节做微小差异没必要，浏览器照样渲染）
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGklEQVQoz2P4z8DAwMDAwMDwn4GBgYGBAQAkmAElLtnBtAAAAABJRU5ErkJggg==',
  'base64'
);

async function main() {
  const mock = await createMockS3({ publicGet: true }).start();

  // 预置演示文件（覆盖相册/视频/文档/音频/多级目录）
  mock.seed('photos/sunset.png', TINY_PNG);
  mock.seed('photos/forest.png', TINY_PNG);
  mock.seed('photos/city.png', TINY_PNG);
  mock.seed('photos/album cover.png', TINY_PNG);
  mock.seed('videos/product demo.mp4', buf(10240, 1));
  mock.seed('videos/2026 发布会.mp4', buf(20480, 2));
  mock.seed('docs/README.md', buf(12, 3));
  mock.seed('docs/notes.txt', buf(3, 4));
  mock.seed('docs/config.json', buf(2, 5));
  mock.seed('music/lofi beat.mp3', buf(4096, 6));
  mock.seed('music/podcast ep1.flac', buf(8192, 7));
  mock.seed('reports/2026/Q3 销售报表.xlsx', buf(512, 8));
  mock.seed('reports/2026/Q2 销售报表.xlsx', buf(480, 9));
  mock.seed('archive.zip', buf(15360, 10));
  mock.seed('notes.txt', buf(4, 11));
  mock.seed('todo.md', buf(2, 12));
  mock.seed('empty-folder/', Buffer.alloc(0)); // 空文件夹：只应出现在「全部」
  // 大目录：1000+ 条，验证 loadDir 分页翻全 + 列表分批渲染
  for (let i = 0; i < 1050; i++) {
    mock.seed('bulk/file-' + String(i).padStart(5, '0') + '.txt', Buffer.alloc(1));
  }

  await startCorsProxy(mock.server.address().port);
  await startStatic();

  console.log('静态站点  http://127.0.0.1:' + STATIC_PORT);
  console.log('Mock S3   http://127.0.0.1:' + S3_PORT + '  (bucket: ' + mock.bucket + ')');
  console.log('配置：MOCK_ACCESS_KEY / MOCK_SECRET_ACCESS_KEY / http://127.0.0.1:9999 / test-bucket');
  console.log('Ctrl+C 退出');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
