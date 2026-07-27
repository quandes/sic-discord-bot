import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseRoleIds } from './discordAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type TicketProposalBackend = 'auto' | 'openclaw';

export interface Settings {
  discordBotToken: string;
  discordGuildId: string | null;
  discordReviewChannelId: string | null;
  discordAllowedRoleIds: string[];
  discordReviewerRoleIds: string[];
  whisperAsrUrl: string;
  whisperAsrLanguage: string;
  whisperAsrTimeoutSeconds: number;
  whisperAsrToken: string | null;
  multicaBaseUrl: string;
  multicaApiToken: string;
  multicaWorkspaceId: string;
  multicaTimeoutSeconds: number;
  ticketProposalBackend: TicketProposalBackend;
  openclawBaseUrl: string | null;
  openclawApiToken: string | null;
  openclawTimeoutSeconds: number;
  openclawModel: string;
  /** Mounted OpenClaw workspace dir; meeting artifacts are exported there when set. */
  openclawWorkspaceDir: string | null;
  /** Project context file included in every ticket prompt (default: <workspace>/projekt-kontext.md). */
  projectContextFile: string | null;
}

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = value;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadSettings(): Settings {
  loadEnvFile(path.resolve(__dirname, '../../.env'));
  loadEnvFile(path.resolve(__dirname, '../.env'));

  const backend = (process.env.TICKET_PROPOSAL_BACKEND || 'auto').trim().toLowerCase() as TicketProposalBackend;
  if (!['auto', 'openclaw'].includes(backend)) {
    throw new Error('TICKET_PROPOSAL_BACKEND must be one of: auto, openclaw');
  }

  const openclawBase = (process.env.OPENCLAW_BASE_URL || '').trim() || null;
  const openclawToken = (process.env.OPENCLAW_API_TOKEN || '').trim() || null;
  if (backend === 'openclaw' && (!openclawBase || !openclawToken)) {
    throw new Error('TICKET_PROPOSAL_BACKEND=openclaw requires OPENCLAW_BASE_URL and OPENCLAW_API_TOKEN');
  }

  const discordAllowedRoleIds = parseRoleIds(process.env.DISCORD_ALLOWED_ROLE_IDS);
  const discordReviewerRoleIds = parseRoleIds(process.env.DISCORD_REVIEWER_ROLE_IDS);

  const whisperAsrToken = process.env.WHISPER_ASR_TOKEN?.trim() || null;

  return {
    discordBotToken: requireEnv('DISCORD_BOT_TOKEN'),
    discordGuildId: process.env.DISCORD_GUILD_ID?.trim() || null,
    discordReviewChannelId: process.env.DISCORD_REVIEW_CHANNEL_ID?.trim() || null,
    discordAllowedRoleIds,
    discordReviewerRoleIds,
    whisperAsrUrl: requireEnv('WHISPER_ASR_URL').replace(/\/$/, ''),
    whisperAsrLanguage: process.env.WHISPER_ASR_LANGUAGE || 'de',
    whisperAsrTimeoutSeconds: Number(process.env.WHISPER_ASR_TIMEOUT_SECONDS || '600'),
    whisperAsrToken,
    multicaBaseUrl: requireEnv('MULTICA_BASE_URL').replace(/\/$/, ''),
    multicaApiToken: requireEnv('MULTICA_API_TOKEN'),
    multicaWorkspaceId: requireEnv('MULTICA_WORKSPACE_ID'),
    multicaTimeoutSeconds: Number(process.env.MULTICA_TIMEOUT_SECONDS || '20'),
    ticketProposalBackend: backend,
    openclawBaseUrl: openclawBase,
    openclawApiToken: openclawToken,
    openclawTimeoutSeconds: Number(process.env.OPENCLAW_TIMEOUT_SECONDS || '120'),
    openclawModel: (process.env.OPENCLAW_MODEL || 'openclaw/default').trim() || 'openclaw/default',
    openclawWorkspaceDir: process.env.OPENCLAW_WORKSPACE_DIR?.trim().replace(/\/$/, '') || null,
    projectContextFile: process.env.PROJECT_CONTEXT_FILE?.trim() || null,
  };
}
