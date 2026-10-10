import { PUMP_PROGRAM, parsePumpLogNotification } from './decoder.mjs';

export const DEFAULT_WS = 'wss://api.mainnet.solana.com/';
export async function runPumpStream({ url = DEFAULT_WS, signal, onLaunch, onStatus = () => {} }) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'wss:' || endpoint.username || endpoint.password) {
    throw new Error('SOLANA_WS_URL must use wss:// without URL userinfo');
  }
  let reconnects = 0;
  while (!signal.aborted) {
    const ws = new WebSocket(url);
    let subscription = null;
    let acked = false;
    let closeResolve;
    const closed = new Promise(resolve => { closeResolve = resolve; });
    const failConnectTimer = setTimeout(() => { if (!acked) ws.close(); }, 15000);
    const shutdown = () => ws.close();
    signal.addEventListener('abort', shutdown, { once: true });
    ws.onopen = () => {
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'logsSubscribe',
        params: [{ mentions: [PUMP_PROGRAM] }, { commitment: 'processed' }]
      }));
      onStatus('SUBSCRIBING');
    };
    ws.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.id === 1) {
        if (Number.isSafeInteger(message.result)) {
          subscription = message.result;
          acked = true;
          onStatus('CONNECTED');
        } else { ws.close(); }
        return;
      }
      if (!acked) return;
      for (const launch of parsePumpLogNotification(message, subscription)) {
        try { onLaunch({ ...launch, firstObservedAtMs: Date.now() }); }
        catch { onStatus('LAUNCH_CALLBACK_ERROR'); }
      }
    };
    ws.onerror = () => { onStatus('SOCKET_ERROR'); ws.close(); };
    ws.onclose = () => closeResolve();
    onStatus('CONNECTING');
    await closed;
    clearTimeout(failConnectTimer);
    signal.removeEventListener('abort', shutdown);
    if (signal.aborted) break;
    reconnects++;
    onStatus('DISCONNECTED');
    // A reconnect does not prove continuity; this is alert discovery only.
    await new Promise(resolve => {
      const t = setTimeout(resolve, Math.min(30000, 1000 * 2 ** Math.min(5, reconnects)));
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  onStatus('STOPPED');
}
