# sic-discord-bot

Discord bot: voice meeting → Whisper transcript → OpenClaw ticket proposals → Multica (after approval).

## Setup

```bash
cp .env.example .env
cd bot && npm install
```

Required: `DISCORD_BOT_TOKEN`, `DISCORD_REVIEW_CHANNEL_ID`, `WHISPER_ASR_URL`, `MULTICA_*`, OpenClaw when using proposals.

Recommended: `DISCORD_GUILD_ID`, `DISCORD_ALLOWED_ROLE_IDS`, `DISCORD_REVIEWER_ROLE_IDS` (comma-separated Discord role IDs).

## Run

```bash
cd bot && npm start
```

Commands: `/meeting_start`, `/meeting_review`, `/meeting_reset`. Transcripts and proposals are posted only in `DISCORD_REVIEW_CHANNEL_ID`.

No inbound HTTP port.

## Deploy (Docker)

Copy `bot/` to the server (e.g. `/docker/sic-bot`), add `.env`, then:

```bash
docker compose up -d --build
```

With OpenClaw on the same host:

```env
OPENCLAW_BASE_URL=http://openclaw:18790
OPENCLAW_DOCKER_NETWORK=openclaw-gfg2_default
OPENCLAW_DOCKER_NETWORK_EXTERNAL=true
```
