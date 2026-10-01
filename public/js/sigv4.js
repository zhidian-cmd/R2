/**
 * sigv4.js - AWS Signature Version 4 签名实现（零依赖，浏览器 / Node 通用）
 *
 * 用于对 Cloudflare R2 的 S3 API 请求进行签名。
 * 参考：https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html
 *
 * 对外暴露：
 *   SigV4.uriEncode(str, encodeSlash)
 *   SigV4.sha256Hex(data)                        -> hex 字符串
 *   SigV4.sign({ method, url, headers, payloadHash, accessKeyId, secretAccessKey, region, service, date })
 *                                                -> 返回完整 Authorization header 值
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SigV4 = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var textEncoder = new TextEncoder();

  // 常量：空内容的 SHA-256
  var EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  function toUint8(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return textEncoder.encode(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new TypeError('unsupported data type for hashing');
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) {
      out[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return out;
  }

  /** SHA-256，返回 hex 字符串 */
  function sha256Hex(data) {
    return crypto.subtle.digest('SHA-256', toUint8(data)).then(function (buf) {
      return bytesToHex(new Uint8Array(buf));
    });
  }

  /** HMAC-SHA256，key 与 data 均支持 string / Uint8Array / ArrayBuffer */
  function hmac(key, data) {
    return crypto.subtle.importKey(
      'raw',
      toUint8(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    ).then(function (cryptoKey) {
      return crypto.subtle.sign('HMAC', cryptoKey, toUint8(data));
    }).then(function (buf) {
      return bytesToHex(new Uint8Array(buf));
    });
  }

  /**
   * AWS 规范要求的 URI 编码：
   *  - 除 unreserved 字符（A-Z a-z 0-9 - _ . ~）外全部百分号编码
   *  - 与 encodeURIComponent 的区别：!'()* 也要编码
   *  - encodeSlash=false 时不编码 '/'
   */
  function uriEncode(str, encodeSlash) {
    if (encodeSlash === undefined) encodeSlash = true;
    var encoded = encodeURIComponent(str)
      .replace(/[!'()*]/g, function (c) {
        return '%' + c.charCodeAt(0).toString(16).toUpperCase();
      });
    if (!encodeSlash) {
      encoded = encoded.replace(/%2F/gi, '/');
    }
    return encoded;
  }

  /**
   * 构造 canonical URI：
   *  - 空路径或根路径 -> "/"
   *  - 其余按 "/" 分段，每段独立编码后重新拼接（保留原有斜杠）
   */
  function canonicalUri(pathname) {
    if (!pathname || pathname === '/') return '/';
    var decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch (e) {
      decoded = pathname;
    }
    return decoded.split('/').map(function (seg) {
      return uriEncode(seg, true);
    }).join('/');
  }

  /**
   * 构造 canonical query string：
   *  - 按编码后的参数名排序
   *  - key 与 value 均 awsUriEncode（空 value 也保留 '='）
   */
  function canonicalQueryString(search) {
    var params = [];
    var sp = new URLSearchParams(search);
    for (var pair of sp.entries()) {
      params.push([uriEncode(pair[0], true), uriEncode(pair[1], true)]);
    }
    params.sort(function (a, b) {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      return 0;
    });
    return params.map(function (p) {
      return p[0] + '=' + p[1];
    }).join('&');
  }

  /** 规范化 header 值：trim + 压缩连续空格 */
  function normalizeHeaderValue(value) {
    return String(value).trim().replace(/\s+/g, ' ');
  }

  /**
   * 计算签名并返回 Authorization header 值。
   *
   * @param {Object} opts
   * @param {string} opts.method            HTTP 方法（大写）
   * @param {string|URL} opts.url           完整 URL
   * @param {Object} [opts.headers]         参与签名的额外 header（host/x-amz-date 自动加入）
   * @param {string} [opts.payloadHash]     请求体 SHA-256（hex），默认空串 hash
   * @param {string} opts.accessKeyId
   * @param {string} opts.secretAccessKey
   * @param {string} [opts.region]          默认 'auto'（R2 约定）
   * @param {string} [opts.service]         默认 's3'
   * @param {Date}   [opts.date]            可注入时间（测试用），默认当前时间
   * @returns {Promise<{authorization: string, headers: Object}>}
   *          headers 为必须随请求一起发送的头（x-amz-date / x-amz-content-sha256 / authorization）
   */
  async function sign(opts) {
    var method = String(opts.method || 'GET').toUpperCase();
    var url = opts.url instanceof URL ? opts.url : new URL(opts.url);
    var headers = Object.assign({}, opts.headers || {});
    var payloadHash = opts.payloadHash || EMPTY_SHA256;
    var accessKeyId = opts.accessKeyId;
    var secretAccessKey = opts.secretAccessKey;
    var region = opts.region || 'auto';
    var service = opts.service || 's3';

    var date = opts.date || new Date();
    var amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    var dateStamp = amzDate.slice(0, 8);

    // 合并签名所需 header。
    // host 始终纳入签名（S3 规范要求，MinIO 等严格实现会拒绝未签名的 host）。
    // 浏览器 fetch/XHR 会自动发送与 URL 一致的 Host 头，无需手动设置。
    var allHeaders = {};
    for (var key in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, key)) continue;
      allHeaders[key.toLowerCase()] = normalizeHeaderValue(headers[key]);
    }
    if (!allHeaders['host']) allHeaders['host'] = normalizeHeaderValue(url.host);
    allHeaders['x-amz-date'] = amzDate;
    allHeaders['x-amz-content-sha256'] = payloadHash;

    // canonical headers：按 key 排序
    var sortedKeys = Object.keys(allHeaders).sort();
    var canonicalHeaders = sortedKeys.map(function (k) {
      return k + ':' + allHeaders[k];
    }).join('\n') + '\n';
    var signedHeaders = sortedKeys.join(';');

    var canonicalRequest = [
      method,
      canonicalUri(url.pathname),
      canonicalQueryString(url.search),
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    var scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
    var stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256Hex(canonicalRequest)
    ].join('\n');

    // HMAC 密钥链
    var kDate = await hmac('AWS4' + secretAccessKey, dateStamp);
    var kRegion = await hmac(hexToBytes(kDate), region);
    var kService = await hmac(hexToBytes(kRegion), service);
    var kSigning = await hmac(hexToBytes(kService), 'aws4_request');
    var signature = await hmac(hexToBytes(kSigning), stringToSign);

    var authorization = 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope +
      ', SignedHeaders=' + signedHeaders +
      ', Signature=' + signature;

    // 返回必须随请求一起发送的 header。
    // 关键：x-amz-date 与 x-amz-content-sha256 参与签名，若实际请求未带上这两个头，
    // 服务端会返回 SignatureDoesNotMatch / MissingHeaders。
    return {
      authorization: authorization,
      headers: {
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        'authorization': authorization
      }
    };
  }

  /**
   * 生成预签名 URL（查询字符串签名）。
   *
   * 与 sign() 的 header 签名不同，预签名把签名放进 URL 查询参数，
   * 浏览器可以直接用它发起请求（如 <a href> 原生下载），无需 JS 再构造 header。
   * 规范请求的 payloadHash 固定为 UNSIGNED-PAYLOAD（S3 预签名的标准约定）。
   *
   * @param {Object} opts
   * @param {string} opts.method            HTTP 方法（大写），默认 GET
   * @param {string|URL} opts.url           完整 URL（可自带查询参数，会一并参与签名）
   * @param {number} [opts.expires]         签名有效期（秒），默认 600
   * @param {Object} [opts.queryParams]     额外查询参数（如 response-content-disposition），参与签名
   * @param {string} opts.accessKeyId
   * @param {string} opts.secretAccessKey
   * @param {string} [opts.region]          默认 'auto'
   * @param {string} [opts.service]         默认 's3'
   * @param {Date}   [opts.date]            可注入时间（测试用）
   * @returns {Promise<string>} 带签名的完整 URL
   */
  async function presign(opts) {
    var method = String(opts.method || 'GET').toUpperCase();
    var url = opts.url instanceof URL ? opts.url : new URL(opts.url);
    var expires = Number(opts.expires) || 600;
    var accessKeyId = opts.accessKeyId;
    var secretAccessKey = opts.secretAccessKey;
    var region = opts.region || 'auto';
    var service = opts.service || 's3';

    var date = opts.date || new Date();
    var amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
    var dateStamp = amzDate.slice(0, 8);
    var scope = dateStamp + '/' + region + '/' + service + '/aws4_request';

    // 汇总全部查询参数（URL 自带 + 额外业务参数 + 预签名专用参数）
    var params = [];
    var sp = new URLSearchParams(url.search);
    for (var pair of sp.entries()) {
      params.push([uriEncode(pair[0], true), uriEncode(pair[1], true)]);
    }
    var extra = opts.queryParams || {};
    for (var ek in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, ek)) {
        params.push([uriEncode(ek, true), uriEncode(String(extra[ek]), true)]);
      }
    }
    params.push([uriEncode('X-Amz-Algorithm', true), uriEncode('AWS4-HMAC-SHA256', true)]);
    params.push([uriEncode('X-Amz-Credential', true), uriEncode(accessKeyId + '/' + scope, true)]);
    params.push([uriEncode('X-Amz-Date', true), uriEncode(amzDate, true)]);
    params.push([uriEncode('X-Amz-Expires', true), uriEncode(String(expires), true)]);
    params.push([uriEncode('X-Amz-SignedHeaders', true), uriEncode('host', true)]);
    params.sort(function (a, b) {
      if (a[0] < b[0]) return -1;
      if (a[0] > b[0]) return 1;
      return 0;
    });
    var canonicalQuery = params.map(function (p) { return p[0] + '=' + p[1]; }).join('&');

    // 预签名只签 host header，payload 固定 UNSIGNED-PAYLOAD
    var canonicalRequest = [
      method,
      canonicalUri(url.pathname),
      canonicalQuery,
      'host:' + normalizeHeaderValue(url.host) + '\n',
      'host',
      'UNSIGNED-PAYLOAD'
    ].join('\n');

    var stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      await sha256Hex(canonicalRequest)
    ].join('\n');

    var kDate = await hmac('AWS4' + secretAccessKey, dateStamp);
    var kRegion = await hmac(hexToBytes(kDate), region);
    var kService = await hmac(hexToBytes(kRegion), service);
    var kSigning = await hmac(hexToBytes(kService), 'aws4_request');
    var signature = await hmac(hexToBytes(kSigning), stringToSign);

    // 拼接路径与签名请求中的 canonicalUri 保持同一形式，杜绝未来改动引入不一致
    return url.origin + canonicalUri(url.pathname) + '?' + canonicalQuery + '&X-Amz-Signature=' + signature;
  }

  return {
    uriEncode: uriEncode,
    sha256Hex: sha256Hex,
    hmac: hmac,
    sign: sign,
    presign: presign,
    EMPTY_SHA256: EMPTY_SHA256
  };
});
