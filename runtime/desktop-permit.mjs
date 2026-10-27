/** Runtime 与 Computer 共用的网关签名授权校验。只包含公钥，不持有签名私钥。 */
import { createPublicKey, verify } from 'node:crypto';
export const desktopUnauthorized = message => Object.assign(new Error(message), { status: 401, code: 'DESKTOP_UNAUTHORIZED' });
const unauthorized = desktopUnauthorized;
const permitKeys = new Map();

async function desktopJwks(env) {
  if (env.AGENTKIT_DESKTOP_JWKS_JSON) return JSON.parse(env.AGENTKIT_DESKTOP_JWKS_JSON);
  const source = String(env.AGENTKIT_DESKTOP_JWKS_URL || '');
  if (!source) throw unauthorized('desktop verification keys are not configured');
  const url = new URL(source);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && env.AGENTKIT_DESKTOP_ALLOW_HTTP_JWKS === '1'))) throw unauthorized('desktop JWKS URL is not trusted');
  const cached = permitKeys.get(source);
  if (cached && cached.expires > Date.now()) return cached.value;
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok) throw unauthorized('desktop verification keys unavailable');
  const raw = await response.text();
  if (raw.length > 64 * 1024) throw unauthorized('desktop verification keys exceed limit');
  const value = JSON.parse(raw);
  permitKeys.set(source, { value, expires: Date.now() + 60_000 });
  return value;
}

/** 验证既有 Server workload 密钥签发的 JWS；不信任 caller 自带身份头。 */
export async function verifyDesktopPermit(token, { assistantId, env = process.env, now = () => Date.now() } = {}) {
  try {
    if (typeof token !== 'string' || token.length > 16 * 1024) throw unauthorized('desktop permit is missing');
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some(value => !/^[A-Za-z0-9_-]+$/u.test(value))) throw unauthorized('desktop permit is malformed');
    const header = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (header.alg !== 'EdDSA' || header.typ !== 'agentkit-desktop+jwt' || !header.kid) throw unauthorized('desktop permit algorithm is invalid');
    const jwks = await desktopJwks(env);
    const key = jwks?.keys?.find(value => value.kid === header.kid && value.kty === 'OKP' && value.crv === 'Ed25519');
    if (!key || !verify(null, Buffer.from(`${segments[0]}.${segments[1]}`, 'ascii'), createPublicKey({ key, format: 'jwk' }), Buffer.from(segments[2], 'base64url'))) throw unauthorized('desktop permit signature is invalid');
    const seconds = Math.floor(now() / 1000);
    if (claims.iss !== 'agentengine-server' || claims.aud !== 'agentkit-personal-assistant-desktop' || claims.scope !== 'desktop' || claims.agentId !== assistantId || !claims.botId || !claims.jti || !['read', 'control'].includes(claims.mode)) throw unauthorized('desktop permit binding is invalid');
    if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat > seconds || claims.exp <= seconds || claims.exp - claims.iat > 60) throw unauthorized('desktop permit expired');
    return Object.freeze(claims);
  } catch (error) { throw error?.status === 401 ? error : unauthorized('desktop permit could not be verified'); }
}

