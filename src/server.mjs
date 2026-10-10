import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Radar } from './radar.mjs';

const demo = process.argv.includes('--demo');
if (process.argv.slice(2).some(arg => arg !== '--demo')) {
  console.error('Unsupported argument. Use npm start or npm run demo.');
  process.exit(2);
}
if (!demo && !process.env.X_API_BEARER_TOKEN) {
  console.error('X_API_BEARER_TOKEN is required for live follower checks. Use npm run demo for an offline UI test.');
  process.exit(2);
}
function integerEnv(name, fallback, min, max) {
  const v = process.env[name];
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(name + ' must be an integer between ' + min + ' and ' + max);
  return n;
}
const port = integerEnv('RADAR_PORT', 4174, 1024, 65535);
const radar = new Radar({
  threshold: integerEnv('RADAR_FOLLOWER_THRESHOLD', 10000, 0, 1000000000),
  lookupsPer15m: integerEnv('RADAR_X_LOOKUPS_PER_15M', 15, 1, 900)
});
if (demo) radar.demoAlert();
else await radar.restore();
const html = await readFile(fileURLToPath(new URL('../web/index.html', import.meta.url)));
const server = http.createServer((req, res) => {
  const pathname = req.url?.split('?')[0];
  const send = (code, type, bytes) => {
    res.writeHead(code, {
      'Content-Type': type, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'"
    });
    res.end(bytes);
  };
  if (req.method !== 'GET') return send(405, 'text/plain', 'Method not allowed');
  if (pathname === '/') return send(200, 'text/html; charset=utf-8', html);
  if (pathname === '/api/status') return send(200, 'application/json', JSON.stringify(radar.publicStatus()));
  if (pathname === '/api/alerts') return send(200, 'application/json', JSON.stringify(radar.alerts));
  return send(404, 'text/plain', 'Not found');
});
server.listen(port, '127.0.0.1', () => {
  console.log('Social Radar V0: http://127.0.0.1:' + port);
  console.log(demo ? 'DEMO ONLY — NO LIVE DATA' : 'LIVE OBSERVATION MODE — NO TRADING');
});
const abort = new AbortController();
if (!demo) radar.start(abort.signal).catch(error => {
  // Never print custom websocket URL, which may contain a secret API key.
  console.error('Solana stream stopped:', error?.message === 'SOLANA_WS_URL must use wss:// without URL userinfo' ?
    'Invalid SOLANA_WS_URL' : 'source error');
  radar.onStreamStatus('ERROR');
});
function stop() {
  abort.abort();
  server.close();
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
