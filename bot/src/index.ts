import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type VoiceBasedChannel,
} from 'discord.js';
import fsp from 'node:fs/promises';

import { loadSettings } from './config.js';
import { memberHasAnyRole } from './discordAuth.js';
import { buildSegmentProposals } from './proposals.js';
import {
  discardRecording,
  getRecording,
  hasRecording,
  makeMeetingId,
  onMemberJoinsVoice,
  rotateSegment,
  startRecording,
  stopRecording,
  type SegmentTrackFile,
  type TrackStopInfo,
} from './recording.js';
import { handleReviewButton, postProposals } from './review.js';
import { transcribeWavFile } from './whisper.js';
import {
  exportProposals,
  exportSegmentTranscript,
  exportSummary,
  readProjectContext,
  readRecentMeetingSummaries,
} from './workspaceExport.js';

const settings = loadSettings();

/** Grace period before an empty voice channel auto-stops the meeting. */
const AUTO_STOP_GRACE_MS = Number(process.env.AUTO_STOP_GRACE_SECONDS || '60') * 1000;

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

/**
 * Rolling review context per guild (one meeting per guild at a time).
 * Keeps OpenClaw context bounded: each segment review gets only the rolling
 * summary + already-proposed ticket titles, never the full meeting transcript.
 */
interface MeetingReviewContext {
  meetingId: string;
  summary: string | null;
  proposedTitles: string[];
  postedProposals: number;
}

const meetingContexts = new Map<string, MeetingReviewContext>();

/** Serializes review/stop pipelines per guild so segments never interleave. */
const guildOps = new Map<string, Promise<void>>();

function enqueueGuildOp(guildId: string, op: () => Promise<void>): Promise<void> {
  const prev = guildOps.get(guildId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  guildOps.set(guildId, next.catch(() => undefined));
  return next;
}

const emptyChannelTimers = new Map<string, NodeJS.Timeout>();

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`SIC Bot connected as ${readyClient.user.tag}`);
  if (settings.openclawWorkspaceDir) {
    console.log(`OpenClaw workspace export enabled: ${settings.openclawWorkspaceDir}/meetings`);
  }
  await registerCommands(readyClient.application.id);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    await handleReviewButton(interaction, settings);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (!memberHasAnyRole(interaction.member, settings.discordAllowedRoleIds)) {
    await interaction.reply({
      content: '❌ Keine Berechtigung für Meeting-Commands.',
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === 'meeting_start') {
    await handleMeetingStart(interaction);
  } else if (interaction.commandName === 'meeting_review') {
    await handleMeetingReview(interaction);
  } else if (interaction.commandName === 'meeting_stop') {
    await handleMeetingStop(interaction);
  } else if (interaction.commandName === 'meeting_reset') {
    await handleMeetingReset(interaction);
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.channelId && newState.channelId !== oldState.channelId && newState.member) {
    onMemberJoinsVoice(newState.member, newState.channelId);
  }
  updateEmptyChannelWatch(newState.guild.id);
});

client.login(settings.discordBotToken);

async function fetchReviewChannel(): Promise<GuildTextBasedChannel> {
  if (!settings.discordReviewChannelId) {
    throw new Error('No fallback review channel configured (DISCORD_REVIEW_CHANNEL_ID is missing in .env)');
  }
  const channel = await client.channels.fetch(settings.discordReviewChannelId);
  if (!channel?.isTextBased() || channel.isDMBased()) {
    throw new Error(`DISCORD_REVIEW_CHANNEL_ID ${settings.discordReviewChannelId} is not a guild text channel`);
  }
  return channel as GuildTextBasedChannel;
}

async function handleMeetingStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  const member = interaction.member;
  const voiceChannel = member && 'voice' in member ? member.voice?.channel : null;

  if (!guild || !voiceChannel) {
    await interaction.reply({
      content: '❌ Du musst in einem Voice Channel sein.',
      ephemeral: true,
    });
    return;
  }

  if (hasRecording(guild.id)) {
    const current = getRecording(guild.id)!;
    await interaction.reply({
      content:
        `⚠️ Der Bot nimmt gerade in <#${current.voiceChannelId}> auf (\`${current.meetingId}\`). ` +
        'Pro Server ist nur ein Meeting gleichzeitig möglich. ' +
        'Beende es mit `/meeting_stop` oder verwirf es mit `/meeting_reset`.',
      ephemeral: true,
    });
    return;
  }

  const meetingId = makeMeetingId(voiceChannel.name);
  await interaction.reply({
    content: `⏳ Starte Aufnahme in **${voiceChannel.name}** (\`${meetingId}\`)…`,
    ephemeral: true,
  });

  try {
    await startRecording(guild, voiceChannel, interaction.channelId, meetingId);
    meetingContexts.set(guild.id, {
      meetingId,
      summary: null,
      proposedTitles: [],
      postedProposals: 0,
    });
    await interaction.followUp({
      content:
        `🔴 Aufnahme läuft in **${voiceChannel.name}**.\n` +
        '**Bitte jetzt im Voice Channel sprechen** (mind. 3 Sekunden, nicht stummgeschaltet).\n' +
        `- \`/meeting_review\` → Zwischen-Review des bisherigen Abschnitts, **Aufnahme läuft weiter**\n` +
        `- \`/meeting_stop\` → Meeting beenden und finales Review\n` +
        `Verlassen alle den Channel, wird das Meeting nach ${Math.round(AUTO_STOP_GRACE_MS / 1000)}s automatisch beendet. ` +
        `Ergebnisse erscheinen in <#${interaction.channelId}>.`,
      ephemeral: true,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.followUp({
      content: `❌ Aufnahme konnte nicht gestartet werden: ${msg}`,
      ephemeral: true,
    });
    console.error('meeting_start failed:', err);
  }
}

async function handleMeetingReview(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild || !hasRecording(guild.id)) {
    await interaction.reply({
      content: 'ℹ️ Es läuft gerade keine Aufnahme. Starte mit `/meeting_start`.',
      ephemeral: true,
    });
    return;
  }

  const recording = getRecording(guild.id)!;
  await interaction.reply({
    content: `📋 Zwischen-Review für \`${recording.meetingId}\` — **Aufnahme läuft weiter**…`,
    ephemeral: true,
  });

  try {
    const reviewChannel =
      (interaction.channel as GuildTextBasedChannel | null) || (await fetchReviewChannel());

    let skipped = false;
    await enqueueGuildOp(guild.id, async () => {
      if (!hasRecording(guild.id)) {
        skipped = true;
        return;
      }
      const { meetingId, finishedSegment, trackFiles } = await rotateSegment(guild.id);
      await processSegment({
        guildId: guild.id,
        meetingId,
        finishedSegment,
        trackFiles,
        reviewChannel,
        isFinal: false,
      });
    });

    await safeFollowUp(
      interaction,
      skipped
        ? 'ℹ️ Das Meeting wurde zwischenzeitlich beendet.'
        : `✅ Zwischen-Review in <#${(interaction.channel as GuildTextBasedChannel | null)?.id ?? interaction.channelId}> gepostet. Aufnahme läuft weiter.`,
    );
  } catch (err) {
    console.error('meeting_review failed:', err);
    await safeFollowUp(interaction, '❌ Fehler beim Zwischen-Review. Details in den Bot-Logs. Die Aufnahme läuft weiter.');
  }
}

async function handleMeetingStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild || !hasRecording(guild.id)) {
    await interaction.reply({
      content: 'ℹ️ Es läuft gerade keine Aufnahme. Starte mit `/meeting_start`.',
      ephemeral: true,
    });
    return;
  }

  const recording = getRecording(guild.id)!;
  await interaction.reply({
    content: `⏹️ Beende Meeting \`${recording.meetingId}\` und erstelle finales Review…`,
    ephemeral: true,
  });

  try {
    const reviewChannel =
      (interaction.channel as GuildTextBasedChannel | null) || (await fetchReviewChannel());

    let skipped = false;
    await enqueueGuildOp(guild.id, async () => {
      if (!hasRecording(guild.id)) {
        skipped = true;
        return;
      }
      await finishMeeting(guild.id, reviewChannel);
    });

    await safeFollowUp(
      interaction,
      skipped
        ? 'ℹ️ Das Meeting wurde bereits beendet.'
        : `✅ Meeting beendet — Transkript und Vorschläge in <#${reviewChannel.id}> gepostet.`,
    );
  } catch (err) {
    console.error('meeting_stop failed:', err);
    await safeFollowUp(interaction, '❌ Fehler beim Beenden. Details in den Bot-Logs.');
  }
}

async function handleMeetingReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Nur auf einem Server verfügbar.', ephemeral: true });
    return;
  }

  clearEmptyChannelTimer(guild.id);
  meetingContexts.delete(guild.id);
  const meetingId = await discardRecording(guild.id);
  if (!meetingId) {
    await interaction.reply({ content: 'ℹ️ Es läuft gerade keine Aufnahme.', ephemeral: true });
    return;
  }

  await interaction.reply({
    content: `🗑️ Aufnahme für \`${meetingId}\` gestoppt und verworfen.`,
    ephemeral: true,
  });
}

/**
 * Stop the recording, review the final segment, post the meeting summary and
 * clean up all per-meeting state. Must run inside the guild op queue.
 */
async function finishMeeting(guildId: string, reviewChannel: GuildTextBasedChannel): Promise<void> {
  clearEmptyChannelTimer(guildId);
  const { meetingId, finishedSegment, trackFiles, trackDebug } = await stopRecording(guildId);

  await processSegment({
    guildId,
    meetingId,
    finishedSegment,
    trackFiles,
    reviewChannel,
    isFinal: true,
    trackDebug,
  });

  const context = meetingContexts.get(guildId);
  if (context?.meetingId === meetingId && context.summary?.trim()) {
    const header = `🧾 **Meeting-Zusammenfassung für \`${meetingId}\`:**`;
    const message = `${header}\n${context.summary.trim()}`;
    if (message.length <= 1900) {
      await reviewChannel.send(message);
    } else {
      await reviewChannel.send({
        content: header,
        files: [{
          attachment: Buffer.from(context.summary.trim(), 'utf8'),
          name: `zusammenfassung_${meetingId}.txt`,
        }],
      });
    }
  }
  meetingContexts.delete(guildId);
}

/**
 * Shared pipeline for interim and final reviews: transcribe the segment's
 * speaker tracks, post the transcript, then generate ticket proposals with
 * the rolling meeting context.
 */
async function processSegment(opts: {
  guildId: string;
  meetingId: string;
  finishedSegment: number;
  trackFiles: SegmentTrackFile[];
  reviewChannel: GuildTextBasedChannel;
  isFinal: boolean;
  trackDebug?: TrackStopInfo[];
}): Promise<void> {
  const { guildId, meetingId, finishedSegment, trackFiles, reviewChannel, isFinal } = opts;
  const isMultiSegment = finishedSegment > 0 || !isFinal;
  const partLabel = isMultiSegment ? ` (Teil ${finishedSegment + 1})` : '';

  const { transcript, parts, failures } = await transcribeTracks(trackFiles, reviewChannel);

  if (!transcript.trim()) {
    if (isFinal) {
      logTrackDebug(meetingId, opts.trackDebug ?? [], failures);
    }
    const detail = failures.length ? `\n${failures.map((f) => `- ${f}`).join('\n')}` : '';
    await reviewChannel.send(
      isFinal
        ? `⚠️ Für \`${meetingId}\`${partLabel} konnte kein Transkript erstellt werden.${detail}` +
            (detail
              ? ''
              : '\nZu wenig Audio empfangen (min. ~0,5 s pro Sprecher). Nach „Aufnahme läuft“ erneut sprechen; nicht stummgeschaltet; Bot nicht server-deafened?')
        : `ℹ️ \`${meetingId}\`${partLabel}: Kein verwertbares Audio seit dem letzten Review — die Aufnahme läuft weiter.${detail}`,
    );
    return;
  }

  await reviewChannel.send({
    content: `📝 **Transkript für \`${meetingId}\`${partLabel} (${parts.length} Sprecher-Spur(en)):**`,
    files: [{
      attachment: Buffer.from(transcript, 'utf8'),
      name: isMultiSegment
        ? `transkript_${meetingId}_teil${finishedSegment + 1}.txt`
        : `transkript_${meetingId}.txt`,
    }],
  });

  if (failures.length) {
    await reviewChannel.send(
      '⚠️ Einige Sprecher-Spuren konnten nicht transkribiert werden:\n' +
        failures.map((f) => `- ${f}`).join('\n'),
    );
  }

  await exportSegmentTranscript(settings, meetingId, finishedSegment + 1, transcript);

  const context = meetingContexts.get(guildId)?.meetingId === meetingId
    ? meetingContexts.get(guildId)!
    : { meetingId, summary: null, proposedTitles: [], postedProposals: 0 };
  meetingContexts.set(guildId, context);

  try {
    const [projectContext, recentMeetings] = await Promise.all([
      readProjectContext(settings),
      readRecentMeetingSummaries(settings, meetingId),
    ]);

    const result = await buildSegmentProposals(settings, {
      meetingId,
      segmentTranscript: transcript,
      previousSummary: context.summary,
      proposedTitles: context.proposedTitles,
      projectContext,
      recentMeetings,
    });

    if (result.summary.trim()) {
      context.summary = result.summary.trim();
      await exportSummary(settings, meetingId, context.summary);
    }

    if (result.proposals.length) {
      await postProposals(meetingId, result.proposals, context.postedProposals, reviewChannel);
      context.postedProposals += result.proposals.length;
      context.proposedTitles.push(...result.proposals.map((p) => p.title));
      await exportProposals(settings, meetingId, result.proposals);
    } else {
      await reviewChannel.send(
        isMultiSegment
          ? `ℹ️ **Keine neuen Aufgaben** in Teil ${finishedSegment + 1} gefunden.`
          : 'ℹ️ **Keine Aufgaben gefunden** im Transkript.',
      );
    }
  } catch (err) {
    console.error('OpenClaw proposals failed:', err);
    await reviewChannel.send('⚠️ **Fehler bei der Ticket-Generierung.** Details stehen in den Bot-Logs.');
  }
}

async function transcribeTracks(
  trackFiles: SegmentTrackFile[],
  reviewChannel: GuildTextBasedChannel,
): Promise<{ transcript: string; parts: string[]; failures: string[] }> {
  const parts: string[] = [];
  const failures: string[] = [];
  const failedTracksToUpload: { name: string; wavPath: string }[] = [];

  for (const { userId, wavPath } of trackFiles) {
    const user = await client.users.fetch(userId).catch(() => null);
    const name = user?.displayName || user?.username || `User ${userId}`;
    let success = false;
    try {
      const text = await transcribeWavFile(settings, wavPath);
      if (text.trim()) {
        parts.push(`**${name}**: ${text.trim()}`);
        success = true;
      } else {
        failures.push(`${name}: Whisper lieferte keinen Text`);
      }
    } catch (err) {
      failures.push(`${name}: Transkription fehlgeschlagen`);
      console.error(`Transcribe failed user=${userId}:`, err);
    }

    if (success) {
      await fsp.unlink(wavPath).catch(() => undefined);
    } else {
      failedTracksToUpload.push({ name, wavPath });
    }
  }

  for (const t of failedTracksToUpload) {
    try {
      const stats = await fsp.stat(t.wavPath).catch(() => null);
      if (stats && stats.size > 0) {
        const safeName = t.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_');
        await reviewChannel.send({
          content: `⚠️ **Transkriptions-Fehler für ${t.name}:** Die Tonspur konnte nicht transkribiert werden.`,
          files: [{
            attachment: t.wavPath,
            name: `${safeName}_audio.wav`,
          }],
        });
      }
    } catch (uploadErr) {
      console.error(`Failed to upload wav for ${t.name}:`, uploadErr);
    } finally {
      await fsp.unlink(t.wavPath).catch(() => undefined);
    }
  }

  return { transcript: parts.join('\n'), parts, failures };
}

/** Auto-stop: end the meeting when the last human leaves the recorded channel. */
function updateEmptyChannelWatch(guildId: string): void {
  const recording = getRecording(guildId);
  if (!recording) {
    clearEmptyChannelTimer(guildId);
    return;
  }

  const humans = countHumansInChannel(recording.voiceChannelId);
  if (humans === 0) {
    if (!emptyChannelTimers.has(guildId)) {
      console.log(
        `Voice channel empty for meeting=${recording.meetingId}; auto-stop in ${AUTO_STOP_GRACE_MS}ms`,
      );
      emptyChannelTimers.set(
        guildId,
        setTimeout(() => {
          emptyChannelTimers.delete(guildId);
          void autoStopMeeting(guildId);
        }, AUTO_STOP_GRACE_MS),
      );
    }
  } else {
    clearEmptyChannelTimer(guildId);
  }
}

function countHumansInChannel(voiceChannelId: string): number {
  const channel = client.channels.cache.get(voiceChannelId) as VoiceBasedChannel | undefined;
  if (!channel || !('members' in channel)) return 0;
  return channel.members.filter((m) => !m.user.bot).size;
}

function clearEmptyChannelTimer(guildId: string): void {
  const timer = emptyChannelTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    emptyChannelTimers.delete(guildId);
  }
}

async function autoStopMeeting(guildId: string): Promise<void> {
  const recording = getRecording(guildId);
  if (!recording) return;
  if (countHumansInChannel(recording.voiceChannelId) > 0) return;

  console.log(`Auto-stopping meeting=${recording.meetingId} (voice channel empty)`);
  const reviewChannel = await resolveMeetingTextChannel(recording.textChannelId);
  if (!reviewChannel) {
    console.error(
      `No text channel available to post results for meeting=${recording.meetingId}; discarding recording`,
    );
    meetingContexts.delete(guildId);
    await discardRecording(guildId);
    return;
  }

  await reviewChannel
    .send(`👋 Alle haben den Voice Channel verlassen — Meeting \`${recording.meetingId}\` wird automatisch beendet und reviewt.`)
    .catch((err) => console.error('Auto-stop notice failed:', err));

  try {
    await enqueueGuildOp(guildId, async () => {
      if (!hasRecording(guildId)) return;
      await finishMeeting(guildId, reviewChannel);
    });
  } catch (err) {
    console.error('Auto-stop failed:', err);
    await reviewChannel
      .send('❌ Fehler beim automatischen Beenden. Details in den Bot-Logs.')
      .catch(() => undefined);
  }
}

async function resolveMeetingTextChannel(textChannelId: string): Promise<GuildTextBasedChannel | null> {
  try {
    const channel = await client.channels.fetch(textChannelId);
    if (channel?.isTextBased() && !channel.isDMBased()) {
      return channel as GuildTextBasedChannel;
    }
  } catch (err) {
    console.warn(`Could not fetch meeting text channel ${textChannelId}:`, err);
  }
  try {
    return await fetchReviewChannel();
  } catch {
    return null;
  }
}

async function safeFollowUp(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  try {
    await interaction.followUp({ content, ephemeral: true });
  } catch (err) {
    console.warn('followUp failed (interaction token may have expired):', err);
  }
}

function logTrackDebug(meetingId: string, trackDebug: TrackStopInfo[], failures: string[]): void {
  console.warn(`No transcript for meeting=${meetingId}`, { failures, trackDebug });
}

async function registerCommands(applicationId: string): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName('meeting_start')
      .setDescription('Bot tritt deinem Voice Channel bei und nimmt auf (Craig-Style, pro Sprecher)'),
    new SlashCommandBuilder()
      .setName('meeting_review')
      .setDescription('Zwischen-Review: Abschnitt transkribieren & Tickets vorschlagen (Aufnahme läuft weiter)'),
    new SlashCommandBuilder()
      .setName('meeting_stop')
      .setDescription('Meeting beenden: letzten Abschnitt reviewen, dann verlässt der Bot den Channel'),
    new SlashCommandBuilder()
      .setName('meeting_reset')
      .setDescription('Aufnahme stoppen und verwerfen'),
  ].map((c) => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(settings.discordBotToken);
  if (settings.discordGuildId) {
    await rest.put(Routes.applicationGuildCommands(applicationId, settings.discordGuildId), { body: commands });
    console.log(`Slash commands registered for guild ${settings.discordGuildId}`);
  } else {
    await rest.put(Routes.applicationCommands(applicationId), { body: commands });
    console.log('Slash commands registered globally');
  }
}
