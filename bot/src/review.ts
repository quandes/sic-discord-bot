import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type Interaction,
  type TextChannel,
  type TextBasedChannel,
} from 'discord.js';

import type { Settings } from './config.js';
import { memberHasAnyRole } from './discordAuth.js';
import { createMulticaTicket } from './multica.js';
import { buildProposals } from './proposals.js';
import type { TicketProposal } from './types.js';

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

async function getReviewChannel(client: Client, settings: Settings): Promise<TextBasedChannel> {
  const channel = await client.channels.fetch(settings.discordReviewChannelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new Error(`DISCORD_REVIEW_CHANNEL_ID ${settings.discordReviewChannelId} is not a guild text channel`);
  }
  return channel as TextBasedChannel;
}

export async function postReviewProposals(
  client: Client,
  settings: Settings,
  meetingId: string,
  transcript: string,
  targetChannel?: TextBasedChannel,
): Promise<void> {
  const textChannel = targetChannel || (await getReviewChannel(client, settings));

  let proposals: TicketProposal[] = [];
  try {
    proposals = await buildProposals(settings, meetingId, transcript);
  } catch (err) {
    console.error('OpenClaw proposals failed:', err);
    await textChannel.send(
      '⚠️ **Fehler bei der Ticket-Generierung.** Details stehen in den Bot-Logs.',
    );
    return;
  }

  if (!proposals.length) {
    await textChannel.send('ℹ️ **Keine Aufgaben gefunden** im Transkript.');
    return;
  }

  proposals.forEach((proposal, index) => {
    const key = proposalKey(meetingId, index);
    pendingProposals.set(key, proposal);
  });

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i]!;
    const key = proposalKey(meetingId, i);
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
    } catch (err) {
      console.error('Multica ticket creation failed:', err);
      await interaction.followUp({
        content: '❌ Ticket konnte nicht in Multica angelegt werden. Details in den Bot-Logs.',
        ephemeral: true,
      });
    }
  }
}
