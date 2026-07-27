/**
 * Craig-style multi-track voice capture: one Opus→PCM pipeline per speaker.
 * Uses @discordjs/voice (DAVE via @snazzah/davey).
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Guild, GuildMember, VoiceBasedChannel } from 'discord.js';
import {
  EndBehaviorType,
  NetworkingStatusCode,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const BITS_PER_SAMPLE = 16;
/** ~0.5 second of stereo 16-bit PCM (48kHz × 2 ch × 2 bytes × 0.5s) */
export const MIN_PCM_BYTES = Math.floor(SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8) * 0.5);

const KEEP_RECORDING_FILES = process.env.RECORDING_KEEP_FILES === '1' || process.env.RECORDING_KEEP_FILES === 'true';
const VOICE_DEBUG = process.env.VOICE_DEBUG === '1' || process.env.VOICE_DEBUG === 'true';
const DAVE_READY_TIMEOUT_MS = Number(process.env.DAVE_READY_TIMEOUT_MS || '30000');

export interface SpeakerTrack {
  userId: string;
  pcmPath: string;
  wavPath: string;
  opusStream: ReturnType<VoiceConnection['receiver']['subscribe']>;
  decoder: prism.opus.Decoder;
  writer: fs.WriteStream;
  packetCount: number;
}

export interface UdpReceiveStats {
  udpPackets: number;
  knownSsrc: number;
  hasSubscription: number;
}

export interface ActiveRecording {
  guildId: string;
  textChannelId: string;
  voiceChannelId: string;
  meetingId: string;
  connection: VoiceConnection;
  tracks: Map<string, SpeakerTrack>;
  udpStats: UdpReceiveStats;
  /** Current segment number; incremented on every interim review (rotateSegment). */
  segmentIndex: number;
}

const recordings = new Map<string, ActiveRecording>();

export function getRecording(guildId: string): ActiveRecording | undefined {
  return recordings.get(guildId);
}

export function hasRecording(guildId: string): boolean {
  return recordings.has(guildId);
}

export function makeMeetingId(channelName: string): string {
  const safe = channelName
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'meeting';
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  return `${safe}-${ts}`;
}

export async function startRecording(
  guild: Guild,
  voiceChannel: VoiceBasedChannel,
  textChannelId: string,
  meetingId: string,
): Promise<ActiveRecording> {
  if (recordings.has(guild.id)) {
    throw new Error(`Es läuft bereits eine Aufnahme: ${recordings.get(guild.id)!.meetingId}`);
  }

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
    debug: VOICE_DEBUG,
  });

  if (VOICE_DEBUG) {
    connection.on('debug', (message) => console.log(`[voice] ${message}`));
  }

  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  await waitForDaveReady(connection);

  const recording: ActiveRecording = {
    guildId: guild.id,
    textChannelId,
    voiceChannelId: voiceChannel.id,
    meetingId,
    connection,
    tracks: new Map(),
    udpStats: { udpPackets: 0, knownSsrc: 0, hasSubscription: 0 },
    segmentIndex: 0,
  };

  connection.receiver.speaking.on('start', (userId) => {
    if (VOICE_DEBUG) console.log(`[voice] speaking start user=${userId}`);
    ensureTrack(recording, userId);
  });

  // Pre-subscribe to all current members in the channel to ensure we capture their audio
  for (const [memberId, member] of voiceChannel.members) {
    if (member.user.bot) continue;
    ensureTrack(recording, memberId);
  }

  attachReceiveProbe(recording);

  recordings.set(guild.id, recording);
  console.log(`Recording started meeting=${meetingId} guild=${guild.id} channel=${voiceChannel.id}`);
  return recording;
}

function segmentPcmPath(meetingId: string, userId: string, segment: number): string {
  return path.join(os.tmpdir(), `sic-${meetingId}-${userId}-p${segment}.pcm`);
}

function segmentWavPath(meetingId: string, userId: string, segment: number): string {
  return path.join(os.tmpdir(), `sic-${meetingId}-${userId}-p${segment}.wav`);
}

export function ensureTrack(recording: ActiveRecording, userId: string): SpeakerTrack | undefined {
  if (recording.tracks.has(userId)) return recording.tracks.get(userId);

  const pcmPath = segmentPcmPath(recording.meetingId, userId, recording.segmentIndex);
  const wavPath = segmentWavPath(recording.meetingId, userId, recording.segmentIndex);
  const opusStream = recording.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.Manual },
  });
  const decoder = new prism.opus.Decoder({
    rate: SAMPLE_RATE,
    channels: CHANNELS,
    frameSize: 960,
  });
  const writer = fs.createWriteStream(pcmPath);

  const track: SpeakerTrack = {
    userId,
    pcmPath,
    wavPath,
    opusStream,
    decoder,
    writer,
    packetCount: 0,
  };

  opusStream.on('data', (chunk: Buffer) => {
    track.packetCount += 1;
  });
  opusStream.on('error', (err) => console.warn(`opus user=${userId}:`, err.message));
  decoder.on('error', (err) => console.warn(`decoder user=${userId}:`, err.message));
  writer.on('error', (err) => console.warn(`writer user=${userId}:`, err.message));

  opusStream.pipe(decoder).pipe(writer);

  recording.tracks.set(userId, track);
  const cd = recording.connection.receiver.connectionData;
  console.log(
    `Speaker track started meeting=${recording.meetingId} user=${userId} receiver=${JSON.stringify({
      encryption: Boolean(cd.encryptionMode),
      secretKey: Boolean(cd.secretKey),
      nonce: Boolean(cd.nonceBuffer),
    })}`,
  );
  return track;
}

export async function discardRecording(guildId: string): Promise<string | null> {
  const recording = recordings.get(guildId);
  if (!recording) return null;
  recordings.delete(guildId);
  for (const track of recording.tracks.values()) {
    track.opusStream.destroy();
    track.decoder.destroy();
    track.writer.end();
    await cleanupTrack(track);
  }
  recording.connection.destroy();
  return recording.meetingId;
}

export interface TrackStopInfo {
  userId: string;
  pcmPath: string;
  wavPath: string;
  pcmBytes: number;
  opusPackets: number;
  udpStats: UdpReceiveStats;
  used: boolean;
}

export interface SegmentTrackFile {
  userId: string;
  wavPath: string;
}

interface PendingSegmentTrack {
  userId: string;
  pcmPath: string;
  wavPath: string;
  writer: fs.WriteStream;
}

/**
 * Interim review: finish the current per-speaker PCM files and immediately
 * start fresh ones. The voice connection and Opus subscriptions stay alive,
 * so the recording continues seamlessly. Returns WAV files for the finished
 * segment; tracks with too little audio are skipped.
 */
export async function rotateSegment(guildId: string): Promise<{
  meetingId: string;
  finishedSegment: number;
  trackFiles: SegmentTrackFile[];
}> {
  const recording = recordings.get(guildId);
  if (!recording) throw new Error('Keine aktive Aufnahme in diesem Server.');

  const finishedSegment = recording.segmentIndex;
  recording.segmentIndex += 1;

  const pending: PendingSegmentTrack[] = [];
  for (const track of recording.tracks.values()) {
    pending.push({
      userId: track.userId,
      pcmPath: track.pcmPath,
      wavPath: track.wavPath,
      writer: track.writer,
    });

    // Detach the old writer; the decoder buffers until the new one is piped.
    track.decoder.unpipe(track.writer);
    track.writer.end();

    track.pcmPath = segmentPcmPath(recording.meetingId, track.userId, recording.segmentIndex);
    track.wavPath = segmentWavPath(recording.meetingId, track.userId, recording.segmentIndex);
    track.packetCount = 0;
    track.writer = fs.createWriteStream(track.pcmPath);
    track.writer.on('error', (err) => console.warn(`writer user=${track.userId}:`, err.message));
    track.decoder.pipe(track.writer);
  }

  const trackFiles: SegmentTrackFile[] = [];
  for (const p of pending) {
    await waitForFinish(p.writer);
    const pcmBytes = await fileSize(p.pcmPath);
    if (pcmBytes < MIN_PCM_BYTES) {
      if (!KEEP_RECORDING_FILES) await fsp.unlink(p.pcmPath).catch(() => undefined);
      continue;
    }
    await writeWavFromPcm(p.pcmPath, p.wavPath, pcmBytes);
    trackFiles.push({ userId: p.userId, wavPath: p.wavPath });
    if (!KEEP_RECORDING_FILES) await fsp.unlink(p.pcmPath).catch(() => undefined);
  }

  console.log(
    `Segment rotated meeting=${recording.meetingId} finished=${finishedSegment} usable_tracks=${trackFiles.length}`,
  );
  return { meetingId: recording.meetingId, finishedSegment, trackFiles };
}

export async function stopRecording(guildId: string): Promise<{
  meetingId: string;
  textChannelId: string;
  finishedSegment: number;
  trackFiles: SegmentTrackFile[];
  trackDebug: TrackStopInfo[];
}> {
  const recording = recordings.get(guildId);
  if (!recording) throw new Error('Keine aktive Aufnahme in diesem Server.');

  recordings.delete(guildId);

  // Stop receiving first, then drain Opus→PCM pipelines before tearing down UDP.
  for (const track of recording.tracks.values()) {
    track.opusStream.destroy();
  }
  await delay(400);

  for (const track of recording.tracks.values()) {
    track.decoder.destroy();
    track.writer.end();
  }
  await delay(200);

  recording.connection.destroy();

  console.log(
    `UDP stats meeting=${recording.meetingId}: udp=${recording.udpStats.udpPackets} known_ssrc=${recording.udpStats.knownSsrc} subscribed=${recording.udpStats.hasSubscription}`,
  );

  const trackFiles: SegmentTrackFile[] = [];
  const trackDebug: TrackStopInfo[] = [];

  for (const track of recording.tracks.values()) {
    await waitForFinish(track.writer);
    const pcmBytes = await fileSize(track.pcmPath);
    const info: TrackStopInfo = {
      userId: track.userId,
      pcmPath: track.pcmPath,
      wavPath: track.wavPath,
      pcmBytes,
      opusPackets: track.packetCount,
      udpStats: { ...recording.udpStats },
      used: false,
    };
    trackDebug.push(info);

    console.log(
      `Track user=${track.userId} pcm=${track.pcmPath} bytes=${pcmBytes} opus_packets=${track.packetCount}`,
    );

    if (pcmBytes < MIN_PCM_BYTES) {
      console.warn(`Skipping short track user=${track.userId} bytes=${pcmBytes} (min ${MIN_PCM_BYTES})`);
      if (!KEEP_RECORDING_FILES) {
        await cleanupTrack(track);
      }
      continue;
    }
    await writeWavFromPcm(track.pcmPath, track.wavPath, pcmBytes);
    info.used = true;
    trackFiles.push({ userId: track.userId, wavPath: track.wavPath });
    if (!KEEP_RECORDING_FILES) {
      await fsp.unlink(track.pcmPath).catch(() => undefined);
    }
  }

  return {
    meetingId: recording.meetingId,
    textChannelId: recording.textChannelId,
    finishedSegment: recording.segmentIndex,
    trackFiles,
    trackDebug,
  };
}

export function onMemberJoinsVoice(
  member: GuildMember,
  channelId: string,
): void {
  const recording = recordings.get(member.guild.id);
  if (!recording || recording.voiceChannelId !== channelId || member.user.bot) return;
  ensureTrack(recording, member.id);
}

function writeWavFromPcm(pcmPath: string, wavPath: string, pcmBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const header = makeWavHeader(pcmBytes);
    const input = fs.createReadStream(pcmPath);
    const output = fs.createWriteStream(wavPath);
    output.write(header);
    input.pipe(output);
    output.on('finish', resolve);
    output.on('error', reject);
    input.on('error', reject);
  });
}

function makeWavHeader(dataSize: number): Buffer {
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);
  const byteRate = SAMPLE_RATE * blockAlign;
  const buffer = Buffer.alloc(44);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return buffer;
}

function waitForFinish(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    if (stream.closed || stream.destroyed) {
      resolve();
      return;
    }
    stream.once('finish', resolve);
    stream.once('close', resolve);
    stream.once('error', reject);
  });
}

async function fileSize(filePath: string): Promise<number> {
  try {
    const stat = await fsp.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

async function cleanupTrack(track: SpeakerTrack): Promise<void> {
  await Promise.allSettled([fsp.unlink(track.pcmPath), fsp.unlink(track.wavPath)]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDaveReady(connection: VoiceConnection): boolean {
  if (connection.state.status !== VoiceConnectionStatus.Ready) return false;
  const netState = connection.state.networking.state;
  if (netState.code !== NetworkingStatusCode.Ready && netState.code !== NetworkingStatusCode.Resuming) {
    return false;
  }
  const dave = netState.dave;
  if (!dave) return true;
  return Boolean(dave.session?.ready);
}

/** Count inbound UDP voice packets (diagnostics for DAVE/receive issues). */
function attachReceiveProbe(recording: ActiveRecording): void {
  const receiver = recording.connection.receiver;
  const original = receiver.onUdpMessage.bind(receiver);
  receiver.onUdpMessage = (msg: Buffer) => {
    recording.udpStats.udpPackets += 1;
    if (msg.length > 8) {
      const ssrc = msg.readUInt32BE(8);
      const userData = receiver.ssrcMap.get(ssrc);
      if (userData) {
        recording.udpStats.knownSsrc += 1;
        if (receiver.subscriptions.has(userData.userId)) {
          recording.udpStats.hasSubscription += 1;
        }
      }
    }
    original(msg);
  };
}

async function waitForDaveReady(connection: VoiceConnection): Promise<void> {
  const deadline = Date.now() + DAVE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isDaveReady(connection)) {
      if (VOICE_DEBUG) console.log('[voice] DAVE session ready');
      return;
    }
    await delay(250);
  }
  console.warn(`DAVE session not ready after ${DAVE_READY_TIMEOUT_MS}ms — audio may be empty`);
}
