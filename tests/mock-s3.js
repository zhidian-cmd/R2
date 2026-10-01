'use strict';
/**
 * mock-s3.js - 本地 S3 兼容 mock server，用于集成测试。
 *
 * 说明：SigV4 签名的「逐位正确性」由 sigv4.test.js 的确定性断言覆盖
 * （URI 编码、SHA-256/HMAC 原语、签名结构与幂等性）；本 mock 专注模拟 S3 行为。
 * 本 mock 的职责是：
 *   - 模拟 ListObjectsV2 / PUT / HEAD / GET / DELETE / CopyObject 的真实行为与 XML 响应格式
 *   - 校验请求头的基本结构（Authorization 格式、x-amz-date、x-amz-content-sha256）
 *   - 校验 URL 路径中的 key 编码是否正确
 */
const http = require('http');
const { URL } = require('url');
const S3Client = require('../public/js/s3.js');

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bytesOf(b) {
  if (b == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(b)) return b;
  if (b instanceof Uint8Array) return Buffer.from(b);
  return Buffer.from(b);
}

function makeStore() {
  const map = new Map();
  return {
    map,
    set(key, data, meta) {
      map.set(key, { data: bytesOf(data), meta: meta || {}, ts: new Date().toISOString() });
    },
    get(key) { return map.get(key) || null; },
    has(key) { return map.has(key); },
    del(key) { return map.delete(key); },
    list(prefix, delimiter) {
      const keys = Array.from(map.keys()).filter(k => k.startsWith(prefix));
      keys.sort();
      return keys;
    }
  };
}

function createMockS3(opts) {
  opts = opts || {};
  // publicGet: 允许无签名 GET（模拟 R2 公开开发 URL / 自定义域的行为，
  // 供 tools/dev-mock.js 本地演示用；测试默认关闭，签名校验行为不变）
  const publicGet = !!opts.publicGet;
  const store = makeStore();
  const log = [];
  // 进行中的分片上传：uploadId -> { key, parts: Map<partNumber, Buffer>, meta }
  const multiparts = new Map();
  let multipartSeq = 0;

  /** 从请求头收集 x-amz-meta-*（与 PUT 对象一致） */
  function metaFromHeaders(headers) {
    const meta = {};
    for (const h of Object.keys(headers)) {
      if (h.toLowerCase().startsWith('x-amz-meta-')) meta[h.toLowerCase().slice(11)] = headers[h];
    }
    return meta;
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    // bucket 寻址：/bucket/key...
    // 注意不能用 split('/').filter(Boolean) —— 那会丢掉「文件夹标记」对象尾部的斜杠（如 folder/ -> folder）
    const segments = u.pathname.split('/');
    const bucket = segments[1] || '';
    const rawKey = segments.slice(2).join('/'); // 保留末尾 '/'
    // R2 约定：路径保持百分号编码，解码后得到真实 key（含中文、空格等）
    const key = rawKey === '' ? '' : decodeURIComponent(rawKey);
    const method = req.method.toUpperCase();

    const auth = req.headers['authorization'] || '';
    const checks = { method, bucket, key, path: rawKey, query: Object.fromEntries(new URLSearchParams(u.search)) };

    // 公开读取：不带 Authorization 的 GET 视作公共 URL 访问（仅 publicGet 模式）
    if (!(publicGet && method === 'GET' && !auth)) {
      // 结构校验：Authorization 必须符合 AWS4-HMAC-SHA256 格式
      if (!/^AWS4-HMAC-SHA256 Credential=.+\/\d{8}\/\S+\/s3\/aws4_request, SignedHeaders=[^,]+, Signature=[0-9a-f]{64}$/.test(auth)) {
        log.push({ ...checks, error: 'bad Authorization' });
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>bad authorization</Message></Error>');
        return;
      }
      if (!/^20\d{6}T\d{6}Z$/.test(req.headers['x-amz-date'] || '')) {
        log.push({ ...checks, error: 'bad x-amz-date' });
        res.writeHead(400, { 'content-type': 'application/xml' });
        res.end('<Error><Code>InvalidArgument</Code><Message>bad x-amz-date</Message></Error>');
        return;
      }
      if (!/^(UNSIGNED-PAYLOAD|[0-9a-f]{64})$/.test(req.headers['x-amz-content-sha256'] || '')) {
        log.push({ ...checks, error: 'bad x-amz-content-sha256' });
        res.writeHead(400, { 'content-type': 'application/xml' });
        res.end('<Error><Code>InvalidArgument</Code><Message>bad x-amz-content-sha256</Message></Error>');
        return;
      }
    }

    // ----- 分片上传（Multipart Upload）-----
    if (method === 'POST' && checks.query.uploads !== undefined) {
      const id = 'mock-upload-' + (++multipartSeq);
      multiparts.set(id, { key, parts: new Map(), meta: metaFromHeaders(req.headers) });
      log.push({ ...checks, note: 'multipart create' });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end('<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult>' +
        '<Bucket>' + xmlEscape(bucket) + '</Bucket><Key>' + xmlEscape(key) + '</Key>' +
        '<UploadId>' + id + '</UploadId></InitiateMultipartUploadResult>');
      return;
    }
    if (method === 'PUT' && checks.query.uploadId !== undefined && checks.query.partNumber !== undefined) {
      const mp = multiparts.get(checks.query.uploadId);
      if (!mp || mp.key !== key) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchUpload</Code><Message>upload id not found</Message></Error>');
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        mp.parts.set(Number(checks.query.partNumber), Buffer.concat(chunks));
        log.push({ ...checks, note: 'multipart part', bytes: chunks.length });
        res.writeHead(200, { 'etag': '"part-' + checks.query.partNumber + '-etag"' });
        res.end();
      });
      return;
    }
    if (method === 'POST' && checks.query.uploadId !== undefined) {
      const mp = multiparts.get(checks.query.uploadId);
      if (!mp || mp.key !== key) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchUpload</Code><Message>upload id not found</Message></Error>');
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        // 按 Complete 请求里 Part 的出现顺序拼接（S3 语义：顺序即最终对象的字节顺序）
        const order = [];
        const partRe = /<PartNumber>(\d+)<\/PartNumber>/g;
        let pm;
        while ((pm = partRe.exec(body)) !== null) order.push(Number(pm[1]));
        for (const n of order) {
          if (!mp.parts.has(n)) {
            res.writeHead(400, { 'content-type': 'application/xml' });
            res.end('<Error><Code>InvalidPart</Code><Message>part ' + n + ' missing</Message></Error>');
            return;
          }
        }
        const data = Buffer.concat(order.map(n => mp.parts.get(n)));
        store.set(key, data, mp.meta);
        multiparts.delete(checks.query.uploadId);
        log.push({ ...checks, note: 'multipart complete', bytes: data.length, parts: order.length });
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0" encoding="UTF-8"?><CompleteMultipartUploadResult>' +
          '<Location>mock</Location><Bucket>' + xmlEscape(bucket) + '</Bucket>' +
          '<Key>' + xmlEscape(key) + '</Key><ETag>&quot;multipart-etag&quot;</ETag>' +
          '</CompleteMultipartUploadResult>');
      });
      return;
    }
    if (method === 'DELETE' && checks.query.uploadId !== undefined) {
      multiparts.delete(checks.query.uploadId);
      log.push({ ...checks, note: 'multipart abort' });
      res.writeHead(204);
      res.end();
      return;
    }

    // ListMultipartUploads（GET /bucket?uploads）：返回已创建但未完成/未中止的分片上传
    if (method === 'GET' && checks.query.uploads !== undefined) {
      let xml = '<?xml version="1.0" encoding="UTF-8"?>';
      xml += '<ListMultipartUploadsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">';
      xml += '<Bucket>' + xmlEscape(bucket) + '</Bucket><KeyMarker></KeyMarker>';
      xml += '<UploadIdMarker></UploadIdMarker><MaxUploads>1000</MaxUploads><IsTruncated>false</IsTruncated>';
      for (const [id, mp] of multiparts) {
        xml += '<Upload><Key>' + xmlEscape(mp.key) + '</Key><UploadId>' + xmlEscape(id) + '</UploadId>'
          + '<Initiated>' + new Date().toISOString() + '</Initiated>'
          + '<StorageClass>STANDARD</StorageClass></Upload>';
      }
      xml += '</ListMultipartUploadsResult>';
      log.push({ ...checks, note: 'multipart list', count: multiparts.size });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(xml);
      return;
    }

    // ListParts（GET /bucket/key?uploadId=）：返回该上传已写入的分片及其字节数
    if (method === 'GET' && checks.query.uploadId !== undefined) {
      const mp = multiparts.get(checks.query.uploadId);
      if (!mp || mp.key !== key) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchUpload</Code><Message>upload id not found</Message></Error>');
        return;
      }
      const nums = Array.from(mp.parts.keys()).sort((a, b) => a - b);
      let xml = '<?xml version="1.0" encoding="UTF-8"?>';
      xml += '<ListPartsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">';
      xml += '<Bucket>' + xmlEscape(bucket) + '</Bucket><Key>' + xmlEscape(key) + '</Key>';
      xml += '<UploadId>' + xmlEscape(checks.query.uploadId) + '</UploadId>';
      xml += '<MaxParts>1000</MaxParts><IsTruncated>false</IsTruncated>';
      for (const n of nums) {
        xml += '<Part><PartNumber>' + n + '</PartNumber>'
          + '<LastModified>' + new Date().toISOString() + '</LastModified>'
          + '<ETag>&quot;part-' + n + '-etag&quot;</ETag>'
          + '<Size>' + mp.parts.get(n).length + '</Size></Part>';
      }
      xml += '</ListPartsResult>';
      log.push({ ...checks, note: 'multipart parts', count: nums.length });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(xml);
      return;
    }

    if (checks.query['list-type'] === '2') {
      const prefix = checks.query.prefix || '';
      const delimiter = checks.query.delimiter || '';
      const maxKeys = Number(checks.query['max-keys'] || 1000);
      const token = checks.query['continuation-token'] || '';
      const keys = store.list(prefix, delimiter);

      // 按 delimiter 分组
      const commonPrefixes = new Set();
      const contents = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        if (delimiter && rest.indexOf(delimiter) !== -1) {
          commonPrefixes.add(prefix + rest.slice(0, rest.indexOf(delimiter) + 1));
        } else {
          contents.push(k);
        }
      }

      const tokenOffset = token ? Number(token) : 0;
      const sliced = contents.slice(tokenOffset, tokenOffset + maxKeys);
      const isTruncated = tokenOffset + maxKeys < contents.length;

      let xml = '<?xml version="1.0" encoding="UTF-8"?>';
      xml += '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">';
      xml += '<Name>' + xmlEscape(bucket) + '</Name><Prefix>' + xmlEscape(prefix) + '</Prefix>';
      if (delimiter) xml += '<Delimiter>' + xmlEscape(delimiter) + '</Delimiter>';
      xml += '<KeyCount>' + (sliced.length + commonPrefixes.size) + '</KeyCount>';
      xml += '<MaxKeys>' + maxKeys + '</MaxKeys><IsTruncated>' + (isTruncated ? 'true' : 'false') + '</IsTruncated>';
      for (const k of sliced) {
        const o = store.get(k);
        xml += '<Contents><Key>' + xmlEscape(k) + '</Key>'
          + '<LastModified>' + o.ts + '</LastModified>'
          + '<ETag>&quot;etag&quot;</ETag>'
          + '<Size>' + o.data.length + '</Size>'
          + '<StorageClass>STANDARD</StorageClass></Contents>';
      }
      for (const cp of Array.from(commonPrefixes).sort()) {
        xml += '<CommonPrefixes><Prefix>' + xmlEscape(cp) + '</Prefix></CommonPrefixes>';
      }
      if (isTruncated) xml += '<NextContinuationToken>' + (tokenOffset + maxKeys) + '</NextContinuationToken>';
      xml += '</ListBucketResult>';

      log.push({ ...checks, note: 'list', count: sliced.length, prefixes: commonPrefixes.size });
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(xml);
      return;
    }

    if (method === 'PUT') {
      const isCopy = !!req.headers['x-amz-copy-source'];
      if (isCopy) {
        // x-amz-copy-source = /bucket/key 或 bucket/key；第一段是 bucket，其余才是 key
        const srcRaw = String(req.headers['x-amz-copy-source']).replace(/^\/+/, '');
        const segs = srcRaw.split('/');
        const srcKey = decodeURIComponent(segs.slice(1).join('/'));
        const src = store.get(srcKey);
        if (!src) {
          res.writeHead(404, { 'content-type': 'application/xml' });
          res.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
          return;
        }
        const meta = {};
        for (const h of Object.keys(req.headers)) {
          if (h.toLowerCase().startsWith('x-amz-meta-')) meta[h.toLowerCase().slice(11)] = req.headers[h];
        }
        store.set(key, src.data, meta);
        log.push({ ...checks, note: 'copy', srcKey });
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<CopyObjectResult><ETag>&quot;newetag&quot;</ETag><LastModified>' + new Date().toISOString() + '</LastModified></CopyObjectResult>');
        return;
      }
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const meta = {};
        for (const h of Object.keys(req.headers)) {
          if (h.toLowerCase().startsWith('x-amz-meta-')) meta[h.toLowerCase().slice(11)] = req.headers[h];
        }
        store.set(key, body, meta);
        log.push({ ...checks, note: 'put', bytes: body.length, meta });
        res.writeHead(200, { 'etag': '"mock-etag"' });
        res.end();
      });
      return;
    }

    if (method === 'HEAD') {
      const o = store.get(key);
      if (!o) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code><Message>Not found.</Message></Error>');
        return;
      }
      const headers = {
        'content-length': String(o.data.length),
        'last-modified': o.ts,
        'x-amz-storage-class': 'STANDARD'
      };
      for (const k of Object.keys(o.meta)) headers['x-amz-meta-' + k] = o.meta[k];
      log.push({ ...checks, note: 'head' });
      res.writeHead(200, headers);
      res.end();
      return;
    }

    if (method === 'GET') {
      const o = store.get(key);
      if (!o) {
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
        return;
      }
      const headers = {
        'content-length': String(o.data.length),
        'last-modified': o.ts,
        'x-amz-storage-class': 'STANDARD'
      };
      for (const k of Object.keys(o.meta)) headers['x-amz-meta-' + k] = o.meta[k];
      log.push({ ...checks, note: 'get' });
      res.writeHead(200, headers);
      res.end(o.data);
      return;
    }

    if (method === 'DELETE') {
      if (!store.has(key)) {
        log.push({ ...checks, note: 'delete', error: 'not-found' });
        res.writeHead(404, { 'content-type': 'application/xml' });
        res.end('<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>');
        return;
      }
      store.del(key);
      log.push({ ...checks, note: 'delete', existed: true });
      res.writeHead(204);
      res.end();
      return;
    }

    log.push({ ...checks, error: 'unhandled method' });
    res.writeHead(405, { 'content-type': 'application/xml' });
    res.end('<Error><Code>MethodNotAllowed</Code><Message>not implemented</Message></Error>');
  });

  return {
    server,
    log,
    store,
    start() {
      return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        this.endpoint = 'http://127.0.0.1:' + addr.port;
        this.bucket = 'test-bucket';
        this.client = new S3Client({
          accessKeyId: 'MOCK_ACCESS_KEY',
          secretAccessKey: 'MOCK_SECRET_ACCESS_KEY',
          endpoint: this.endpoint,
          bucket: this.bucket
        });
        resolve(this);
      }));
    },
    /** 直接向 mock 存储写入对象，用于构造确定性的分页测试数据 */
    seed(key, data) {
      this.store.set(key, data, {});
      return this;
    },
    stop() {
      return new Promise((resolve) => {
        // 立即终止 keep-alive 连接，否则 server.close() 会因空闲连接而一直等待
        server.keepAliveTimeout = 0;
        server.closeIdleConnections && server.closeIdleConnections();
        server.closeAllConnections && server.closeAllConnections();
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        server.on('close', finish);
        server.close(finish);
        // 兜底：无论如何 500ms 内结束，避免测试挂起
        setTimeout(finish, 500).unref();
      });
    }
  };
}

module.exports = { createMockS3 };
