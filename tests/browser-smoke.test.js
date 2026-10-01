'use strict';
/**
 * browser-smoke.test.js
 *
 * 用 jsdom 构建一个真实的浏览器窗口（<script> 环境：无 module / exports / require），
 * 按 index.html 的顺序加载 public/js 下的脚本，验证：
 *   1. UMD 走浏览器分支，SigV4 / S3Client / R2Config 正确挂载到 window
 *   2. R2Config 在 localStorage 语义下的读写、校验、导入导出
 *   3. 纯函数逻辑（publicUrlOf / uriEncode）
 *   4. 浏览器分支下的 S3Client 完整端到端（配合本地 mock S3 server）
 *
 * 为什么这一步很关键：s3.js 内部的 `var SigV4 = ... ? SigV4 : require(...)` 受 var 提升影响，
 * 若写成裸标识符比较，在浏览器中会恒定为 undefined 并抛 ReferenceError，导致站点完全无法运行。
 * Node 下的 require 测试无法覆盖这条路径，因此必须用真实浏览器环境验证。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createMockS3 } = require('./mock-s3');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = ['sigv4.js', 's3.js', 'config.js'];

/** 构建一个具备 fetch / crypto / Blob 能力的浏览器窗口 */
function makeWindow() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.pages.dev'
  });
  const w = dom.window;
  w.fetch = fetch;
  w.Headers = Headers;
  w.Request = Request;
  w.Response = Response;
  w.Blob = Blob;
  if (!w.TextEncoder) w.TextEncoder = TextEncoder;
  if (!w.TextDecoder) w.TextDecoder = TextDecoder;
  // jsdom 自带的 w.crypto 不含 subtle 且为只读 getter：
  // 直接赋值 `w.crypto = crypto` 在严格模式下会抛 TypeError，必须用 defineProperty 覆盖
  Object.defineProperty(w, 'crypto', { value: crypto, configurable: true, writable: true });
  if (!w.URL) w.URL = URL;
  if (!w.URLSearchParams) w.URLSearchParams = URLSearchParams;
  w.console = console;
  w.localStorage; // jsdom 自带 localStorage
  return w;
}

/** 按 <script> 顺序加载脚本 */
function loadScripts(w) {
  SCRIPTS.forEach((f) => {
    const code = fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8');
    w.eval(code);
  });
}

test('浏览器分支：UMD 脚本挂载到 window（无 module/exports/require）', () => {
  const w = makeWindow();
  assert.strictEqual(typeof w.module, 'undefined', 'jsdom 中不应存在 module');
  assert.strictEqual(typeof w.exports, 'undefined');
  assert.strictEqual(typeof w.require, 'undefined');

  loadScripts(w);
  assert.strictEqual(typeof w.SigV4, 'object');
  assert.strictEqual(typeof w.SigV4.sign, 'function');
  assert.strictEqual(typeof w.S3Client, 'function');
  assert.strictEqual(typeof w.S3Client.encodeKey, 'function');
  assert.strictEqual(typeof w.S3Client.parseListing, 'function');
  assert.strictEqual(typeof w.R2Config, 'object');
  assert.strictEqual(typeof w.R2Config.validate, 'function');
});

test('浏览器分支：SigV4 能被 S3Client 正确复用（var 提升回归保护）', () => {
  const w = makeWindow();
  w.eval(fs.readFileSync(path.join(ROOT, 'public/js/sigv4.js'), 'utf8'));
  assert.strictEqual(w.eval('typeof SigV4'), 'object', '自由变量 SigV4 应为全局对象');
  w.eval(fs.readFileSync(path.join(ROOT, 'public/js/s3.js'), 'utf8'));
  // 该断言在 var 提升写错时会直接抛 ReferenceError: require is not defined
  assert.strictEqual(typeof w.S3Client, 'function');
  // S3Client 内部应能调用 SigV4 的编码函数（同一实例）
  assert.strictEqual(w.S3Client.encodeKey('中文 文件.txt'), '%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.txt');
  assert.strictEqual(w.SigV4.uriEncode('中文 文件.txt', true), '%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6.txt');
});

test('R2Config：写入、读取、切换、删除与校验', () => {
  const w = makeWindow();
  loadScripts(w);
  const C = w.R2Config;

  assert.strictEqual(C.getActive(), null, '初始无配置');

  const bad = C.blank();
  assert.strictEqual(C.validate(bad).ok, false);
  assert.ok(C.validate(bad).errors.endpoint, 'endpoint 应被标记为必填');
  assert.ok(C.validate(bad).errors.secretAccessKey, 'secretAccessKey 应被标记为必填');

  const good = {
    name: '生产桶',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    endpoint: 'https://abc.r2.cloudflarestorage.com',
    bucket: 'my-bucket',
    publicUrl: 'https://pub-xyz.r2.dev',
    customDomain: 'https://img.example.com'
  };
  assert.strictEqual(C.validate(good).ok, true, JSON.stringify(C.validate(good).errors));

  const saved = C.upsert(good);
  assert.ok(saved.id);
  assert.strictEqual(C.getActive().bucket, 'my-bucket');
  assert.strictEqual(C.loadAll().length, 1);
  assert.ok(w.localStorage.getItem('r2em.configs.v1'), '配置应持久化到 localStorage');

  const second = C.upsert({ ...good, id: '', name: '测试桶', bucket: 'dev-bucket' });
  assert.strictEqual(C.loadAll().length, 2);
  assert.strictEqual(C.getActive().id, second.id, '新增配置应成为当前生效项');
  C.setActive(saved.id);
  assert.strictEqual(C.getActive().id, saved.id);

  // 同 id 更新不应新增条目
  C.upsert({ ...saved, bucket: 'renamed' });
  assert.strictEqual(C.loadAll().length, 2);
  assert.strictEqual(C.getActive().bucket, 'renamed');

  // 删除当前生效项后应自动切到剩余第一条
  C.setActive(second.id);
  C.remove(second.id);
  assert.strictEqual(C.loadAll().length, 1);
  assert.strictEqual(C.getActive().id, saved.id);

  C.clearAll();
  assert.strictEqual(C.loadAll().length, 0);
  assert.strictEqual(C.getActive(), null);
});

test('R2Config.validate：各字段格式校验', () => {
  const w = makeWindow();
  loadScripts(w);
  const C = w.R2Config;
  const base = {
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    endpoint: 'https://abc.r2.cloudflarestorage.com',
    bucket: 'my-bucket'
  };
  assert.strictEqual(C.validate(base).ok, true);
  assert.match(C.validate({ ...base, endpoint: 'abc.r2.cloudflarestorage.com' }).errors.endpoint, /https/);
  assert.match(C.validate({ ...base, bucket: 'bad bucket!' }).errors.bucket, /仅允许/);
  assert.match(C.validate({ ...base, bucket: 'ab' }).errors.bucket, /长度/);
  assert.match(C.validate({ ...base, bucket: '.lead' }).errors.bucket, /开头/);
  assert.match(C.validate({ ...base, bucket: '1.2.3.4' }).errors.bucket, /IP/);
  assert.strictEqual(C.validate({ ...base, bucket: 'a.b-c_d' }).ok, true);
  assert.match(C.validate({ ...base, secretAccessKey: 'short' }).errors.secretAccessKey, /长度/);
  assert.match(C.validate({ ...base, publicUrl: 'img.x.com' }).errors.publicUrl, /https/);
  assert.match(C.validate({ ...base, customDomain: 'img.x.com' }).errors.customDomain, /https/);
  assert.strictEqual(C.validate({ ...base, publicUrl: '', customDomain: '' }).ok, true, '可选字段留空应通过');
});

test('R2Config.publicUrlOf：优先级、编码与未配置时的回退', () => {
  const w = makeWindow();
  loadScripts(w);
  const C = w.R2Config;

  const withBoth = { customDomain: 'https://img.example.com/', publicUrl: 'https://pub-xyz.r2.dev/' };
  assert.strictEqual(C.publicUrlOf(withBoth, 'a/b.txt', 'https://x'), 'https://img.example.com/a/b.txt');
  assert.strictEqual(
    C.publicUrlOf(withBoth, '中文 文件/报告.docx', 'https://x'),
    'https://img.example.com/%E4%B8%AD%E6%96%87%20%E6%96%87%E4%BB%B6/%E6%8A%A5%E5%91%8A.docx'
  );
  // 未配自定义域时回退到公共开发 URL
  assert.strictEqual(
    C.publicUrlOf({ publicUrl: 'https://pub-xyz.r2.dev/' }, 'a.txt', 'https://x'),
    'https://pub-xyz.r2.dev/a.txt'
  );
  // 两者都未配置时返回 null（表示无法生成可分享链接）
  assert.strictEqual(C.publicUrlOf({}, 'a.txt', 'https://x'), null);
});

test('R2Config：导出 JSON 可完整还原，重复导入去重', () => {
  const wa = makeWindow();
  loadScripts(wa);
  wa.R2Config.upsert({
    name: '桶1', accessKeyId: 'AKID1', secretAccessKey: 'SECRET_ONE_12345',
    endpoint: 'https://a.r2.cloudflarestorage.com', bucket: 'bucket-one'
  });
  wa.R2Config.upsert({
    name: '桶2', accessKeyId: 'AKID2', secretAccessKey: 'SECRET_TWO_67890',
    endpoint: 'https://b.r2.cloudflarestorage.com', bucket: 'bucket-two',
    customDomain: 'https://cdn.example.com'
  });
  const text = wa.R2Config.exportJson();

  const wb = makeWindow();
  loadScripts(wb);
  assert.strictEqual(wb.R2Config.importJson(text), 2);
  assert.strictEqual(wb.R2Config.loadAll().length, 2);
  assert.strictEqual(wb.R2Config.getActive().bucket, 'bucket-one', '导入后应激活第一条');
  // 重复导入不应产生重复条目
  wb.R2Config.importJson(text);
  assert.strictEqual(wb.R2Config.loadAll().length, 2);
  // 无 id 的备份按「AK+endpoint+bucket」指纹去重：反复导入不堆积
  const noId = JSON.stringify({ configs: [{
    accessKeyId: 'AKID3', secretAccessKey: 'SECRET_THREE_12345',
    endpoint: 'https://c.r2.cloudflarestorage.com', bucket: 'bucket-three'
  }] });
  wb.R2Config.importJson(noId);
  wb.R2Config.importJson(noId);
  wb.R2Config.importJson(noId);
  assert.strictEqual(wb.R2Config.loadAll().filter(c => c.bucket === 'bucket-three').length, 1, '无 id 重复导入应按指纹去重');
  // 非法输入应抛错且不影响已有数据
  const before = wb.R2Config.loadAll().length;
  assert.throws(() => wb.R2Config.importJson('{not json'), /JSON 解析失败/);
  assert.throws(() => wb.R2Config.importJson('{"foo":1}'), /格式不正确/);
  assert.throws(() => wb.R2Config.importJson('[{"bucket":"only-bucket"}]'), /没有可导入/);
  assert.strictEqual(wb.R2Config.loadAll().length, before);
});

test('浏览器分支下的 S3Client 完整端到端（mock S3 + 真实 fetch）', async () => {
  const mock = createMockS3();
  await mock.start();
  const w = makeWindow();
  loadScripts(w);

  const client = new w.S3Client({
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    endpoint: mock.endpoint,
    bucket: mock.bucket
  });

  // 上传（含中文 key 与中文元数据）
  await client.put('你好 世界/hello.txt', 'Hello 世界', { filename: 'hello.txt', contentType: 'text/plain' });
  await client.mkdir('empty/');

  // 列举：CommonPrefixes 折叠 + 文件夹标记
  const page = await client.list({ prefix: '' });
  const names = page.items.map(i => i.name).sort();
  assert.ok(names.includes('你好 世界/'), '折叠出的子目录应出现');
  assert.ok(names.includes('empty/'), '空文件夹应出现');

  // 下钻（S3 返回完整 key）
  const sub = await client.list({ prefix: '你好 世界/' });
  // 注意：这里不能用 deepStrictEqual 与字面量数组比较 —— sub.items 是 jsdom window realm 的
  // 数组，其 Array 构造器与 Node realm 不同，deepStrictEqual 会因 prototype 不匹配而失败
  assert.strictEqual(sub.items.length, 1);
  assert.strictEqual(sub.items[0].name, '你好 世界/hello.txt');
  assert.strictEqual(sub.items[0].isFolder, false);

  // 下载内容一致
  const got = await client.get('你好 世界/hello.txt');
  const text = new TextDecoder().decode(new Uint8Array(await got.blob.arrayBuffer()));
  assert.strictEqual(text, 'Hello 世界');
  assert.strictEqual(got.metadata.filename, 'hello.txt');
  assert.strictEqual(got.metadata['content-type'], 'text/plain');

  // HEAD
  const meta = await client.head('你好 世界/hello.txt');
  assert.strictEqual(meta.filename, 'hello.txt');
  assert.strictEqual(meta.contentType, 'text/plain');

  // 复制
  await client.copy('你好 世界/hello.txt', 'copy/hello.txt');
  assert.ok(mock.store.has('copy/hello.txt'));

  // 批量删除（含不存在项）
  const res = await client.remove(['copy/hello.txt', 'missing.txt']);
  assert.strictEqual(res.deleted.length, 1);
  assert.strictEqual(res.failed.length, 1);
  assert.strictEqual(res.failed[0].code, 'NoSuchKey');

  await mock.stop();
});

test('CSS 回归：hidden 属性不被 display 声明覆盖（拖拽遮罩不遮挡界面）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

  // 根因：.drop-mask { display:flex } 会覆盖 HTML 的 hidden 属性（UA 样式 [hidden]{display:none}），
  // 导致拖拽遮罩从页面加载起就一直显示、挡住整个界面（含设置按钮）。
  // 修复：全局 [hidden]{ display:none !important; } 强制隐藏。
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;\s*}/,
    'style.css 必须包含 [hidden]{display:none !important} 兜底规则');
  // 用正则定位规则本身（indexOf / search 会被注释文本误导，且注释里也含 .drop-mask{）
  // 注意：因规则带 !important，与 .drop-mask 的先后顺序无关，无需断言顺序
  assert.ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(css),
    '[hidden] 兜底规则存在且带 !important');

  // 内联兜底：规则必须内联在 index.html 的 <style> 中，随 HTML 返回，
  // 即使 style.css 被 CDN/浏览器缓存为旧版（无该规则），遮罩也不可能再显示
  const inlineStyle = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(inlineStyle && /\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(inlineStyle[1]),
    'index.html 内联 <style> 必须包含 [hidden]{display:none !important} 兜底规则');

  // 受影响元素在 HTML 中必须初始不可见。
  // dropMask / batchBar 使用内联 style="display:none"（优先级最高，任何 CSS 规则都无法覆盖，
  // 包括被 CDN 缓存的旧版 style.css）；其余元素保留 hidden 属性（其 CSS 类无 display 声明）。
  for (const id of ['viewConfig', 'viewFiles', 'progress']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
    const m = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    assert.ok(m && m[0].includes('hidden'), `#${id} 初始必须带 hidden 属性`);
  }
  for (const id of ['dropMask', 'batchBar']) {
    const m = html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`));
    assert.ok(m, `index.html 应包含 #${id}`);
    assert.ok(/style="display\s*:\s*none"/.test(m[0]),
      `#${id} 初始必须带内联 style="display:none"（最高优先级，不受旧 CSS 缓存影响）`);
  }

  // app.js 必须通过 style.display 控制这两个元素（而不是 hidden 属性）
  const app = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.match(app, /dropMask'\)\.style\.display\s*=\s*'(flex|none)'/,
    'app.js 应通过 dropMask.style.display 控制遮罩');
  assert.match(app, /bar\.style\.display\s*=\s*selected\.size === 0 \? 'none' : 'flex'/,
    'app.js 应通过 batchBar.style.display 控制批量操作栏');

  // _headers：HTML 不缓存，避免用户拿到旧页面
  const headers = fs.readFileSync(path.join(ROOT, 'public/_headers'), 'utf8');
  assert.match(headers, /index\.html[\s\S]*?Cache-Control:\s*no-cache/,
    'public/_headers 必须让 index.html 不缓存');

  // .drop-mask 确实声明了 display:flex（证明内联兜底是必须的）
  const dm = css.match(/\.drop-mask\s*\{[\s\S]*?\}/);
  assert.ok(dm && /display:\s*flex/.test(dm[0]), '.drop-mask 声明 display:flex');

  // 覆盖特定元素类的 display 声明（toolbar-right 等）不得绕过内联兜底
  const tb = css.match(/\.toolbar-left,\s*\.toolbar-right\s*\{[\s\S]*?\}/);
  assert.ok(tb && /display:\s*flex/.test(tb[0]),
    '.toolbar-left, .toolbar-right 声明 display:flex（需要内联兜底）');
});
