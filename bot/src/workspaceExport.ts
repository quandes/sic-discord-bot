/**
 * Optional export of meeting artifacts into the OpenClaw workspace, so the
 * OpenClaw agent can browse them agentically when meetings come up in chat.
 *
 * Layout: <workspace>/meetings/<YYYY-MM-DD>/<meeting-id>/
 *   transkript.md      — full transcript, one section per review segment
 *   zusammenfassung.md — latest rolling meeting summary (overwritten)
 *   tickets.md         — proposed tickets + reviewer decisions (appended)
 *
 * Every function is failure-tolerant: export problems are logged and must
 * never break the recording/review flow.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { Settings } from './config.js';
import type { MulticaTicket, TicketProposal } from './types.js';

/** Caps keep the ticket prompt bounded no matter how large workspace files grow. */
const MAX_PROJECT_CONTEXT_CHARS = 12_000;
const MAX_RECENT_SUMMARIES = 3;
const MAX_SUMMARY_EXCERPT_CHARS = 1_500;

const MEETINGS_README =
  '# Meeting-Transkripte\n\n' +
  'Dieses Verzeichnis wird automatisch vom SIC Discord-Bot befüllt.\n\n' +
  'Struktur: `meetings/<YYYY-MM-DD>/<meeting-id>/`\n\n' +
  '- `transkript.md` — vollständiges Transkript, ein Abschnitt pro Zwischen-Review\n' +
  '- `zusammenfassung.md` — aktuelle Zusammenfassung des Meetings\n' +
  '- `tickets.md` — vorgeschlagene Multica-Tickets inkl. Review-Entscheidungen\n';

function localDateStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localTimeStamp(date = new Date()): string {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
}

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fsp.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the meeting's folder (meetings spanning midnight keep their start
 * date), or create it under today's date.
 */
async function resolveMeetingDir(settings: Settings, meetingId: string): Promise<string | null> {
  const root = settings.openclawWorkspaceDir;
  if (!root) return null;

  try {
    const base = path.join(root, 'meetings');
    const entries = await fsp.readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(base, entry.name, meetingId);
      if (await isDirectory(candidate)) return candidate;
    }

    const dir = path.join(base, localDateStamp(), meetingId);
    await fsp.mkdir(dir, { recursive: true });

    const readmePath = path.join(base, 'README.md');
    if (!(await fileExists(readmePath))) {
      await fsp.writeFile(readmePath, MEETINGS_README, 'utf8');
    }
    return dir;
  } catch (err) {
    console.warn(`OpenClaw workspace export unavailable (meeting=${meetingId}):`, err);
    return null;
  }
}

export async function exportSegmentTranscript(
  settings: Settings,
  meetingId: string,
  segmentNumber: number,
  transcript: string,
): Promise<void> {
  const dir = await resolveMeetingDir(settings, meetingId);
  if (!dir) return;

  try {
    const filePath = path.join(dir, 'transkript.md');
    const header = (await fileExists(filePath)) ? '' : `# Transkript \`${meetingId}\`\n`;
    const section =
      `${header}\n## Teil ${segmentNumber} — ${localDateStamp()} ${localTimeStamp()}\n\n` +
      `${transcript.trim()}\n`;
    await fsp.appendFile(filePath, section, 'utf8');
  } catch (err) {
    console.warn(`Workspace transcript export failed (meeting=${meetingId}):`, err);
  }
}

export async function exportSummary(
  settings: Settings,
  meetingId: string,
  summary: string,
): Promise<void> {
  if (!summary.trim()) return;
  const dir = await resolveMeetingDir(settings, meetingId);
  if (!dir) return;

  try {
    const content =
      `# Zusammenfassung \`${meetingId}\`\n\n` +
      `Stand: ${localDateStamp()} ${localTimeStamp()}\n\n` +
      `${summary.trim()}\n`;
    await fsp.writeFile(path.join(dir, 'zusammenfassung.md'), content, 'utf8');
  } catch (err) {
    console.warn(`Workspace summary export failed (meeting=${meetingId}):`, err);
  }
}

export async function exportProposals(
  settings: Settings,
  meetingId: string,
  proposals: TicketProposal[],
): Promise<void> {
  if (!proposals.length) return;
  const dir = await resolveMeetingDir(settings, meetingId);
  if (!dir) return;

  try {
    const filePath = path.join(dir, 'tickets.md');
    const header = (await fileExists(filePath)) ? '' : `# Ticket-Vorschläge \`${meetingId}\`\n`;
    const sections = proposals
      .map((p) => {
        const source = p.sourceExcerpt ? `\n> Quelle: ${p.sourceExcerpt}\n` : '';
        return `\n## ${p.title}\n${source}\n${p.description.trim()}\n`;
      })
      .join('');
    await fsp.appendFile(filePath, header + sections, 'utf8');
  } catch (err) {
    console.warn(`Workspace proposals export failed (meeting=${meetingId}):`, err);
  }
}

/**
 * General project context for the ticket prompt, maintained in the workspace
 * (by the team or the OpenClaw agent itself). Missing file is not an error.
 */
export async function readProjectContext(settings: Settings): Promise<string | null> {
  const filePath =
    settings.projectContextFile ??
    (settings.openclawWorkspaceDir ? path.join(settings.openclawWorkspaceDir, 'projekt-kontext.md') : null);
  if (!filePath) return null;

  try {
    const text = (await fsp.readFile(filePath, 'utf8')).trim();
    return text ? text.slice(0, MAX_PROJECT_CONTEXT_CHARS) : null;
  } catch {
    return null;
  }
}

export interface RecentMeetingSummary {
  meetingId: string;
  date: string;
  summary: string;
}

/**
 * Summaries of the most recent earlier meetings, newest first, for
 * cross-meeting continuity in the ticket prompt.
 */
export async function readRecentMeetingSummaries(
  settings: Settings,
  excludeMeetingId: string,
  limit = MAX_RECENT_SUMMARIES,
): Promise<RecentMeetingSummary[]> {
  const root = settings.openclawWorkspaceDir;
  if (!root) return [];

  try {
    const base = path.join(root, 'meetings');
    const dateDirs = (await fsp.readdir(base, { withFileTypes: true }).catch(() => []))
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();

    const results: RecentMeetingSummary[] = [];
    for (const date of dateDirs) {
      if (results.length >= limit) break;
      const dayDir = path.join(base, date);
      const meetingDirs = (await fsp.readdir(dayDir, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && e.name !== excludeMeetingId)
        .map((e) => e.name)
        .sort()
        .reverse();

      for (const meetingId of meetingDirs) {
        if (results.length >= limit) break;
        try {
          const raw = await fsp.readFile(path.join(dayDir, meetingId, 'zusammenfassung.md'), 'utf8');
          const body = raw
            .replace(/^# .*\n+/, '')
            .replace(/^Stand: .*\n+/, '')
            .trim();
          if (body) {
            results.push({ meetingId, date, summary: body.slice(0, MAX_SUMMARY_EXCERPT_CHARS) });
          }
        } catch {
          // meeting without summary (e.g. discarded) — skip
        }
      }
    }
    return results;
  } catch (err) {
    console.warn('Reading recent meeting summaries failed:', err);
    return [];
  }
}

export async function exportTicketDecision(
  settings: Settings,
  proposal: TicketProposal,
  decision: 'approved' | 'rejected',
  ticket?: MulticaTicket,
): Promise<void> {
  const dir = await resolveMeetingDir(settings, proposal.meetingId);
  if (!dir) return;

  try {
    const line =
      decision === 'approved'
        ? `\n> ✅ **${proposal.title}** wurde als Multica-Ticket \`${ticket?.id ?? '?'}\` angelegt` +
          (ticket?.url ? ` (${ticket.url})` : '') +
          ` — ${localDateStamp()} ${localTimeStamp()}\n`
        : `\n> ❌ **${proposal.title}** wurde im Review abgelehnt — ${localDateStamp()} ${localTimeStamp()}\n`;
    await fsp.appendFile(path.join(dir, 'tickets.md'), line, 'utf8');
  } catch (err) {
    console.warn(`Workspace decision export failed (meeting=${proposal.meetingId}):`, err);
  }
}
