import { appendFile, mkdir, open, stat } from 'node:fs/promises';
import path from 'node:path';
import { getMetadata, extractXHandle, getXProfile, bioMintStatus } from './enrich.mjs';
import { runPumpStream } from './stream.mjs';

export class Radar {
  constructor({
    token = process.env.X_API_BEARER_TOKEN || '',
    threshold = 10000,
    lookupsPer15m = 15,
    cacheMs = 900000,
    dataFile = path.resolve('data/alerts.jsonl'),
    metadataFetcher = getMetadata,
    profileFetcher = getXProfile
  } = {}) {
    if (![threshold, lookupsPer15m, cacheMs].every(x => Number.isSafeInteger(x) && x >= 0) ||
        lookupsPer15m < 1 || lookupsPer15m > 900 || cacheMs < 1000) throw new Error('INVALID_RADAR_CONFIG');
    this.token = token;
    this.threshold = threshold;
    this.lookupsPer15m = lookupsPer15m;
    this.cacheMs = cacheMs;
    this.dataFile = dataFile;
    this.metadataFetcher = metadataFetcher;
    this.profileFetcher = profileFetcher;
    this.queue = [];
    this.working = 0;
    this.seenMints = new Map();
    this.profileCache = new Map();
    this.profilePending = new Map();
    this.apiCallTimes = [];
    this.alerts = [];
    this.status = 'NOT_STARTED';
    this.startedAtMs = Date.now();
    this.lastConnectedAtMs = null;
    this.metrics = {
      launches: 0, duplicateLaunches: 0, queueDropped: 0,
      metadataFailed: 0, xLinksFound: 0, noXLink: 0,
      xLookups: 0, xLookupSkippedBudget: 0, xLookupFailures: 0,
      profileCacheHits: 0, flags: 0, streamDisconnects: 0,
      persistenceErrors: 0
    };
  }
  async restore() {
    try {
      const info = await stat(this.dataFile);
      const f = await open(this.dataFile, 'r');
      try {
        const n = Math.min(info.size, 1024 * 1024);
        const buf = Buffer.alloc(n);
        await f.read(buf, 0, n, info.size - n);
        let source = buf.toString('utf8');
        if (info.size > n) source = source.slice(source.indexOf('\n') + 1);
        this.alerts = source.split('\n').filter(Boolean).flatMap(line => {
          try {
            const x = JSON.parse(line);
            return x && typeof x.mint === 'string' && Number.isSafeInteger(x.followers) ? [x] : [];
          } catch { return []; }
        }).slice(-150).reverse();
      } finally { await f.close(); }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.metrics.persistenceErrors++;
    }
  }
  publicStatus() {
    const now = Date.now();
    this.apiCallTimes = this.apiCallTimes.filter(t => now - t < 900000);
    return {
      status: this.status, startedAtMs: this.startedAtMs,
      lastConnectedAtMs: this.lastConnectedAtMs,
      followerThreshold: this.threshold, xLookupsPer15m: this.lookupsPer15m,
      xCallsInRolling15m: this.apiCallTimes.length,
      queueDepth: this.queue.length, activeTasks: this.working,
      // "connected" means only the transport/subscription, not a gapless feed.
      continuityGuaranteed: false, sourceScope: 'Pump mainnet CreateEvent only',
      metrics: { ...this.metrics }
    };
  }
  onStreamStatus(value) {
    this.status = value;
    if (value === 'CONNECTED') this.lastConnectedAtMs = Date.now();
    if (value === 'DISCONNECTED') this.metrics.streamDisconnects++;
  }
  async start(signal) {
    await runPumpStream({
      url: process.env.SOLANA_WS_URL || undefined,
      signal,
      onStatus: state => this.onStreamStatus(state),
      onLaunch: launch => this.ingest(launch)
    });
  }
  ingest(launch) {
    if (!launch || typeof launch.mint !== 'string') return;
    if (this.seenMints.has(launch.mint)) {
      this.metrics.duplicateLaunches++;
      return;
    }
    this.seenMints.set(launch.mint, Date.now());
    if (this.seenMints.size > 25000) this.seenMints.delete(this.seenMints.keys().next().value);
    this.metrics.launches++;
    if (this.queue.length >= 200) {
      this.metrics.queueDropped++;
      return;
    }
    this.queue.push(launch);
    this.drain();
  }
  drain() {
    while (this.working < 3 && this.queue.length) {
      const launch = this.queue.shift();
      this.working++;
      this.processLaunch(launch).catch(() => {
        this.metrics.metadataFailed++;
      }).finally(() => {
        this.working--;
        this.drain();
      });
    }
  }
  reserveXLookup(now) {
    this.apiCallTimes = this.apiCallTimes.filter(t => now - t < 900000);
    const minimumSpacing = Math.ceil(900000 / this.lookupsPer15m);
    if (this.apiCallTimes.length >= this.lookupsPer15m ||
        (this.apiCallTimes.length > 0 && now - this.apiCallTimes.at(-1) < minimumSpacing)) {
      return false;
    }
    this.apiCallTimes.push(now);
    this.metrics.xLookups++;
    return true;
  }
  async profileFor(handle) {
    const key = handle.toLowerCase();
    const now = Date.now();
    const cached = this.profileCache.get(key);
    if (cached && now - cached.collectedAtMs < this.cacheMs) {
      this.metrics.profileCacheHits++;
      return { ...cached, cached: true };
    }
    if (this.profilePending.has(key)) {
      const result = await this.profilePending.get(key);
      return { ...result, cached: true };
    }
    if (!this.reserveXLookup(now)) {
      this.metrics.xLookupSkippedBudget++;
      return { status: 'SKIPPED_BUDGET' };
    }
    const job = this.profileFetcher(handle, this.token);
    this.profilePending.set(key, job);
    try {
      const result = await job;
      if (result.status === 'OBSERVED') this.profileCache.set(key, result);
      else this.metrics.xLookupFailures++;
      return { ...result, cached: false };
    } finally {
      this.profilePending.delete(key);
    }
  }
  async processLaunch(launch) {
    let metadata;
    try {
      metadata = await this.metadataFetcher(launch.uri, {
        extraHosts: process.env.RADAR_METADATA_HOSTS || ''
      });
    } catch {
      this.metrics.metadataFailed++;
      return;
    }
    const handle = extractXHandle(metadata);
    if (!handle) {
      this.metrics.noXLink++;
      return;
    }
    this.metrics.xLinksFound++;
    const profile = await this.profileFor(handle);
    if (profile.status !== 'OBSERVED') return;
    if (profile.followers < this.threshold) return;
    const record = {
      mint: launch.mint,
      name: launch.name,
      symbol: launch.symbol,
      signature: launch.signature || null,
      firstObservedAtMs: launch.firstObservedAtMs || Date.now(),
      flaggedAtMs: Date.now(),
      handle: profile.username,
      followers: profile.followers,
      followerObservedAtMs: profile.collectedAtMs,
      profileReused: profile.cached,
      linkSource: 'TOKEN_METADATA_CLAIM',
      accountOwnershipVerified: false,
      addressEvidence: bioMintStatus(profile.description, launch.mint),
      demo: false
    };
    await this.saveAlert(record);
  }
  async saveAlert(record) {
    this.alerts.unshift(record);
    this.alerts = this.alerts.slice(0, 150);
    this.metrics.flags++;
    try {
      await mkdir(path.dirname(this.dataFile), { recursive: true });
      await appendFile(this.dataFile, JSON.stringify(record) + '\n', { mode: 0o600 });
    } catch {
      this.metrics.persistenceErrors++;
    }
    console.log('FLAG', record.symbol, record.handle, record.followers,
      'mint=' + record.mint, 'address=' + record.addressEvidence);
  }
  demoAlert() {
    this.alerts.unshift({
      mint: 'DemoOnlyNotARealMint', name: 'Example Launch', symbol: 'DEMO',
      signature: null, firstObservedAtMs: Date.now() - 25000,
      flaggedAtMs: Date.now(), handle: 'example',
      followers: 87400, followerObservedAtMs: Date.now(),
      profileReused: false, linkSource: 'SYNTHETIC_DEMO',
      accountOwnershipVerified: false, addressEvidence: 'UNAVAILABLE',
      demo: true
    });
    this.metrics.launches = 1;
    this.metrics.xLinksFound = 1;
    this.metrics.flags = 1;
    this.status = 'DEMO_ONLY_NO_LIVE_SOURCE';
  }
}
