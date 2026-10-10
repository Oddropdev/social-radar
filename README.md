# Social Radar V0

**Follower-only, read-only alerts for newly observed Solana Pump token launches.**

This is an independent, minimal implementation inspired by the Week 8 discovery workflow developed in the private Oddropdev/trading-bot project. Because this repository is currently PUBLIC, no private source files, market recordings, model policies, data, or secrets were copied verbatim.

## Features

1. Subscribe to the Solana Pump program's new CreateEvent logs through a WebSocket.
2. Retrieve token metadata from an allowlisted public HTTPS, IPFS, or Arweave gateway.
3. Recognize a directly declared X/Twitter profile in that metadata.
4. Fetch structured follower counts through X API v2 User Lookup.
5. Flag launches exceeding a configurable follower threshold.
6. As OPTIONAL context, check whether the exact mint string is present in the returned X profile biography.

**A social link in token metadata is a claim, not evidence that the account endorsed the token.** A mint in the biography is still not proof of ownership. No buyer-arrival, market or investment signals affect the flag.

Open the local-only dashboard at http://127.0.0.1:4174. Flag records are saved in the git-ignored local file data/alerts.jsonl. The tool **never trades**.

## Windows / PowerShell quick start

Requires Node.js 22.16 or newer plus an X API bearer token with the necessary paid/user lookup access.

    git clone https://github.com/Oddropdev/social-radar.git
    cd social-radar
    npm run check
    $env:X_API_BEARER_TOKEN = "YOUR_X_BEARER_TOKEN"
    npm start

Use http://127.0.0.1:4174 on the same machine.

To check the UI without any credentials or real token data:

    npm run demo

The demo is clearly labeled synthetic. No live network ingestion starts in demo mode.

Optional settings:

    $env:RADAR_FOLLOWER_THRESHOLD = "50000"
    $env:RADAR_X_LOOKUPS_PER_15M = "15"
    npm start

At the default 15 lookups per 15 minutes, the system spaces requests by 60 seconds. It will skip many candidate X lookups if there are frequent launches. It **counts these missed checks** rather than pretending to cover all launches. It reuses recent X readings for exactly matching linked accounts, labeled cached.

Metadata requests are limited to approved public gateways. A legitimate provider missing from the allowlist can be explicitly vetted and added locally:

    $env:RADAR_METADATA_HOSTS = "a-vetted-public-gateway.example"
    npm start

For a private, reliable Solana WebSocket endpoint:

    $env:SOLANA_WS_URL = "wss://YOUR_PROVIDER_ENDPOINT"
    npm start

Never commit or share your X token or RPC key. The dashboard binds to loopback only. The public mainnet default may disconnect or rate-limit. **Reconnections create unknown coverage gaps.** Source and profile collection reliability must still be demonstrated in a real local run.

## Technical scope

- Node.js 22 built-ins only; no npm runtime dependencies.
- A narrow CreateEvent Borsh reader that does not interpret trading-related event fields.
- Metadata host allowlist, strict redirect validation, bounded downloaded bytes and HTTPS-only requests.
- Strict structured X API profile identity match and exact integer followers.
- Bounded queue, lookup spacing, limited memory and append-only local alert log.
- Synthetic tests and GitHub Actions for Windows Node.js 22.

No whitepaper AI, trading engine, M4/M5/M6, W12 outcome study, Instagram, automated buys, website crawling, arbitrary social-account search, or promised full token coverage.

The first local real-world smoke should verify at least one genuine new Pump CreateEvent, metadata response, correctly resolved X account, structured follower reading and timely flag, together with accurate counters for skipped attempts.

## Next steps

1. Test real provider/API access and coverage on the user's Windows computer.
2. Tune the X query budget and metadata host allowlist based on actual observed misses.
3. Consider recent-post mint matching and additional social platforms.
4. Only later add optional technology/whitepaper intelligence.
