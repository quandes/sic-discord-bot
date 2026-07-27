import type { Settings } from './config.js';
import { openClawSendMessage } from './openclaw.js';
import type { TicketProposal } from './types.js';
import type { RecentMeetingSummary } from './workspaceExport.js';

/** Hard cap so the rolling summary can never grow the context unbounded. */
const MAX_SUMMARY_CHARS = 4000;

export interface SegmentReviewInput {
  meetingId: string;
  /** Transcript of the newest segment only, not the whole meeting. */
  segmentTranscript: string;
  /** Rolling summary of everything discussed in earlier segments, if any. */
  previousSummary: string | null;
  /** Titles of tickets already proposed in earlier segments (duplicate guard). */
  proposedTitles: string[];
  /** General project background from the workspace (projekt-kontext.md), if any. */
  projectContext: string | null;
  /** Summaries of recent earlier meetings for cross-meeting continuity. */
  recentMeetings: RecentMeetingSummary[];
}

export interface SegmentReviewResult {
  proposals: TicketProposal[];
  /** Updated rolling summary to feed into the next segment review. */
  summary: string;
}

function buildOpenClawPrompt(input: SegmentReviewInput): string {
  const previousSummarySection = input.previousSummary
    ? `Rolling summary of the meeting so far (earlier segments):\n---\n${input.previousSummary}\n---\n\n`
    : 'This is the first segment of the meeting; there is no earlier summary.\n\n';

  const proposedSection = input.proposedTitles.length
    ? 'Tickets already proposed in earlier segments (do NOT duplicate these):\n' +
      input.proposedTitles.map((t) => `- ${t}`).join('\n') +
      '\n\n'
    : '';

  const projectContextSection = input.projectContext
    ? `General project background (for context only, do not turn this into tickets by itself):\n---\n${input.projectContext}\n---\n\n`
    : '';

  const recentMeetingsSection = input.recentMeetings.length
    ? 'Summaries of recent earlier meetings, for cross-meeting continuity (do not propose tickets purely restating these):\n' +
      input.recentMeetings
        .map((m) => `### ${m.date} (${m.meetingId})\n${m.summary}`)
        .join('\n\n') +
      '\n\n'
    : '';

  return (
    'You extract actionable SIC work packages from meeting transcripts.\n\n' +
    'The meeting is reviewed incrementally: you receive ONLY the transcript of the latest segment, ' +
    'plus a rolling summary of what was discussed before and the list of tickets already proposed in earlier segments.\n\n' +
    'Propose reviewable Multica tickets for the meaningful topics in the NEW segment that need follow-up. ' +
    'Create roughly one substantial ticket per coherent topic or workstream. Prefer fewer, larger, well-scoped tickets over many tiny tickets. ' +
    'Do not split small substeps into separate tickets when they belong to the same outcome. ' +
    'Only create separate tickets when topics have clearly different owners, outcomes, or implementation tracks. ' +
    'Do not propose a ticket that duplicates or merely rephrases an already proposed ticket from the list below; ' +
    'if the new segment only continues an already-covered topic without a genuinely new outcome, propose nothing for it. ' +
    'It is perfectly fine to propose zero tickets when the segment contains nothing actionable.\n\n' +
    'Each ticket should be detailed and directly usable by a build agent. Use German if the transcript is German. ' +
    'Use Markdown freely in the description. You may use sections such as Kontext, Aufgabenstellung, Akzeptanzkriterien, Abgrenzung, Hinweise, Definition of Done, or Merge notes when useful, but do not force sections that do not fit. ' +
    'Write acceptance criteria as concrete bullet points when they make sense. Include privacy, review, safety, source-of-truth, and integration constraints when relevant. ' +
    'Preserve important links to existing work packages, tickets, documents, GitHub/Discord/Multica flows, and dependencies mentioned in the transcript. ' +
    'If several older ideas or tickets are merged into one topic, explain the merge in the description instead of creating separate duplicate tickets. ' +
    'Ignore ASR artifacts, repeated filler phrases, greetings, thanks, and vague discussion without an actionable follow-up.\n\n' +
    'Additionally, maintain the rolling meeting summary: rewrite it so it stays useful as context for reviewing the NEXT segment. ' +
    'Carry forward still-relevant topics, decisions, open questions, and owners from the previous summary and work in what the new segment added. ' +
    'Keep the summary under 300 words. Write it in the language of the transcript.\n\n' +
    'Reply ONLY with the following blocks and nothing else:\n' +
    '- Zero or more ticket blocks in exactly this wrapper format:\n\n' +
    '===TICKET===\n' +
    'Title: concise title, <= 120 characters\n' +
    'Source: short verbatim quote from the transcript, or empty\n' +
    'Description:\n' +
    'Markdown ticket description here\n' +
    '===END===\n\n' +
    '- Exactly one summary block after the tickets:\n\n' +
    '===SUMMARY===\n' +
    'updated rolling meeting summary here\n' +
    '===END_SUMMARY===\n\n' +
    `Meeting ID (for context only, do not invent a different id): ${input.meetingId}\n\n` +
    projectContextSection +
    recentMeetingsSection +
    previousSummarySection +
    proposedSection +
    'Transcript of the new segment:\n---\n' +
    `${input.segmentTranscript}\n---`
  );
}

function parseTicketBlocks(responseText: string, meetingId: string): TicketProposal[] {
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

  return proposals;
}

function parseSummaryBlock(responseText: string): string | null {
  const match = responseText.match(/===SUMMARY===\s*([\s\S]*?)\s*===END_SUMMARY===/i);
  const summary = match?.[1]?.trim();
  return summary ? summary.slice(0, MAX_SUMMARY_CHARS) : null;
}

async function openClawSegmentReview(settings: Settings, input: SegmentReviewInput): Promise<SegmentReviewResult> {
  const responseText = await openClawSendMessage(settings, buildOpenClawPrompt(input));
  const proposals = parseTicketBlocks(responseText, input.meetingId);
  const summary = parseSummaryBlock(responseText);

  if (!proposals.length && summary === null) {
    throw new Error(`No ticket or summary blocks found in OpenClaw response: ${responseText.slice(0, 500)}`);
  }
  if (summary === null) {
    console.warn(`OpenClaw response missing summary block for meeting=${input.meetingId}; keeping previous summary`);
  }

  return {
    proposals,
    summary: summary ?? input.previousSummary ?? '',
  };
}

export async function buildSegmentProposals(
  settings: Settings,
  input: SegmentReviewInput,
): Promise<SegmentReviewResult> {
  const useOpenClaw =
    settings.ticketProposalBackend === 'openclaw' ||
    (settings.ticketProposalBackend === 'auto' && settings.openclawBaseUrl && settings.openclawApiToken);

  if (!useOpenClaw) {
    console.log('OpenClaw not configured. Skipping ticket proposal generation.');
    return { proposals: [], summary: input.previousSummary ?? '' };
  }

  return await openClawSegmentReview(settings, input);
}
