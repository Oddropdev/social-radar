// Minimal, independent Pump CreateEvent reader. The discriminator/layout is public
// Pump event data; future layout changes fail closed rather than fabricate launches.
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const CREATE_DISCRIMINATOR = '1b72a94ddeeb6376';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const textDecoder = new TextDecoder('utf-8', { fatal: true });

export function encodeBase58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = BASE58[Number(value % 58n)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out;
}
function readString(bytes, state) {
  if (state.pos + 4 > bytes.length) throw new Error('CREATE_SHORT_STRING_LENGTH');
  const len = bytes.readUInt32LE(state.pos);
  state.pos += 4;
  if (len > 4096 || state.pos + len > bytes.length) throw new Error('CREATE_STRING_OUT_OF_BOUNDS');
  const value = textDecoder.decode(bytes.subarray(state.pos, state.pos + len));
  state.pos += len;
  return value;
}
export function decodeCreateData(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 32768 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== CREATE_DISCRIMINATOR) return null;
  try {
    const state = { pos: 8 };
    const name = readString(bytes, state);
    const symbol = readString(bytes, state);
    const uri = readString(bytes, state);
    if (state.pos + 32 > bytes.length) return null;
    const mint = encodeBase58(bytes.subarray(state.pos, state.pos + 32));
    if (mint.length < 32 || mint.length > 44) return null;
    // The remaining documented CreateEvent fields, including versioned opaque
    // tails, are deliberately not interpreted by the follower-only scanner.
    return { mint, name: name.slice(0, 160), symbol: symbol.slice(0, 50), uri };
  } catch {
    return null;
  }
}
export function parsePumpLogNotification(message, expectedSubscription = null) {
  if (message?.method !== 'logsNotification') return [];
  const result = message.params?.result;
  const context = result?.context;
  const value = result?.value;
  if (!value || value.err != null || !Array.isArray(value.logs) ||
      typeof value.signature !== 'string' ||
      !Number.isSafeInteger(context?.slot) ||
      (expectedSubscription !== null && message.params.subscription !== expectedSubscription)) return [];
  const stack = [];
  const creates = [];
  for (const line of value.logs) {
    if (typeof line !== 'string') continue;
    const invoke = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]); continue; }
    const ending = /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (?:success|failed:.*)$/.exec(line);
    if (ending) {
      const i = stack.lastIndexOf(ending[1]);
      if (i !== -1) stack.length = i;
      continue;
    }
    if (stack.at(-1) !== PUMP_PROGRAM) continue;
    const data = /^Program data: ([A-Za-z0-9+/=]+)$/.exec(line);
    if (!data) continue;
    const create = decodeCreateData(data[1]);
    if (create) creates.push({ ...create, signature: value.signature, slot: context.slot });
  }
  return creates;
}
