import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test('demo server starts, serves UI and explicitly synthetic API flag', { timeout: 15000 }, async () => {
  const port = 35000 + randomInt(20000);
  const serverPath = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const child = spawn(process.execPath, [serverPath, '--demo'], {
    env: { ...process.env, RADAR_PORT: String(port), X_API_BEARER_TOKEN: '' },
    stdio: 'ignore'
  });
  try {
    let response = null;
    for (let attempt = 0; attempt < 70; attempt++) {
      try {
        response = await fetch('http://127.0.0.1:' + port + '/api/status', {
          signal: AbortSignal.timeout(500)
        });
        if (response.ok) break;
      } catch { /* waiting for child to listen */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(response?.ok, 'demo HTTP server never became available');
    const status = await response.json();
    assert.equal(status.status, 'DEMO_ONLY_NO_LIVE_SOURCE');
    assert.equal(status.metrics.flags, 1);
    const alertsResponse = await fetch('http://127.0.0.1:' + port + '/api/alerts');
    assert.equal(alertsResponse.status, 200);
    const alerts = await alertsResponse.json();
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].demo, true);
    const page = await fetch('http://127.0.0.1:' + port + '/');
    assert.match(await page.text(), /Social Radar/);
  } finally { child.kill(); }
});
