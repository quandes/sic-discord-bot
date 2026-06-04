import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
} from 'discord.js';
import fsp from 'node:fs/promises';

import { loadSettings } from './config.js';
import { memberHasAnyRole } from './discordAuth.js';
import { postReviewProposals } from './review.js';
import {
  discardRecording,
  getRecording,
  hasRecording,
  makeMeetingId,
  onMemberJoinsVoice,
  startRecording,
  stopRecording,
  type TrackStopInfo,
} from './recording.js';
import { handleReviewButton } from './review.js';
import { transcribeWavFile } from './whisper.js';

const settings = loadSettings();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`SIC Bot connected as ${readyClient.user.tag}`);
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
  } else if (interaction.commandName === 'meeting_reset') {
    await handleMeetingReset(interaction);
  }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  if (newState.channelId && newState.channelId !== oldState.channelId && newState.member) {
    onMemberJoinsVoice(newState.member, newState.channelId);
  }
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
      content: `⚠️ Aufnahme läuft bereits (\`${current.meetingId}\`). Nutze \`/meeting_review\` zum Beenden.`,
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
    await interaction.followUp({
      content:
        `🔴 Aufnahme läuft in **${voiceChannel.name}**.\n` +
        '**Bitte jetzt im Voice Channel sprechen** (mind. 3 Sekunden, nicht stummgeschaltet).\n' +
        `Ruf \`/meeting_review\` auf, wenn das Meeting fertig ist. Transkript/Vorschläge erscheinen in <#${interaction.channelId}>.`,
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
    content: `⏹️ Stoppe Aufnahme \`${recording.meetingId}\` und transkribiere…`,
    ephemeral: true,
  });

  try {
    const { meetingId, trackFiles, trackDebug } = await stopRecording(guild.id);
    const reviewChannel = (interaction.channel as GuildTextBasedChannel | null) || (await fetchReviewChannel());
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

    const transcript = parts.join('\n');

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

    if (!transcript.trim()) {
      logTrackDebug(meetingId, trackDebug, failures);
      const detail = failures.length
        ? `\n${failures.map((f) => `- ${f}`).join('\n')}`
        : '\nZu wenig Audio empfangen (min. ~0,5 s pro Sprecher). Nach „Aufnahme läuft“ erneut sprechen; nicht stummgeschaltet; Bot nicht server-deafened?';
      await reviewChannel.send(
        `⚠️ Für \`${meetingId}\` konnte kein Transkript erstellt werden.${detail}`,
      );
      await interaction.followUp({ content: 'Keine verwertbare Sprache aufgenommen.', ephemeral: true });
      return;
    }

    await reviewChannel.send({
      content: `📝 **Transkript für \`${meetingId}\` (${parts.length} Sprecher-Spur(en)):**`,
      files: [{
        attachment: Buffer.from(transcript, 'utf8'),
        name: `transkript_${meetingId}.txt`,
      }],
    });

    if (failures.length) {
      await reviewChannel.send(
        '⚠️ Einige Sprecher-Spuren konnten nicht transkribiert werden:\n' +
          failures.map((f) => `- ${f}`).join('\n'),
      );
    }

    await postReviewProposals(client, settings, meetingId, transcript, reviewChannel);
    await interaction.followUp({
      content: `✅ Transkript und Ticket-Vorschläge in <#${reviewChannel.id}> gepostet.`,
      ephemeral: true,
    });
  } catch (err) {
    console.error('meeting_review failed:', err);
    await interaction.followUp({
      content: '❌ Fehler beim Review. Details in den Bot-Logs.',
      ephemeral: true,
    });
  }
}

async function handleMeetingReset(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Nur auf einem Server verfügbar.', ephemeral: true });
    return;
  }

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
      .setDescription('Aufnahme stoppen, transkribieren und Ticket-Vorschläge erstellen'),
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
