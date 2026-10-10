import { isIP } from 'node:net';

// Do not fetch arbitrary launch-supplied hosts. Add vetted public metadata
// gateways through RADAR_METADATA_HOSTS if a provider is missing.
const DEFAULT_HOSTS = [
  'ipfs.io', 'gateway.pinata.cloud', 'pump.mypinata.cloud',
  'gateway.irys.xyz', 'arweave.net', 'cf-ipfs.com', 'cloudflare-ipfs.com',
  'dweb.link', 'w3s.link', 'nftstorage.link', 'ipfs.filebase.io'
];
function hostAllowed(host, hosts) {
  return hosts.some(entry => host === entry ||
    (entry.startsWith('*.') && host.endsWith(entry.slice(1))));
}
export function normalizeMetadataUrl(raw, extraHosts = '') {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let target = raw.trim();
  if (target.startsWith('ipfs://')) target = 'https://ipfs.io/ipfs/' + target.slice(7).replace(/^ipfs\//, '');
  if (target.startsWith('ar://')) target = 'https://arweave.net/' + target.slice(5);
  let url;
  try { url = new URL(target); } catch { return null; }
  const hosts = DEFAULT_HOSTS.concat(extraHosts.split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.port || !hostAllowed(url.hostname.toLowerCase(), hosts) ||
      isIP(url.hostname) || url.hostname === 'localhost') return null;
  url.hash = '';
  return url.href;
}
async function readLimited(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('EMPTY_BODY');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function getMetadata(uri, { fetchFn = fetch, extraHosts = '' } = {}) {
  let target = normalizeMetadataUrl(uri, extraHosts);
  if (!target) throw new Error('METADATA_HOST_UNSUPPORTED');
  for (let redirects = 0; redirects < 3; redirects++) {
    const response = await fetchFn(target, {
      signal: AbortSignal.timeout(7000), redirect: 'manual',
      headers: { Accept: 'application/json' }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = new URL(response.headers.get('location') || '/', target).href;
      target = normalizeMetadataUrl(next, extraHosts);
      if (!target) throw new Error('METADATA_REDIRECT_BLOCKED');
      continue;
    }
    if (!response.ok) throw new Error('METADATA_HTTP_' + response.status);
    const body = await readLimited(response, 262144);
    const json = JSON.parse(body);
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('METADATA_INVALID_JSON');
    return json;
  }
  throw new Error('METADATA_TOO_MANY_REDIRECTS');
}
export function extractXHandle(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const paths = [
    ['twitter'], ['x'], ['socials', 'twitter'], ['socials', 'x'],
    ['links', 'twitter'], ['links', 'x'], ['extensions', 'twitter'], ['extensions', 'x']
  ];
  for (const path of paths) {
    let value = metadata;
    for (const key of path) value = value?.[key];
    if (typeof value !== 'string') continue;
    let handle = null;
    const trimmed = value.trim();
    if (/^@?[A-Za-z0-9_]{1,15}$/.test(trimmed)) {
      handle = trimmed.replace(/^@/, '');
    } else {
      try {
        const url = new URL(trimmed);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
        if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) continue;
        const parts = url.pathname.split('/').filter(Boolean);
        if (parts.length !== 1) continue; // no posts, search, intent, redirects
        handle = parts[0];
      } catch { continue; }
    }
    if (handle && /^[A-Za-z0-9_]{1,15}$/.test(handle) &&
        !['home', 'intent', 'share', 'search', 'i', 'explore', 'hashtag', 'settings'].includes(handle.toLowerCase())) {
      return handle;
    }
  }
  return null;
}
export function bioMintStatus(description, mint) {
  if (typeof description !== 'string') return 'UNAVAILABLE';
  if (typeof mint !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return 'UNAVAILABLE';
  const alphabet = '1-9A-HJ-NP-Za-km-z';
  const re = new RegExp('(^|[^' + alphabet + '])' + mint + '($|[^' + alphabet + '])');
  return re.test(description) ? 'BIO_MENTIONS_MINT' : 'NOT_FOUND_IN_BIO';
}
export async function getXProfile(handle, bearerToken, { fetchFn = fetch } = {}) {
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return { status: 'INVALID_HANDLE' };
  if (!bearerToken) return { status: 'AUTH_REQUIRED' };
  const endpoint = 'https://api.x.com/2/users/by/username/' +
    encodeURIComponent(handle) + '?user.fields=public_metrics,description';
  try {
    const response = await fetchFn(endpoint, {
      signal: AbortSignal.timeout(8000),
      headers: { Authorization: 'Bearer ' + bearerToken, Accept: 'application/json' },
      redirect: 'error'
    });
    if (response.status === 429) return { status: 'RATE_LIMITED' };
    if (response.status === 401 || response.status === 403) return { status: 'AUTH_REQUIRED' };
    if (!response.ok) return { status: 'HTTP_' + response.status };
    const raw = await readLimited(response, 65536);
    const data = JSON.parse(raw).data;
    if (!data || typeof data.id !== 'string' || typeof data.username !== 'string' ||
        data.username.toLowerCase() !== handle.toLowerCase() ||
        !Number.isSafeInteger(data.public_metrics?.followers_count) ||
        data.public_metrics.followers_count < 0) return { status: 'INVALID_RESPONSE' };
    return {
      status: 'OBSERVED', username: data.username, userId: data.id,
      followers: data.public_metrics.followers_count,
      description: typeof data.description === 'string' ? data.description : null,
      collectedAtMs: Date.now()
    };
  } catch {
    return { status: 'NETWORK_OR_RESPONSE_ERROR' };
  }
}
