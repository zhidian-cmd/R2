/**
 * s3.js - 基于 fetch 的 S3 兼容 REST 客户端（零依赖，浏览器运行）
 *
 * 面向 Cloudflare R2：R2 兼容 S3 协议，使用「账户级 endpoint + bucket 置于子域名」的寻址方式。
 * 关键点：
 *   - 不依赖任何部署时绑定，连接信息（Access Key ID / Secret / Endpoint / Bucket）由用户在页面填写
 *   - 请求签名见 sigv4.js
 *   - ListObjectsV2 自动翻页（continuation-token）
 *   - 对象复制使用服务端 CopyObject，删除使用逐个 DELETE（零依赖，不计算 Content-MD5）
 *
 * 用法：
 *   const s3 = new S3Client({ accessKeyId, secretAccessKey, endpoint, bucket });
 *   const page = await s3.list({ prefix: '' });
 *   const meta = await s3.head('path/to/file.txt');
 *   await s3.put('new.txt', new Blob([...]));
 *   const blob = await s3.get('new.txt');
 *   await s3.remove(['a.txt', 'b.txt']);
 *   await s3.copy('a.txt', 'folder/b.txt');
 *   await s3.mkdir('folder/');
 */
(function (root, factory) {
  if (typeof exports === 'object' && exports && typeof module === 'object' && module.exports) {
    // CommonJS / Node 环境
    module.exports = factory();
  } else {
    // 浏览器（及任何非 CommonJS 环境）：挂载到全局
    root.S3Client = factory();
  }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // 浏览器中 SigV4 由前一个 <script> 提供；Node 中回退到 require。
  // 注意：右侧必须通过 globalThis 取全局，不能直接写裸标识符 SigV4。
  // 否则 `var SigV4` 的声明提升会让右侧的 SigV4 指向本函数内尚未初始化的局部变量，
  // 在浏览器中恒定为 undefined，从而强制走 require 并抛 ReferenceError。
  var SigV4 = (typeof globalThis !== 'undefined' && globalThis.SigV4)
    ? globalThis.SigV4
    : require('./sigv4.js');

  var MAX_KEYS = 1000;
  var DEFAULT_REGION = 'auto'; // R2 约定区域
  // 请求超时：只覆盖「建立连接 + 收到响应头」阶段（超时后立刻取消计时），
  // 大文件的 body 传输不受此限制，不会被中途掐断
  var REQUEST_TIMEOUT_MS = 30000;
  // 带 body 的上传请求用宽松超时兜底死连接：响应头在整包传完后才到达，
  // 不能用短超时（30 秒曾掐死弱网大分片导致视频上传全部失败）；
  // 10 分钟传不完 8MB 分片（约 11KB/s 以下）才判定为死连接，交给分片重试
  var BODY_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
  // 分片上传：阈值 64MB（32MB 的文件拆 4 片收益有限）。
  // 分片大小随文件体积自适应：小大文件用小片（失败重传代价小），
  // 超大文件用大片（减少分片数与 Complete 负载）。除最后一片外每片 ≥5MB（R2 要求）。
  var MULTIPART_THRESHOLD = 64 * 1024 * 1024;
  var PART_CONCURRENCY = 6;

  function partSizeFor(fileSize) {
    if (fileSize < 64 * 1024 * 1024) return 8 * 1024 * 1024;
    if (fileSize < 512 * 1024 * 1024) return 16 * 1024 * 1024;
    return 32 * 1024 * 1024;
  }

  function safeDecode(str) {
    try { return decodeURIComponent(str); } catch (e) { return str; }
  }

  /**
   * 按 S3 规范编码 object key：
   *  - 先解码为原始字符串（容忍调用方已部分编码的输入）
   *  - 再按 '/' 分段逐段编码，保留路径分隔符
   *  - 其余字符全部百分号编码（含中文、空格、() 等）
   */
  var _encCache = new Map(); // key -> encoded（纯函数结果，LRU 500 足够覆盖活跃目录）
  function encodeKey(key) {
    if (!key) return '';
    var hit = _encCache.get(key);
    if (hit !== undefined) return hit;
    var raw = safeDecode(String(key));
    var result = raw.split('/').map(function (seg) {
      return SigV4.uriEncode(seg, true);
    }).join('/');
    if (_encCache.size > 500) _encCache.delete(_encCache.keys().next().value);
    _encCache.set(key, result);
    return result;
  }

  /** 解码 XML 文本中的 HTML 实体 */
  function xmlUnescape(str) {
    return String(str)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, function (_m, hex) { return String.fromCharCode(parseInt(hex, 16)); })
      .replace(/&#(\d+);/g, function (_m, dec) { return String.fromCharCode(parseInt(dec, 10)); })
      .replace(/&amp;/g, '&');
  }

  /** 从 Headers 中不区分大小写地读取某个 header */
  function headerAt(headers, name) {
    var lower = name.toLowerCase();
    var result = null;
    headers.forEach(function (value, key) {
      if (key.toLowerCase() === lower) result = value;
    });
    return result;
  }

  /**
   * 解析 ListBucketResult（ListObjectsV2 响应）。
   * 同时处理两种条目形态：
   *   - <Contents>          真实对象
   *   - <CommonPrefixes>    折叠后的子前缀（S3 在带 delimiter 列举时的标准折叠方式，
   *                         不含子对象的空文件夹只以这种形态出现）
   * 输出项：{ name, size, isFolder, lastModified, meta }
   */
  function parseListing(xml) {
    var items = [];
    var pick = function (block, tag) {
      var mm = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
      return mm ? xmlUnescape(mm[1]) : null;
    };
    var metaOf = function (block) {
      var meta = {};
      var metaBlock = '';
      var m2 = /<Metadata>([\s\S]*?)<\/Metadata>/g;
      var mv;
      while ((mv = m2.exec(block)) !== null) metaBlock += mv[1];
      var kvRe = /<Name>([\s\S]*?)<\/Name><Value>([\s\S]*?)<\/Value>/g;
      var kv;
      while ((kv = kvRe.exec(metaBlock)) !== null) meta[kv[1]] = xmlUnescape(kv[2]);
      return meta;
    };

    var m;
    var contents = /<Contents>([\s\S]*?)<\/Contents>/g;
    while ((m = contents.exec(xml)) !== null) {
      var block = m[1];
      var key = pick(block, 'Key');
      if (!key) continue;
      var sizeStr = pick(block, 'Size');
      items.push({
        name: key,
        size: sizeStr !== null ? Number(sizeStr) : 0,
        // 以 '/' 结尾的对象是 S3 的「文件夹标记」（0 字节占位）
        isFolder: key.length > 0 && key.charAt(key.length - 1) === '/',
        lastModified: pick(block, 'LastModified') || null,
        meta: metaOf(block)
      });
    }

    var prefixes = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
    while ((m = prefixes.exec(xml)) !== null) {
      var p = pick(m[1], 'Prefix');
      if (!p) continue;
      items.push({
        name: p,
        size: 0,
        isFolder: true,
        lastModified: null,
        meta: {}
      });
    }

    var token = pick(xml, 'NextContinuationToken');
    return {
      items: items,
      truncated: /<IsTruncated>true<\/IsTruncated>/.test(xml),
      nextContinuationToken: token || null
    };
  }

  /** 解码响应元数据的值（上传时做了百分号编码） */
  function decodeMetaValue(value) {
    var s = String(value);
    if (s.indexOf('%') === -1) return s;
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /**
   * 构造上传请求头。
   * - x-amz-meta-filename     记住原始文件名，下载时据此还原
   * - x-amz-meta-content-type 记住 MIME 类型。R2 的 HEAD 响应不返回 Content-Type，
   *                            因此额外写入用户元数据以便读回展示
   * - content-type            正常上传时也应携带，便于服务端正确识别
   *
   * 注意：HTTP header 的值必须是 Latin-1（ByteString），中文等字符会直接导致 fetch 抛错。
   * 因此用户元数据的值统一做百分号编码，读取时用 decodeMetaValue 还原。
   */
  function buildUploadHeaders(extra) {
    var headers = {};
    if (extra && extra.filename) headers['x-amz-meta-filename'] = SigV4.uriEncode(extra.filename, true);
    if (extra && extra.contentType) {
      headers['x-amz-meta-content-type'] = extra.contentType;
      headers['content-type'] = extra.contentType;
    }
    if (extra && extra.meta) {
      for (var k in extra.meta) {
        if (Object.prototype.hasOwnProperty.call(extra.meta, k)) {
          headers['x-amz-meta-' + k] = SigV4.uriEncode(String(extra.meta[k]), true);
        }
      }
    }
    return headers;
  }

  function S3Client(opts) {
    if (!opts || !opts.accessKeyId || !opts.secretAccessKey) {
      throw new Error('缺少凭证：accessKeyId 与 secretAccessKey 为必填');
    }
    if (!opts.endpoint) throw new Error('缺少 endpoint');
    if (!opts.bucket) throw new Error('缺少 bucket');

    var endpoint = String(opts.endpoint).trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(endpoint)) endpoint = 'https://' + endpoint;

    this.cfg = {
      accessKeyId: String(opts.accessKeyId).trim(),
      secretAccessKey: String(opts.secretAccessKey).trim(),
      endpoint: endpoint,
      bucket: String(opts.bucket).trim(),
      region: opts.region || DEFAULT_REGION
    };
  }

  /** bucket 寻址地址：endpoint.host/bucket/key */
  S3Client.prototype.objURL = function (key) {
    return this.cfg.endpoint + '/' + this.cfg.bucket + (key ? '/' + encodeKey(key) : '');
  };

  /**
   * 构造并发送一个已签名的请求。
   * @param {string} method
   * @param {string} url    完整 URL
   * @param {Object} [signHeaders] 参与签名的额外 header（x-amz-copy-source、x-amz-meta-* 等）
   * @param {Object} [sendHeaders] 实际发送的 header（可含不参与签名的字段）
   * @param {Uint8Array|Blob|null} [body]
   * @param {Object} [opts] { cache: 'no-store', signal: AbortSignal }
   */
  S3Client.prototype.request = async function (method, url, signHeaders, sendHeaders, body, opts) {
    opts = opts || {};
    signHeaders = signHeaders || {};
    sendHeaders = sendHeaders || {};
    var headers = new Headers();
    var lowerSign = {};
    for (var k in signHeaders) {
      if (Object.prototype.hasOwnProperty.call(signHeaders, k)) {
        headers.set(k, String(signHeaders[k]));
        lowerSign[k.toLowerCase()] = String(signHeaders[k]);
      }
    }
    for (var s in sendHeaders) {
      if (Object.prototype.hasOwnProperty.call(sendHeaders, s)) headers.set(s, String(sendHeaders[s]));
    }

    // 请求体哈希：带 body 的请求一律使用 UNSIGNED-PAYLOAD——
    // 跳过「把整个文件读进内存再算一次 SHA-256」的预读开销（上传优化的最大单项），
    // 传输完整性由 TLS 保证；R2 / AWS S3 / MinIO 均支持。无 body 保持空串哈希。
    var payloadHash = body ? 'UNSIGNED-PAYLOAD' : SigV4.EMPTY_SHA256;

    var result = await SigV4.sign({
      method: method,
      url: url,
      headers: lowerSign,
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      service: 's3',
      payloadHash: payloadHash
    });
    // 把签名所需的 header 一并发送（x-amz-date / x-amz-content-sha256 / authorization）
    for (var hk in result.headers) {
      if (Object.prototype.hasOwnProperty.call(result.headers, hk)) {
        headers.set(hk, result.headers[hk]);
      }
    }

    var init = { method: method, headers: headers };
    if (body) init.body = body;
    if (opts.cache === false) init.cache = 'no-store';
    // 短超时只用于元数据类请求（无 body）。带 body 的上传请求绝不能设：
    // 上传的响应头要等整个包传完才到达，30 秒会掐死弱网下的大分片
    // （曾导致视频分片上传全部失败）；上传卡死由分片重试机制兜底。
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutTimer = null;
    var outerAborted = false; // 外部主动取消（区别于内部超时）：错误码用 Aborted，便于上层"静默退出、不重试"
    if (controller) {
      init.signal = controller.signal;
      timeoutTimer = setTimeout(function () { controller.abort(); }, body ? BODY_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      if (opts.signal) {
        // 外部取消联动（如切换配置时终止后台容量扫描）：外部 abort → 内部一起 abort
        if (opts.signal.aborted) outerAborted = true;
        else opts.signal.addEventListener('abort', function () { outerAborted = true; controller.abort(); });
      }
    }

    var response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      // 个别环境（如 jsdom + Node fetch 混用）里 AbortSignal 来自不同 realm，
      // fetch 会直接拒绝 signal 参数——此时去掉 signal 原样重发（请求尚未发出，无副作用）
      if (controller && err && /AbortSignal/i.test(String(err.message))) {
        delete init.signal;
        response = await fetch(url, init);
      } else if (err && err.name === 'AbortError') {
        throw outerAborted
          ? new S3Error('请求已取消', 0, '', 'Aborted')
          : new S3Error('请求超时无响应，请检查网络后重试', 0, '', 'Timeout');
      } else {
        throw err;
      }
    }
    // 响应头已到达：解除计时，之后的 body 下载/读取不限时
    if (timeoutTimer) clearTimeout(timeoutTimer);
    var res = {
      status: response.status,
      ok: response.ok,
      response: response,
      headers: response.headers,
      lastModified: headerAt(response.headers, 'last-modified'),
      metadata: this.collectMeta(response.headers),
      size: headerAt(response.headers, 'content-length')
    };
    if (!res.ok) {
      var text = '';
      try { text = await response.text(); } catch (e) { /* ignore */ }
      var msg = 'HTTP ' + response.status;
      var code = (text.match(/<Code>([\s\S]*?)<\/Code>/) || [])[1];
      var name = (text.match(/<Message>([\s\S]*?)<\/Message>/) || [])[1];
      if (code) msg += ' · ' + code;
      if (name) msg += ' · ' + name;
      throw new S3Error(msg, response.status, text, code);
    }
    return res;
  };

  /** 从响应头提取 x-amz-meta-* 元数据（值做百分号解码还原） */
  S3Client.prototype.collectMeta = function (headers) {
    var meta = {};
    headers.forEach(function (value, key) {
      var lower = key.toLowerCase();
      if (lower.indexOf('x-amz-meta-') === 0) {
        meta[lower.slice(11)] = decodeMetaValue(value);
      }
    });
    return meta;
  };

  /**
   * 列出对象（不翻页，单次最多 1000）。
   * opts.delimiter 默认 '/'（目录式折叠）；传 null 则递归列举全部对象（listEach 用）。
   * @returns {Promise<{items: Array, truncated: boolean, nextContinuationToken: string|null}>}
   */
  S3Client.prototype.list = async function (opts) {
    opts = opts || {};
    var url = this.cfg.endpoint + '/' + this.cfg.bucket + '?list-type=2';
    var params = [];
    if (opts.prefix) params.push('prefix=' + SigV4.uriEncode(opts.prefix, true));
    if (opts.delimiter !== null) params.push('delimiter=' + SigV4.uriEncode(opts.delimiter || '/', true));
    if (opts.maxKeys) params.push('max-keys=' + Math.min(MAX_KEYS, Number(opts.maxKeys) || 1000));
    if (opts.token) params.push('continuation-token=' + SigV4.uriEncode(opts.token, true));
    url += '&' + params.join('&');

    var res = await this.request('GET', url, null, null, null, { signal: opts.signal });
    var xml = await res.response.text();
    return parseListing(xml);
  };

  /**
   * 流式遍历指定前缀下的全部对象（自动翻页，递归进入所有子前缀）。
   * 每页通过 onPage(items, page) 交付，不累积数组——统计累加等场景零内存占用。
   * onPage 返回 false 可提前终止。
   */
  S3Client.prototype.listEach = async function (prefix, onPage, opts) {
    opts = opts || {};
    prefix = prefix || '';
    var token = null;
    for (var guard = 0; guard < 10000; guard++) {
      // delimiter 必须为 null：折叠模式拿不到子目录内容，
      // 会让容量统计漏算、文件夹重命名/移动丢失嵌套内容
      var page = await this.list({ prefix: prefix, token: token, delimiter: null, maxKeys: opts.maxKeys, signal: opts.signal });
      var stop = onPage(page.items || [], page);
      if (stop === false) break;
      if (!page.truncated || !page.nextContinuationToken) break;
      token = page.nextContinuationToken;
    }
  };

  /**
   * 列举已初始化但未完成（也未中止）的分片上传（ListMultipartUploads，自动翻页）。
   * R2 的 S3 兼容层已实现该接口。返回 [{ key, uploadId, initiated }]。
   */
  S3Client.prototype.listMultipartUploads = async function (opts) {
    opts = opts || {};
    var out = [];
    var keyMarker = '';
    var uploadIdMarker = '';
    for (var guard = 0; guard < 1000; guard++) {
      var url = this.cfg.endpoint + '/' + this.cfg.bucket + '?uploads&max-uploads=1000';
      if (keyMarker) url += '&key-marker=' + SigV4.uriEncode(keyMarker, true);
      if (uploadIdMarker) url += '&upload-id-marker=' + SigV4.uriEncode(uploadIdMarker, true);
      var res = await this.request('GET', url, null, null, null, { signal: opts.signal });
      var xml = await res.response.text();
      var pick = function (block, tag) {
        var mm = block.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
        return mm ? xmlUnescape(mm[1]) : null;
      };
      var m, re = /<Upload>([\s\S]*?)<\/Upload>/g;
      while ((m = re.exec(xml)) !== null) {
        var key = pick(m[1], 'Key');
        var id = pick(m[1], 'UploadId');
        if (key && id) out.push({ key: key, uploadId: id, initiated: pick(m[1], 'Initiated') });
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
      var nextKey = pick(xml, 'NextKeyMarker');
      var nextId = pick(xml, 'NextUploadIdMarker');
      if (!nextKey || (nextKey === keyMarker && nextId === uploadIdMarker)) break; // 防死循环
      keyMarker = nextKey;
      uploadIdMarker = nextId || '';
    }
    return out;
  };

  /**
   * 列举某个分片上传已上传的分片（ListParts，自动翻页）。
   * 返回 [{ partNumber, size }]——size 即该分片在桶里实际占用的字节。
   */
  S3Client.prototype.listParts = async function (key, uploadId, opts) {
    opts = opts || {};
    var out = [];
    var marker = '';
    for (var guard = 0; guard < 1000; guard++) {
      var url = this.objURL(key) + '?uploadId=' + SigV4.uriEncode(uploadId, true) + '&max-parts=1000';
      if (marker) url += '&part-number-marker=' + encodeURIComponent(marker);
      var res = await this.request('GET', url, null, null, null, { signal: opts.signal });
      var xml = await res.response.text();
      var m, re = /<Part>([\s\S]*?)<\/Part>/g;
      while ((m = re.exec(xml)) !== null) {
        var num = (m[1].match(/<PartNumber>([\s\S]*?)<\/PartNumber>/) || [])[1];
        var size = (m[1].match(/<Size>([\s\S]*?)<\/Size>/) || [])[1];
        if (num) out.push({ partNumber: Number(num), size: Number(size) || 0 });
      }
      if (!/<IsTruncated>true<\/IsTruncated>/.test(xml)) break;
      var next = (xml.match(/<NextPartNumberMarker>([\s\S]*?)<\/NextPartNumberMarker>/) || [])[1];
      if (!next || next === marker) break;
      marker = next;
    }
    return out;
  };

  /**
   * 全量精算桶的真实用量：完整对象 + 未完成分片上传已写入的字节。
   *
   * 为什么必须加上分片：ListObjectsV2 只能看到「合并成功」的对象，
   * 中断/失败的 multipart 分片不在列表里，但 R2 按分片实际存储计容量与费用。
   * 只统计完整对象会让面板在碎片堆积时显示"没满"，导致持续超限。
   *
   * opts.onProgress(listedCount)：每翻一页回调一次已列举对象数（大桶扫描的实时进度）。
   * opts.signal：AbortSignal——切换配置时由调用方终止过期的后台扫描，立即停止占用连接。
   * 任一环节失败都会 reject（宁可报"统计失败"，也不返回可能偏小的假数字）。
   */
  S3Client.prototype.usageStats = async function (opts) {
    opts = opts || {};
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    var signal = opts.signal || null;
    var objectBytes = 0;
    var objectCount = 0;
    await this.listEach('', function (items) {
      for (var i = 0; i < items.length; i++) {
        objectBytes += Number(items[i].size) || 0;
        objectCount++;
      }
      if (onProgress) onProgress(objectCount);
    }, { signal: signal });

    // 分片统计并发 6 路：每个未完成 upload 要一次 ListParts 请求，
    // 残留分片多的大桶串行要 N 个来回（每个几百 ms），是扫描慢的主要来源之一
    var partBytes = 0;
    var uploads = await this.listMultipartUploads({ signal: signal });
    var CONCURRENCY = 6;
    var cursor = 0;
    var firstError = null;
    var self = this;
    async function worker() {
      while (cursor < uploads.length && !firstError) {
        var up = uploads[cursor++];
        // 单个 upload 的分片列举失败（如恰好在此刻被合并/中止）：跳过该 upload，
        // 但接口级失败（权限、网络、被取消）必须让整体 reject
        try {
          var parts = await self.listParts(up.key, up.uploadId, { signal: signal });
          var sum = 0;
          for (var p = 0; p < parts.length; p++) sum += Number(parts[p].size) || 0;
          partBytes += sum;
        } catch (err) {
          if (err && (err.status === 0 || err.code === 'AccessDenied' || err.code === 'Timeout' ||
              err.code === 'Aborted' || err.name === 'AbortError')) {
            firstError = firstError || err;
            return;
          }
        }
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(CONCURRENCY, uploads.length); w++) workers.push(worker());
    await Promise.all(workers);
    if (firstError) throw firstError;

    return {
      objectBytes: objectBytes,
      partBytes: partBytes,
      total: objectBytes + partBytes,
      objectCount: objectCount,
      uploads: uploads.length
    };
  };

  /**
   * 读取对象元信息（HEAD，不下载内容）。供测试与外部集成使用；
   * 上传失败复核（uploadEntries）也依赖它判断对象是否实际写入。
   * 注意：R2 出于安全考虑不通过响应头暴露 Content-Type，故此处 size / lastModified 可靠，
   * contentType 需结合上传时写入的 x-amz-meta-content-type 或按扩展名推断。
   */
  S3Client.prototype.head = async function (key) {
    var res = await this.request('HEAD', this.objURL(key), null, null, null);
    return {
      name: key,
      size: res.size ? Number(res.size) : null,
      lastModified: res.lastModified,
      contentType: res.metadata['content-type'] || null,
      filename: res.metadata['filename'] || null,
      meta: res.metadata
    };
  };

  /** 下载对象内容为 Blob */
  S3Client.prototype.get = async function (key) {
    var res = await this.request('GET', this.objURL(key), null, null, null, { cache: false });
    return {
      blob: await res.response.blob(),
      name: key,
      metadata: res.metadata,
      status: res.status,
      lastModified: res.lastModified
    };
  };

  /**
   * 生成对象下载的预签名 URL（默认 10 分钟有效）。
   * 浏览器可直接 <a href> 原生流式下载：边下边落盘，不把整个文件读进 JS 内存。
   * response-content-disposition 让浏览器按「附件」下载而不是尝试打开预览。
   */
  S3Client.prototype.presignedGetUrl = async function (key, opts) {
    opts = opts || {};
    var rawName = safeDecode(String(key)).split('/').pop() || 'download';
    // filename 提供纯 ASCII 兜底，filename* 承载中文等非 ASCII 文件名
    var asciiFallback = rawName.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    var disposition = 'attachment; filename="' + asciiFallback + '"; filename*=UTF-8\'\'' + encodeURIComponent(rawName);
    // S3 规范上限 7 天：越界值会被服务端整体拒绝且报错难懂，这里直接收敛
    var expires = Math.min(Math.max(1, Number(opts.expires) || 600), 604800);
    // noDisposition：不附带 response-content-disposition。预览（<img>/<video>/<audio> src）
    // 用——媒体标签本就不理会该头，去掉可让 URL 更短、缓存键更干净
    return await SigV4.presign({
      method: 'GET',
      url: this.objURL(key),
      expires: expires,
      queryParams: opts.noDisposition ? null : { 'response-content-disposition': disposition },
      accessKeyId: this.cfg.accessKeyId,
      secretAccessKey: this.cfg.secretAccessKey,
      region: this.cfg.region,
      service: 's3'
    });
  };

  /**
   * 上传对象。
   * @param {string} key
   * @param {Blob|Uint8Array|ArrayBuffer} body
   * @param {Object} [extra] { filename, contentType, meta }
   */
  S3Client.prototype.put = async function (key, body, extra) {
    extra = extra || {};
    var headers = buildUploadHeaders(extra);
    await this.request('PUT', this.objURL(key), headers, headers, body);
    return { key: key, name: (extra && extra.filename) || key };
  };

  /**
   * 带真实上传进度的 PUT（XHR 实现，fetch 无法报告上传进度）。
   * onProgress({ loaded, total, percent })
   */
  S3Client.prototype.putWithProgress = function (key, body, extra, onProgress) {
    extra = extra || {};
    var self = this;
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('PUT', self.objURL(key), true);
      // UNSIGNED-PAYLOAD：跳过「把整个文件读进内存再算一次 SHA-256」的预读，
      // 直接开始流式上传；传输完整性由 TLS 保证（R2/AWS/MinIO 均支持）
      (function () {
        var headers = buildUploadHeaders(extra);
        // 注意：x-amz-content-sha256 会由 SigV4.sign 返回的签名头统一设置，
        // 这里不能放进业务头 —— 否则 setRequestHeader 会追加成 "hash, hash"，
        // 与签名时的单值不一致，R2 报 SignatureDoesNotMatch（此前导致所有上传失败）。
        return SigV4.sign({
          method: 'PUT',
          url: self.objURL(key),
          headers: headers,
          accessKeyId: self.cfg.accessKeyId,
          secretAccessKey: self.cfg.secretAccessKey,
          region: self.cfg.region,
          service: 's3',
          payloadHash: 'UNSIGNED-PAYLOAD'
        }).then(function (signed) {
          return { signed: signed, headers: headers };
        });
      })().then(function (ctx) {
        var signed = ctx.signed;
        // 先 set 业务头（与签名一致），再 set 签名必需头。
        // 注意：签名时将业务头纳入 SignedHeaders，若发送时漏掉这些头，
        // R2 校验会报 SignatureDoesNotMatch。
        var businessHeaders = ctx.headers || {};
        for (var bh in businessHeaders) {
          if (Object.prototype.hasOwnProperty.call(businessHeaders, bh)) {
            xhr.setRequestHeader(bh, businessHeaders[bh]);
          }
        }
        for (var k in signed.headers) {
          if (Object.prototype.hasOwnProperty.call(signed.headers, k)) {
            xhr.setRequestHeader(k, signed.headers[k]);
          }
        }
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable && typeof onProgress === 'function') {
            onProgress({ loaded: e.loaded, total: e.total, percent: Math.round(e.loaded / e.total * 100) });
          }
        };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve({ key: key, name: (extra && extra.filename) || key });
          } else {
            var msg = 'HTTP ' + xhr.status;
            var text = xhr.responseText || '';
            var code = (text.match(/<Code>([\s\S]*?)<\/Code>/) || [])[1];
            var nm = (text.match(/<Message>([\s\S]*?)<\/Message>/) || [])[1];
            if (code) msg += ' · ' + code;
            if (nm) msg += ' · ' + nm;
            var err = new Error(msg);
            err.status = xhr.status;
            err.code = code || null;
            reject(err);
          }
        };
        xhr.onerror = function () {
          reject(new Error('网络错误：上传请求发送失败'));
        };
        xhr.send(body);
      }).catch(reject);
    });
  };

  /**
   * 分片上传大文件：Create → 并发逐片 PUT（3 路，单片失败自动重试一次）→ Complete。
   * 切片用 file.slice 按需读取，不会把整个文件读进内存；
   * 任一片最终失败则 Abort 整个上传（清理服务端残留分片）并抛错。
   * onProgress({ loaded, total, percent }) 与 putWithProgress 对齐（按完成字节计）。
   */
  S3Client.prototype.putLarge = async function (key, file, extra, onProgress) {
    var self = this;
    var uploadId = null; // 并发分片数用模块级 PART_CONCURRENCY（此前局部 3 遮蔽了模块级 6）
    try {
      // 1. 创建分片上传（对象元数据在这一步写入）
      var createHeaders = buildUploadHeaders(extra);
      var createRes = await this.request('POST', this.objURL(key) + '?uploads', createHeaders, createHeaders, null);
      var createXml = await createRes.response.text();
      var idMatch = createXml.match(/<UploadId>([\s\S]*?)<\/UploadId>/);
      uploadId = idMatch ? xmlUnescape(idMatch[1]) : null;
      if (!uploadId) throw new S3Error('创建分片上传失败：响应中缺少 UploadId', createRes.status, createXml, null);

      // 2. 并发上传分片（worker 池；进度按已完成分片的字节累计）
      var PART_SIZE = partSizeFor(file.size);
      var total = Math.ceil(file.size / PART_SIZE);
      var etags = new Array(total);
      var nextPart = 1;
      var completedBytes = 0;
      var firstError = null;

      async function partWorker() {
        while (!firstError) {
          var i = nextPart++;
          if (i > total) return;
          var blob = file.slice((i - 1) * PART_SIZE, Math.min(file.size, i * PART_SIZE));
          var partUrl = self.objURL(key) + '?partNumber=' + i + '&uploadId=' + SigV4.uriEncode(uploadId, true);
          var etag = null;
          // 单片失败重试一次（网络抖动常见；分片重传只补传 8MB，代价远小于整文件重来）
          for (var attempt = 0; attempt < 2; attempt++) {
            try {
              var partRes = await self.request('PUT', partUrl, null, null, blob);
              etag = headerAt(partRes.headers, 'etag');
              break;
            } catch (err) {
              if (attempt === 1) { firstError = firstError || err; return; }
            }
          }
          if (!etag) {
            // 浏览器跨域下 ETag 属于非暴露响应头：桶的 CORS 未配置 ExposeHeaders 时读不到。
            // 抛专用码，由 uploadSmart 降级为整包上传（并提示用户补 CORS 配置恢复分片）
            firstError = firstError || new S3Error('分片 ' + i + ' 未返回 ETag：桶的 CORS 需添加 ExposeHeaders ["ETag"]（见设置页 CORS 示例）', 0, '', 'MissingETag');
            return;
          }
          etags[i - 1] = etag;
          completedBytes += blob.size;
          if (typeof onProgress === 'function') {
            onProgress({ loaded: completedBytes, total: file.size, percent: Math.round(completedBytes / file.size * 100) });
          }
        }
      }

      var workers = [];
      for (var w = 0; w < Math.min(PART_CONCURRENCY, total); w++) workers.push(partWorker());
      await Promise.all(workers);
      if (firstError) throw firstError;

      // 3. 合并分片（按片序）
      var completeXml = '<CompleteMultipartUpload>' +
        etags.map(function (etag, idx) {
          return '<Part><PartNumber>' + (idx + 1) + '</PartNumber><ETag>' + etag + '</ETag></Part>';
        }).join('') + '</CompleteMultipartUpload>';
      var finishHeaders = { 'content-type': 'application/xml' };
      var finishRes = await this.request('POST', this.objURL(key) + '?uploadId=' + SigV4.uriEncode(uploadId, true), finishHeaders, finishHeaders, completeXml);
      var finishText = await finishRes.response.text();
      if (!/<CompleteMultipartUploadResult>/.test(finishText)) {
        throw new S3Error('合并分片失败：' + finishText.slice(0, 200), finishRes.status, finishText, null);
      }
      return { key: key, name: (extra && extra.filename) || key, parts: total };
    } catch (err) {
      // 失败时中止并清理服务端残留分片
      if (uploadId) {
        try {
          await self.request('DELETE', self.objURL(key) + '?uploadId=' + SigV4.uriEncode(uploadId, true), null, null, null);
        } catch (e) { /* 清理失败不影响主错误 */ }
      }
      throw err;
    }
  };

  /** 智能上传：小于阈值走带进度的 PUT，大文件自动转分片上传。
   *  分片因桶 CORS 未暴露 ETag 而失败时，自动降级为整包上传（浏览器流式读取文件，
   *  不额外占内存），保证功能可用；补上 ExposeHeaders 后下次自动恢复分片。 */
  S3Client.prototype.uploadSmart = function (key, body, extra, onProgress) {
    var size = body && body.size ? body.size : 0;
    if (size >= MULTIPART_THRESHOLD && typeof body.slice === 'function') {
      var self = this;
      return this.putLarge(key, body, extra, onProgress).catch(function (err) {
        if (err && err.code === 'MissingETag') {
          return self.putWithProgress(key, body, extra, onProgress);
        }
        throw err;
      });
    }
    return this.putWithProgress(key, body, extra, onProgress);
  };

  /** 删除一个或多个对象（单批最多 1000） */
  /**
   * 服务端复制对象（不下载内容，适合重命名 / 移动）。
   * x-amz-copy-source 必须使用「bucket/key」形式，key 需单独编码。
   */
  S3Client.prototype.copy = async function (srcKey, dstKey) {
    var source = '/' + this.cfg.bucket + '/' + encodeKey(srcKey);
    var headers = { 'x-amz-copy-source': source };
    await this.request('PUT', this.objURL(dstKey), headers, headers, null);
    return { srcKey: srcKey, dstKey: dstKey };
  };

  /**
   * 创建文件夹。
   * S3 无真实目录，R2 文件夹本质是以 '/' 结尾、长度为 0 的对象，且必须显式创建。
   */
  S3Client.prototype.mkdir = async function (path) {
    var key = String(path).replace(/^\/+/, '').replace(/\/+$/, '') + '/';
    if (!key) throw new Error('文件夹路径不能为空');
    await this.request('PUT', this.objURL(key), null, null, new Uint8Array(0));
    return { key: key };
  };

  /**
   * 删除一个或多个对象。
   * S3 DeleteObjects 批量接口要求为请求体计算 Content-MD5（浏览器无原生实现），
   * 因此逐个 DELETE，但并发流水线执行（默认 4 路）——删除小对象的耗时主要是往返延迟，
   * 并发后大批量删除的墙钟时间约为串行的 1/4。
   * 已删除的空文件夹会随最后一个对象删除而消失（S3 无真实目录概念）。
   */
  S3Client.prototype.remove = async function (keys, onProgress) {
    var all = Array.isArray(keys) ? keys.slice() : [keys];
    var self = this;
    var results = new Array(all.length);
    var done = 0;
    var cursor = 0;

    async function worker() {
      while (cursor < all.length) {
        var i = cursor++;
        var k = all[i];
        try {
          await self.request('DELETE', self.objURL(k), null, null, null);
          results[i] = { deleted: { key: k } };
        } catch (err) {
          var code = 'Error';
          if (err && err.status === 404) code = 'NoSuchKey';
          else if (err && err.status === 403) code = 'AccessDenied';
          else if (err && err.message && /NoSuchKey|EntityDoesNotExist/.test(err.message)) code = 'NoSuchKey';
          results[i] = { failed: { key: k, code: code, message: err && err.message ? err.message : String(err) } };
        }
        done++;
        if (typeof onProgress === 'function') onProgress(done, all.length, k);
      }
    }

    var workers = [];
    for (var w = 0; w < Math.min(4, all.length); w++) workers.push(worker());
    await Promise.all(workers);

    var deleted = [];
    var failed = [];
    for (var r = 0; r < results.length; r++) {
      if (results[r].deleted) deleted.push(results[r].deleted);
      else failed.push(results[r].failed);
    }
    return { deleted: deleted, failed: failed };
  };

  /** 客户端错误类型 */
  function S3Error(message, status, xml, code) {
    var err = new Error(message);
    err.name = 'S3Error';
    err.status = status;
    err.xml = xml || '';
    err.code = code || null; // S3 错误码：SignatureDoesNotMatch / AccessDenied / NoSuchBucket / NoSuchKey ...
    return err;
  }
  S3Client.S3Error = S3Error;
  S3Client.encodeKey = encodeKey;
  S3Client.parseListing = parseListing;
  S3Client.xmlUnescape = xmlUnescape;
  return S3Client;
});