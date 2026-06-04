import axios from 'axios';

import type { Settings } from './config.js';
import type { MulticaTicket, TicketProposal } from './types.js';

export async function createMulticaTicket(settings: Settings, proposal: TicketProposal): Promise<MulticaTicket> {
  const description = `${proposal.description}\n\n---\nSource: SIC Meeting-to-Ticket Bot\nMeeting ID: ${proposal.meetingId}\n`;

  let response;
  try {
    response = await axios.post(
      `${settings.multicaBaseUrl}/api/issues`,
      {
        title: proposal.title,
        description,
        status: 'backlog',
        priority: 'none',
      },
      {
        headers: {
          Authorization: `Bearer ${settings.multicaApiToken}`,
          'Content-Type': 'application/json',
          'X-Workspace-ID': settings.multicaWorkspaceId,
        },
        timeout: settings.multicaTimeoutSeconds * 1000,
      },
    );
  } catch (err) {
    if (axios.isAxiosError(err) && err.response) {
      const body = typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data);
      throw new Error(`Multica HTTP ${err.response.status}: ${body}`);
    }
    throw err;
  }

  const body = response.data;
  if (!body || typeof body !== 'object') {
    throw new Error(`Unexpected Multica response type: ${typeof body}`);
  }

  const record = body as Record<string, unknown>;
  const displayId =
    record.identifier ?? record.key ?? record.issue_key ?? record.number ?? record.id ?? record.uuid ?? record.issue_id ?? 'unknown';
  const ticketUrl = record.url ?? record.web_url ?? record.html_url;

  return {
    id: String(displayId),
    url: ticketUrl != null ? String(ticketUrl) : null,
  };
}
