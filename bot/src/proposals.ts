import type { Settings } from './config.js';
import { openClawSendMessage } from './openclaw.js';
import type { TicketProposal } from './types.js';

function buildOpenClawPrompt(meetingId: string, transcript: string): string {
  return (
    'You extract actionable SIC work packages from meeting transcripts.\n\n' +
    'From the transcript below, propose reviewable Multica tickets for the meaningful topics that need follow-up. ' +
    'Create roughly one substantial ticket per coherent topic or workstream. Prefer fewer, larger, well-scoped tickets over many tiny tickets. ' +
    'Do not split small substeps into separate tickets when they belong to the same outcome. ' +
    'Only create separate tickets when topics have clearly different owners, outcomes, or implementation tracks.\n\n' +
    'Each ticket should be detailed and directly usable by a build agent. Use German if the transcript is German. ' +
    'Use Markdown freely in the description. You may use sections such as Kontext, Aufgabenstellung, Akzeptanzkriterien, Abgrenzung, Hinweise, Definition of Done, or Merge notes when useful, but do not force sections that do not fit. ' +
    'Write acceptance criteria as concrete bullet points when they make sense. Include privacy, review, safety, source-of-truth, and integration constraints when relevant. ' +
    'Preserve important links to existing work packages, tickets, documents, GitHub/Discord/Multica flows, and dependencies mentioned in the transcript. ' +
    'If several older ideas or tickets are merged into one topic, explain the merge in the description instead of creating separate duplicate tickets. ' +
    'Ignore ASR artifacts, repeated filler phrases, greetings, thanks, and vague discussion without an actionable follow-up.\n\n' +
    'Reply ONLY with one or more ticket blocks in exactly this wrapper format. Do not add text before, after, or between blocks except the block contents:\n\n' +
    '===TICKET===\n' +
    'Title: concise title, <= 120 characters\n' +
    'Source: short verbatim quote from the transcript, or empty\n' +
    'Description:\n' +
    'Markdown ticket description here\n' +
    '===END===\n\n' +
    `Meeting ID (for context only, do not invent a different id): ${meetingId}\n\n` +
    'Transcript:\n---\n' +
    `${transcript}\n---`
  );
}

async function openClawProposals(settings: Settings, meetingId: string, transcript: string): Promise<TicketProposal[]> {
  const responseText = await openClawSendMessage(settings, buildOpenClawPrompt(meetingId, transcript));
  const proposals: TicketProposal[] = [];
  const blocks = responseText.matchAll(/===TICKET===\s*([\s\S]*?)\s*===END===/gi);

  for (const block of blocks) {
    const body = block[1]?.trim() ?? '';
    const titleMatch = body.match(/^Title:\s*(.+)$/im);
    const sourceMatch = body.match(/^Source:\s*(.*)$/im);
    const descriptionMatch = body.match(/^Description:\s*([\s\S]*)$/im);
    const title = titleMatch?.[1]?.trim() ?? '';
    const description = descriptionMatch?.[1]?.trim() ?? '';
    if (!title || !description) continue;

    const sourceExcerpt = sourceMatch?.[1]?.trim() || null;

    proposals.push({
      meetingId,
      title: title.slice(0, 256),
      description: description.slice(0, 8000),
      sourceExcerpt,
    });
  }

  if (!proposals.length) {
    throw new Error(`No ticket blocks found in OpenClaw response: ${responseText.slice(0, 500)}`);
  }

  return proposals;
}

export async function buildProposals(
  settings: Settings,
  meetingId: string,
  transcript: string,
): Promise<TicketProposal[]> {
  const useOpenClaw =
    settings.ticketProposalBackend === 'openclaw' ||
    (settings.ticketProposalBackend === 'auto' && settings.openclawBaseUrl && settings.openclawApiToken);

  if (!useOpenClaw) {
    console.log('OpenClaw not configured. Skipping ticket proposal generation.');
    return [];
  }

  return await openClawProposals(settings, meetingId, transcript);
}
