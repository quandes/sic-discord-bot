import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Interaction,
  type GuildTextBasedChannel,
} from 'discord.js';

import type { Settings } from './config.js';
import { memberHasAnyRole } from './discordAuth.js';
import { createMulticaTicket } from './multica.js';
import type { TicketProposal } from './types.js';
import { exportTicketDecision } from './workspaceExport.js';

const pendingProposals = new Map<string, TicketProposal>();

function proposalKey(meetingId: string, index: number): string {
  return `${meetingId}:${index}`;
}

function buildReviewEmbed(proposal: TicketProposal): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('SIC Ticket Proposal')
    .setDescription(proposal.description.slice(0, 4000))
    .setColor(0xe67e22);
  embed.addFields(
    { name: 'Meeting ID', value: proposal.meetingId },
    { name: 'Suggested Title', value: proposal.title.slice(0, 256) },
  );
  if (proposal.sourceExcerpt) {
    embed.addFields({ name: 'Source Excerpt', value: proposal.sourceExcerpt.slice(0, 1024) });
  }
  embed.setFooter({ text: 'Review and approve to create in Multica' });
  return embed;
}

function buildReviewRow(key: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sic:approve:${key}`)
      .setLabel('Approve & Create in Multica')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sic:reject:${key}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );
}

/**
 * Post ready-made proposals with approve/reject buttons.
 * `keyOffset` must be the number of proposals already posted for this meeting,
 * so button keys from different segments never collide.
 */
export async function postProposals(
  meetingId: string,
  proposals: TicketProposal[],
  keyOffset: number,
  textChannel: GuildTextBasedChannel,
): Promise<void> {
  proposals.forEach((proposal, index) => {
    pendingProposals.set(proposalKey(meetingId, keyOffset + index), proposal);
  });

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i]!;
    const key = proposalKey(meetingId, keyOffset + i);
    await textChannel.send({
      content: 'New reviewable ticket proposal:',
      embeds: [buildReviewEmbed(proposal)],
      components: [buildReviewRow(key)],
    });
  }
}

export async function handleReviewButton(
  interaction: Interaction,
  settings: Settings,
): Promise<void> {
  if (!interaction.isButton() || !interaction.customId.startsWith('sic:')) return;

  if (!memberHasAnyRole(interaction.member, settings.discordReviewerRoleIds)) {
    await interaction.reply({
      content: '❌ Keine Berechtigung für Ticket-Review.',
      ephemeral: true,
    });
    return;
  }

  const parts = interaction.customId.split(':');
  if (parts.length < 3) return;

  const [, action, ...keyParts] = parts;
  const key = keyParts.join(':');
  const proposal = pendingProposals.get(key);
  if (!proposal) {
    await interaction.reply({ content: 'Dieser Vorschlag ist abgelaufen.', ephemeral: true });
    return;
  }

  if (action === 'reject') {
    pendingProposals.delete(key);
    await interaction.update({
      content: 'Proposal rejected by reviewer.',
      components: [],
    });
    await exportTicketDecision(settings, proposal, 'rejected');
    return;
  }

  if (action === 'approve') {
    await interaction.deferUpdate();
    try {
      const ticket = await createMulticaTicket(settings, proposal);
      pendingProposals.delete(key);
      let message = `Approved. Multica ticket \`${ticket.id}\` created.`;
      if (ticket.url) message += ` [Open Ticket](${ticket.url})`;
      await interaction.message?.edit({ content: message, components: [] });
      await exportTicketDecision(settings, proposal, 'approved', ticket);
    } catch (err) {
      console.error('Multica ticket creation failed:', err);
      await interaction.followUp({
        content: '❌ Ticket konnte nicht in Multica angelegt werden. Details in den Bot-Logs.',
        ephemeral: true,
      });
    }
  }
}
