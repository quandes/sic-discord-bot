# sic-discord-bot

Discord bot: voice meeting → Whisper transcript → OpenClaw ticket proposals → Multica (after approval).

## Setup

```bash
cp .env.example .env
cd bot && npm install
```

Required: `DISCORD_BOT_TOKEN`, `DISCORD_REVIEW_CHANNEL_ID`, `WHISPER_ASR_URL`, `MULTICA_*`, OpenClaw when using proposals.

Recommended: `DISCORD_GUILD_ID`, `DISCORD_ALLOWED_ROLE_IDS`, `DISCORD_REVIEWER_ROLE_IDS` (comma-separated Discord role IDs).

### Whisper via the Paperspace gateway

`WHISPER_ASR_URL` can point either at a worker's direct hostname (e.g. `https://whisper-yir8caeb.quandes.com`,
no auth needed, but the hostname changes whenever the Paperspace worker restarts) or at the stable gateway
`https://paperspace.quandes.com`, which proxies to whichever worker is currently active and requires
`WHISPER_ASR_TOKEN` (a Paperspace PAT, sent as `Authorization: Bearer …`).

### Weekly whisper worker warmup (cron container)

`bot/cron/` is a small standalone Docker service (Alpine + `crond` + `curl`) that calls
`POST /worker/start?initialize_service=whisper` on a schedule — independent of the Discord bot process,
so it doesn't need the bot's Node runtime up just to fire one HTTP request a week.

- Schedule: `bot/cron/crontab` (default `10 18 * * 1` = every Monday 18:10, container timezone `Europe/Berlin`)
- Script: `bot/cron/warmup-whisper.sh` (reads `WHISPER_ASR_URL` / `WHISPER_ASR_TOKEN` from the mounted `.env`)
- Wired into `docker-compose.yml` as the `whisper-warmup` service; starts/stops alongside `sic-bot`.
- Logs land in the container at `/var/log/warmup.log` (`docker compose logs whisper-warmup` also shows crond output).
- To trigger it manually: `docker compose exec whisper-warmup /usr/local/bin/warmup-whisper.sh`.
- To change the schedule, edit `bot/cron/crontab` and `docker compose up -d --build whisper-warmup`.

## Run

```bash
cd bot && npm start
```

Commands:

- `/meeting_start` — bot joins your voice channel and records per speaker (one meeting per server at a time).
- `/meeting_review` — interim review: transcribes the segment since the last review, posts transcript + ticket proposals, **recording keeps running**. Can be used repeatedly during long meetings.
- `/meeting_stop` — final review of the last segment, posts a rolling meeting summary, bot leaves the channel.
- `/meeting_reset` — stop and discard the recording.

If everyone leaves the voice channel, the meeting auto-stops after a grace period (`AUTO_STOP_GRACE_SECONDS`, default 60s) and posts the final review automatically.

Across segments the bot keeps a rolling summary + the list of already proposed tickets as OpenClaw context, so later segments avoid duplicate proposals without ever resending the full transcript (bounded context).

Transcripts and proposals are posted in the channel where the command was run (fallback: `DISCORD_REVIEW_CHANNEL_ID`).

### OpenClaw workspace export (optional)

When `OPENCLAW_WORKSPACE_DIR` is set (and the OpenClaw workspace is mounted into the bot container, see the commented `volumes` block in `docker-compose.yml`), every meeting is additionally exported as files the OpenClaw agent can browse agentically:

```
<workspace>/meetings/<YYYY-MM-DD>/<meeting-id>/
  transkript.md       # full transcript, one section per review segment
  zusammenfassung.md  # latest rolling meeting summary
  tickets.md          # proposed tickets + reviewer decisions (Multica id/url)
```

A `meetings/README.md` describing the layout is created automatically. For reliable pickup, add one line to the workspace `AGENTS.md`, e.g.: `Meeting-Transkripte und -Zusammenfassungen liegen in meetings/<datum>/<meeting-id>/ (siehe meetings/README.md).`

Export failures only log a warning — they never break the recording/review flow.

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
