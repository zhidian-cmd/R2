'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createMockS3 } = require('./mock-s3');
const S3Client = require('../public/js/s3.js');

test('S3 客户端端到端：上传 / 列举 / HEAD / 下载 / 复制 / 建目录 / 删除', async (t) => {
  const mock = createMockS3();
  await mock.start();
  const s3 = mock.client;

  // ---------- 构造 ----------
  t.test('缺少必填配置时抛出清晰错误', () => {
    assert.throws(() => new S3Client({ endpoint: 'https://x', bucket: 'b' }), /缺少凭证/);
    assert.throws(() => new S3Client({ accessKeyId: 'a', secretAccessKey: 'b', bucket: 'b' }), /endpoint/);
    assert.throws(() => new S3Client({ accessKeyId: 'a', secretAccessKey: 'b', endpoint: 'e' }), /bucket/);
  });

  t.test('endpoint 规范化：自动补 https://，去掉尾部斜杠', () => {
    assert.strictEqual(new S3Client({ accessKeyId: 'a', secretAccessKey: 'b', endpoint: 'example.com/', bucket: 'b' }).cfg.endpoint, 'https://example.com');
    assert.strictEqual(new S3Client({ accessKeyId: 'a', secretAccessKey: 'b', endpoint: 'http://127.0.0.1:8080', bucket: 'b' }).cfg.endpoint, 'http://127.0.0.1:8080');
  });

  t.test('key 编码符合 S3 规范（保留 /，编码空格、中文、括号、%）', () => {
    const enc = S3Client.encodeKey;
    assert.strictEqual(enc('a/b.txt'), 'a/b.txt');
    assert.strictEqual(enc('photo (1).png'), 'photo%20%281%29.png');
    assert.strictEqual(enc('中文 文件'), '%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6');
    assert.strictEqual(enc('100%'), '100%25');
    // 已编码输入应幂等（不产生双重编码）
    assert.strictEqual(enc('%E4%B8%AD%E6%96%87'), '%E4%B8%AD%E6%96%87');
  });

  // ---------- 上传 ----------
  await t.test('上传并写入元数据', async () => {
    const body = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    await s3.put('a.txt', body, { filename: 'a.txt', contentType: 'text/plain' });
    assert.ok(mock.store.has('a.txt'), 'a.txt 应已存在');
    assert.strictEqual(mock.store.get('a.txt').meta['filename'], 'a.txt');
    assert.strictEqual(mock.store.get('a.txt').meta['content-type'], 'text/plain');
  });

  await t.test('支持含中文、空格、括号、% 的 key 上传', async () => {
    const payload = Buffer.from('内容');
    const entries = [
      { key: 'photo (1).png', body: payload, extra: { filename: 'photo (1).png' } },
      { key: '中文 文件/报告.docx', body: payload, extra: { filename: '报告.docx' } },
      { key: 'sub/dir/deep.txt', body: payload, extra: { filename: 'deep.txt' } },
      { key: '100% raw.txt', body: payload, extra: { filename: '100% raw.txt' } }
    ];
    for (const e of entries) await s3.put(e.key, e.body, e.extra);
    for (const e of entries) assert.ok(mock.store.has(e.key), '应存在: ' + e.key);
  });

  // ---------- 列举 ----------
  await t.test('ListObjectsV2 正确区分文件与文件夹（含 delimiter 折叠）', async () => {
    // 空文件夹：只以 CommonPrefixes 形态存在
    await s3.mkdir('empty/');
    // 有子文件的文件夹：S3 带 delimiter 时把整棵子树折叠为单一 CommonPrefix
    await s3.put('folder/', new Uint8Array(0), { filename: 'folder' });
    await s3.put('folder/child.txt', new Uint8Array([1]), { filename: 'child.txt' });

    const page = await s3.list({ prefix: '' });
    const names = page.items.map(i => i.name).sort();
    // folder/child.txt 与 sub/dir/deep.txt、中文 文件/报告.docx 均被折叠，不会重复出现
    const expected = ['100% raw.txt', 'a.txt', 'empty/', 'folder/', 'photo (1).png',
      'sub/', '中文 文件/'].sort();
    assert.deepStrictEqual(names, expected);

    // 折叠出的子目录必须标记为文件夹
    const folderItem = page.items.find(i => i.name === 'folder/');
    assert.ok(folderItem.isFolder);
    // 非目录条目
    const files = page.items.filter(i => !i.isFolder);
    assert.strictEqual(files.length, 3); // a.txt, 100% raw.txt, photo (1).png

    // 进入 sub/ 目录：sub/dir/deep.txt 被折叠为子前缀，故只剩子目录
    const sub = await s3.list({ prefix: 'sub/' });
    assert.deepStrictEqual(sub.items.map(i => i.name).sort(), ['sub/dir/']);
    // 继续下钻一层：折叠解除，能看到真实文件
    // 注意：S3 的 ListObjectsV2 始终返回完整 key（不以 prefix 为相对路径）
    const subDir = await s3.list({ prefix: 'sub/dir/' });
    assert.deepStrictEqual(subDir.items.map(i => i.name).sort(), ['sub/dir/deep.txt']);
    assert.strictEqual(subDir.items[0].isFolder, false);

    // 进入 folder/ 目录：folder/ 标记对象自身也是一条 Contents，child.txt 同样列出
    const fd = await s3.list({ prefix: 'folder/' });
    assert.deepStrictEqual(fd.items.map(i => i.name).sort(), ['folder/', 'folder/child.txt']);
    const fdItems = fd.items;
    assert.strictEqual(fdItems.find(i => i.name === 'folder/').isFolder, true);
    assert.strictEqual(fdItems.find(i => i.name === 'folder/child.txt').isFolder, false);
  });

  await t.test('分页：list 的 continuation-token 翻页 + listAll 自动遍历', async () => {
    // 用独立前缀构造 3 个对象，强制产生 2 页
    for (let i = 0; i < 3; i++) await s3.put('pg/p' + i + '.txt', new Uint8Array([i]));

    const p1 = await s3.list({ prefix: 'pg/', maxKeys: 2 });
    assert.strictEqual(p1.truncated, true);
    assert.strictEqual(p1.items.length, 2);
    assert.ok(p1.nextContinuationToken, '应返回下一页 token');

    const p2 = await s3.list({ prefix: 'pg/', token: p1.nextContinuationToken, maxKeys: 2 });
    assert.strictEqual(p2.truncated, false);
    assert.strictEqual(p2.nextContinuationToken, null);
    assert.strictEqual(p2.items.length, 1);

    // 两页合并后无重复，且条目数与逐页之和一致
    const combined = p1.items.concat(p2.items);
    assert.strictEqual(combined.length, 3);
    assert.strictEqual(new Set(combined.map(i => i.name)).size, combined.length, '翻页后不应有重复条目');
    assert.deepStrictEqual(combined.map(i => i.name).sort(), ['pg/p0.txt', 'pg/p1.txt', 'pg/p2.txt']);

    // 自动翻页遍历全部对象（等价原 listAll 的语义）
    let all = [];
    let tok = null;
    do {
      const page = await s3.list({ prefix: 'pg/', token: tok, maxKeys: 2 });
      all = all.concat(page.items);
      tok = page.nextContinuationToken;
    } while (tok);
    assert.strictEqual(all.length, 3);
    assert.deepStrictEqual(all.map(x => x.name).sort(), ['pg/p0.txt', 'pg/p1.txt', 'pg/p2.txt']);
  });

  await t.test('size / lastModified 字段完整', async () => {
    const page = await s3.list({ prefix: '' });
    const hello = page.items.find(i => i.name === 'a.txt');
    assert.strictEqual(hello.size, 5);
    assert.ok(hello.lastModified);
    assert.ok(hello.meta && typeof hello.meta === 'object');
  });

  // ---------- HEAD / GET ----------
  await t.test('HEAD 读取元信息', async () => {
    const meta = await s3.head('a.txt');
    assert.strictEqual(meta.name, 'a.txt');
    assert.strictEqual(meta.size, 5);
    assert.strictEqual(meta.filename, 'a.txt');
    assert.strictEqual(meta.contentType, 'text/plain');
    assert.ok(meta.lastModified);
  });

  await t.test('HEAD 不存在的对象返回 404', async () => {
    let err = null;
    try { await s3.head('no/such/key.txt'); } catch (e) { err = e; }
    assert.ok(err, '应抛出错误');
    assert.strictEqual(err.status, 404);
    // HEAD 响应按 HTTP 规范不带 body，因此无法从 XML 中解析错误码，仅可依据状态码判定
    assert.match(err.message, /^HTTP 404/);
  });

  await t.test('GET 下载内容与上传一致', async () => {
    const res = await s3.get('a.txt');
    assert.ok(res.blob);
    const text = new TextDecoder().decode(new Uint8Array(await res.blob.arrayBuffer()));
    assert.strictEqual(text, 'Hello');
    assert.strictEqual(res.name, 'a.txt');
  });

  await t.test('GET 二进制与中文 key 对象', async () => {
    const res = await s3.get('中文 文件/报告.docx');
    const text = new TextDecoder('utf-8').decode(new Uint8Array(await res.blob.arrayBuffer()));
    assert.strictEqual(text, '内容');
    const enc = await s3.get('100% raw.txt');
    assert.strictEqual(enc.name, '100% raw.txt');
  });

  // ---------- COPY ----------
  await t.test('CopyObject 服务端复制（重命名）', async () => {
    await s3.put('src.txt', new Uint8Array([1, 2, 3]), { filename: 'src.txt' });
    await s3.copy('src.txt', 'dst/rename.txt');
    assert.ok(mock.store.has('dst/rename.txt'), '目标应存在');
    assert.ok(mock.store.has('src.txt'), '源应保留');
    assert.strictEqual(mock.store.get('dst/rename.txt').data.length, 3);

    let del = null;
    try { await s3.copy('no-such-key.txt', 'x/y.txt'); } catch (e) { del = e; }
    assert.ok(del, '复制不存在的源应抛错');
    assert.strictEqual(del.status, 404);
  });

  // ---------- DELETE ----------
  await t.test('逐个删除 + 结果分类', async () => {
    await s3.put('tmp/x.txt', new Uint8Array([0]));
    await s3.put('tmp/y.txt', new Uint8Array([0]));
    const result = await s3.remove(['tmp/x.txt', 'tmp/y.txt', 'no/there.txt']);
    assert.strictEqual(result.deleted.length, 2);
    assert.strictEqual(result.failed.length, 1);
    assert.strictEqual(result.failed[0].key, 'no/there.txt');
    assert.strictEqual(result.failed[0].code, 'NoSuchKey');
    assert.ok(!mock.store.has('tmp/x.txt'));
    assert.ok(!mock.store.has('tmp/y.txt'));
  });

  await t.test('删除带进度的回调被触发', async () => {
    let calls = 0;
    await s3.remove(['a.txt'], () => calls++);
    assert.strictEqual(calls, 1);
  });

  // ---------- 请求结构校验 ----------
  await t.test('所有请求都带有合法的 SigV4 结构', () => {
    const bad = mock.log.filter(e => e.error && /authorization|sha256|date/.test(e.error));
    assert.deepStrictEqual(bad, [], '不应出现签名结构错误：' + JSON.stringify(bad.slice(0, 3)));
    assert.ok(mock.log.length > 0, 'mock 应记录到请求');
    const methods = new Set(mock.log.map(e => e.method));
    assert.ok(methods.has('GET') && methods.has('PUT') && methods.has('HEAD') && methods.has('DELETE'));
  });

  await t.test('URL 路径编码正确（key 被正确解码还原）', () => {
    const puts = mock.log.filter(e => e.note === 'put');
    assert.ok(puts.some(e => e.key === 'photo (1).png'), '含括号 key 应被正确还原');
    assert.ok(puts.some(e => e.key === '中文 文件/报告.docx'), '中文 key 应被正确还原');
    assert.ok(puts.some(e => e.key === '100% raw.txt'), '含 % 的 key 应被正确还原');
  });

  await mock.stop();
});

test('XML 解析：实体转义与元数据', () => {
  const { parseListing, xmlUnescape } = require('../public/js/s3.js');

  assert.strictEqual(xmlUnescape('a&lt;b&amp;c&gt;d&#65;&#x42;'), 'a<b&c>dAB');

  const xml = [
    '<?xml version="1.0"?><ListBucketResult>',
    '<Contents><Key>a&amp;b.txt</Key><LastModified>2024-01-02T03:04:05Z</LastModified><Size>13</Size></Contents>',
    '<Contents><Key>folder/</Key><LastModified>2024-01-02T03:04:05Z</LastModified><Size>0</Size>'
    + '<Metadata><Name>note</Name><Value>x &lt; y</Value></Metadata></Contents>',
    // 空文件夹只以 CommonPrefixes 形态出现，必须被解析出来
    '<CommonPrefixes><Prefix>empty/</Prefix></CommonPrefixes>',
    '<IsTruncated>true</IsTruncated><NextContinuationToken>abc%2F</NextContinuationToken>',
    '</ListBucketResult>'
  ].join('');

  const p = parseListing(xml);
  assert.strictEqual(p.items.length, 3);
  assert.strictEqual(p.items[0].name, 'a&b.txt');
  assert.strictEqual(p.items[0].size, 13);
  assert.strictEqual(typeof p.items[0].size, 'number');
  assert.strictEqual(p.items[0].isFolder, false);
  assert.strictEqual(p.items[0].lastModified, '2024-01-02T03:04:05Z');
  assert.strictEqual(p.items[1].isFolder, true);
  assert.strictEqual(p.items[1].meta.note, 'x < y');
  // CommonPrefixes -> 折叠后的子目录
  assert.strictEqual(p.items[2].name, 'empty/');
  assert.strictEqual(p.items[2].isFolder, true);
  assert.strictEqual(p.items[2].size, 0);
  assert.deepStrictEqual(p.items[2].meta, {});
  assert.strictEqual(p.truncated, true);
  // NextContinuationToken 是 S3 返回的 opaque 令牌（可能含百分号编码），应保持原样传给下一次请求
  assert.strictEqual(p.nextContinuationToken, 'abc%2F');

  // 空响应与无 CommonPrefixes 的响应
  assert.deepStrictEqual(parseListing('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'),
    { items: [], truncated: false, nextContinuationToken: null });
});

test('分片上传（multipart）：大文件切片上传 / 内容一致 / 元数据保留 / 失败清理', async (t) => {
  const mock = createMockS3();
  await mock.start();
  t.after(() => mock.stop());
  const s3 = mock.client;
  // 小文件路径走 XHR（Node 无原生 XMLHttpRequest，用 xhr2 补齐，与 upload-signature 测试一致）
  global.XMLHttpRequest = require('xhr2');

  await t.test('正常分片上传：内容按片序拼接还原', async () => {
    // 64MB：≥ MULTIPART_THRESHOLD 触发分片；partSizeFor(64MB)=16MB → 4 片
    const chunks = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x11, 0x22, 0x33].map(b => Buffer.alloc(8 * 1024 * 1024, b));
    const full = Buffer.concat(chunks);
    const body = new Blob([full]);
    const res = await s3.uploadSmart('big/video.mp4', body, { filename: 'video.mp4', contentType: 'video/mp4' });
    assert.strictEqual(res.key, 'big/video.mp4');
    assert.strictEqual(res.parts, 4);

    const got = await s3.get('big/video.mp4');
    const gotBuf = Buffer.from(await got.blob.arrayBuffer());
    assert.strictEqual(gotBuf.length, full.length, '长度一致');
    // 每 16MB 一片（= 相邻两个 8MB chunk）
    for (let p = 0; p < 4; p++) {
      const seg = gotBuf.slice(p * 16 * 1024 * 1024, (p + 1) * 16 * 1024 * 1024);
      assert.ok(seg.slice(0, 8 * 1024 * 1024).equals(chunks[p * 2]) &&
                seg.slice(8 * 1024 * 1024).equals(chunks[p * 2 + 1]), '第 ' + (p + 1) + ' 片内容一致');
    }
    assert.strictEqual(got.metadata.filename, 'video.mp4', '元数据在 Create 步骤写入并保留');
  });

  await t.test('小文件仍走普通 PUT（不应产生分片请求）', async () => {
    mock.log.length = 0;
    await s3.uploadSmart('small.txt', 'hello', { filename: 'small.txt' });
    const notes = mock.log.map(l => l.note || '');
    assert.ok(!notes.some(n => String(n).startsWith('multipart')), '不应出现 multipart 请求');
    const got = await s3.get('small.txt');
    assert.strictEqual(Buffer.from(await got.blob.arrayBuffer()).toString('utf8'), 'hello');
  });

  await t.test('中止请求：对不存在的 uploadId abort 幂等返回 204', async () => {
    assert.ok(mock.store.has('big/video.mp4'), '前置：上一用例的对象仍存在');
    await assert.doesNotReject(() => s3.request('DELETE', s3.objURL('big/video.mp4') + '?uploadId=mock-upload-not-exist', null, null, null));
  });

  await t.test('浏览器读不到分片 ETag（桶 CORS 未暴露）时自动降级为整包上传', async () => {
    // 集成（Node）环境 xhr2 读到 ETag，这里在单元层面验证降级逻辑：
    // uploadSmart 在 putLarge 抛 MissingETag 时应改走 putWithProgress。
    const origPutLarge = s3.putLarge;
    const origPutWithProgress = s3.putWithProgress;
    let immediately = false;
    s3.putWithProgress = function (key) {
      immediately = true;
      return { key: key }; // 不真正传输，只证明分流发生
    };
    s3.putLarge = function () {
      const e = new Error('分片 1 未返回 ETag');
      e.code = 'MissingETag';
      return Promise.reject(e);
    };
    try {
      const blob33 = new Blob([new Uint8Array(65 * 1024 * 1024)]); // ≥64MB 触发分片分支
      const r = await s3.uploadSmart('fallback/大文件.bin', blob33, { filename: '大文件.bin' });
      assert.ok(immediately, 'MissingETag 时应降级为整包 PUT');
      assert.strictEqual(r.key, 'fallback/大文件.bin');
    } finally {
      s3.putLarge = origPutLarge;
      s3.putWithProgress = origPutWithProgress;
    }
  });
});

test('usageStats：完整对象与未完成分片一并计入真实用量', async (t) => {
  const mock = createMockS3();
  await mock.start();
  t.after(() => mock.stop());
  const s3 = mock.client;

  await t.test('空桶统计为 0', async () => {
    const stats = await s3.usageStats();
    assert.strictEqual(stats.total, 0);
    assert.strictEqual(stats.objectBytes, 0);
    assert.strictEqual(stats.partBytes, 0);
    assert.strictEqual(stats.uploads, 0);
  });

  await t.test('完整对象按大小累加', async () => {
    await s3.put('a.bin', Buffer.alloc(1000, 1));
    await s3.put('dir/b.bin', Buffer.alloc(2500, 2));
    const stats = await s3.usageStats();
    assert.strictEqual(stats.objectBytes, 3500);
    assert.strictEqual(stats.partBytes, 0, '无分片时 partBytes 应为 0');
    assert.strictEqual(stats.total, 3500);
    assert.strictEqual(stats.objectCount, 2);
  });

  await t.test('未完成分片上传的字节必须计入（ListObjectsV2 看不到它们）', async () => {
    // 手工制造一个「已写入分片但未 Complete」的上传：Create → PUT 两片
    const createRes = await s3.request('POST', s3.objURL('half.bin') + '?uploads', null, null, null);
    const uploadId = (await createRes.response.text()).match(/<UploadId>([\s\S]*?)<\/UploadId>/)[1];
    await s3.request('PUT', s3.objURL('half.bin') + '?partNumber=1&uploadId=' + uploadId, null, null, Buffer.alloc(4096, 7));
    await s3.request('PUT', s3.objURL('half.bin') + '?partNumber=2&uploadId=' + uploadId, null, null, Buffer.alloc(1024, 7));

    // 前提确认：对象列表里看不见这些碎片
    let listed = [];
    let tok2 = null;
    do {
      const page = await s3.list({ prefix: '', token: tok2 });
      listed = listed.concat(page.items);
      tok2 = page.nextContinuationToken;
    } while (tok2);
    assert.ok(!listed.some(i => i.name === 'half.bin'), '碎片不应出现在 ListObjectsV2 结果中');

    const stats = await s3.usageStats();
    assert.strictEqual(stats.uploads, 1);
    assert.strictEqual(stats.partBytes, 4096 + 1024, '两片分片字节应全部计入');
    assert.strictEqual(stats.objectBytes, 3500, '完整对象不受影响');
    assert.strictEqual(stats.total, 3500 + 5120, '真实用量 = 对象 + 碎片');

    const parts = await s3.listParts('half.bin', uploadId);
    assert.strictEqual(parts.length, 2);
    assert.strictEqual(parts[0].partNumber, 1);

    // 中止后碎片不再计入（服务端释放容量）
    await s3.request('DELETE', s3.objURL('half.bin') + '?uploadId=' + uploadId, null, null, null);
    const after = await s3.usageStats();
    assert.strictEqual(after.partBytes, 0);
    assert.strictEqual(after.total, 3500);
  });
});

test('预签名 GET URL：查询字符串签名结构正确且确定性一致', async (t) => {
  // publicGet：模拟真实 R2 对预签名 URL 的访问形态（浏览器 <a href> 不带签名 header）
  const mock = createMockS3({ publicGet: true });
  await mock.start();
  t.after(() => mock.stop());
  const s3 = mock.client;

  const opts = { expires: 600 };
  const url1 = await s3.presignedGetUrl('中文 文件/报告.docx', opts);

  await t.test('包含全部预签名参数且 key 正确编码', () => {
    assert.ok(url1.includes('X-Amz-Algorithm=AWS4-HMAC-SHA256'), 'Algorithm');
    assert.ok(url1.includes('X-Amz-Credential='), 'Credential');
    assert.ok(url1.includes('X-Amz-Expires=600'), 'Expires');
    assert.ok(url1.includes('X-Amz-SignedHeaders=host'), 'SignedHeaders');
    assert.match(url1, /X-Amz-Signature=[0-9a-f]{64}/, 'Signature 为 64 位十六进制');
    assert.ok(url1.includes(encodeURIComponent('中文 文件') + '/' + encodeURIComponent('报告.docx')), 'key 编码正确');
    assert.ok(url1.includes('response-content-disposition='), '携带附件下载头');
  });

  await t.test('同一签名时间下结果完全一致（幂等）', async () => {
    const SigV4 = require('../public/js/sigv4.js');
    const fixed = new Date('2026-01-01T00:00:00Z');
    const signOpts = {
      method: 'GET', url: s3.objURL('a.txt'), expires: 600,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: fixed
    };
    const a = await SigV4.presign(signOpts);
    const b = await SigV4.presign({ ...signOpts, date: new Date('2026-01-01T00:00:00Z') });
    assert.strictEqual(a, b, '相同输入产生相同签名');
    assert.notStrictEqual(a, url1, '不同凭证/时间应产生不同签名');
  });

  await t.test('mock 的 publicGet 模式下预签名 URL 可直接取回内容（等价真实 R2 行为）', async () => {
    await s3.put('dl/浅拷贝.bin', Buffer.from([1, 2, 3]));
    const url = await s3.presignedGetUrl('dl/浅拷贝.bin');
    // 用 http.get + agent:false 取回：避免 undici 连接池的 keep-alive socket
    // 让测试进程无法退出（这正是此前全套测试挂起的原因）
    const http = require('node:http');
    const result = await new Promise((resolve, reject) => {
      http.get(url, { agent: false }, (r) => {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => resolve({ status: r.statusCode, buf: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
    assert.strictEqual(result.status, 200);
    assert.deepEqual([...result.buf], [1, 2, 3]);
  });
});
