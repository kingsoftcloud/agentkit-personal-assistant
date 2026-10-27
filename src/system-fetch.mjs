/**
 * 带系统信任链的 fetch。
 *
 * 预发/内网网关（`pa-desktop-dev.agent-pre.kspmas.ksyun.com` 等）用的是内网 CA 签发的证书：
 * macOS 钥匙串信任它，但 Node 自带的 CA 库不信任，于是 `fetch` 直接抛
 * `TypeError: fetch failed`（cause: self-signed certificate in certificate chain），
 * 面板就表现为「检查失败 · fetch failed」「暂时无法读取助理列表」。
 *
 * 这里用 `node:https` + `tls.getCACertificates('system')`（Node ≥ 22.15）把系统证书并入
 * 信任链；只有 https 才走这条路径，plain http 与 data/相对 URL 仍交给全局 fetch。
 */
import https from 'node:https';
import tls from 'node:tls';

let cachedCA;

/** 系统信任链 + Node 内置根证书；取不到系统证书时退回内置根证书。 */
export function trustedCAs() {
  if (cachedCA !== undefined) return cachedCA;
  const bundled = Array.isArray(tls.rootCertificates) ? tls.rootCertificates : [];
  let system = [];
  try {
    if (typeof tls.getCACertificates === 'function') system = tls.getCACertificates('system');
  } catch { system = []; }
  cachedCA = [...bundled, ...(Array.isArray(system) ? system : [])];
  return cachedCA;
}

/** HEADERS 输入可能是 Headers / 数组 / 普通对象，统一成普通对象交给 https.request。 */
function headerObject(input) {
  if (!input) return {};
  if (typeof Headers === 'function' && input instanceof Headers) return Object.fromEntries(input.entries());
  if (Array.isArray(input)) return Object.fromEntries(input);
  return { ...input };
}

/**
 * 构造一个与全局 fetch 形状兼容、但对 https 使用系统信任链的实现。
 * @param {typeof fetch} [fallback] 非 https 请求的兜底实现，默认全局 fetch。
 * @returns {typeof fetch} fetch 兼容函数
 */
export function createSystemFetch(fallback = globalThis.fetch) {
  return async function systemFetch(input, init = {}) {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url ?? input);
    let url;
    try { url = new URL(raw); } catch { return fallback(input, init); }
    if (url.protocol !== 'https:') return fallback(input, init);
    return new Promise((resolve, reject) => {
      const request = https.request(url, {
        method: init.method ?? 'GET',
        headers: headerObject(init.headers),
        ca: trustedCAs(),
        signal: init.signal ?? undefined,
        rejectUnauthorized: true,
      }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve(new Response(body, { status: response.statusCode ?? 500, statusText: response.statusMessage ?? '', headers: headerObject(response.headers) }));
        });
        response.on('error', reject);
      });
      request.on('error', reject);
      const body = init.body;
      if (body === undefined || body === null) request.end();
      else if (typeof body === 'string' || Buffer.isBuffer(body)) request.end(body);
      else if (typeof body === 'object' && typeof body.pipe === 'function') body.pipe(request);
      else request.end(String(body));
    });
  };
}
