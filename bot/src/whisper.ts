import fs from 'node:fs';

import axios from 'axios';
import FormData from 'form-data';

import type { Settings } from './config.js';

export async function transcribeWavFile(settings: Settings, filePath: string): Promise<string> {
  const form = new FormData();
  form.append('audio_file', fs.createReadStream(filePath), {
    filename: filePath.split('/').pop() || 'audio.wav',
    contentType: 'audio/wav',
  });

  const headers = form.getHeaders();
  if (settings.whisperAsrToken) {
    headers['Authorization'] = `Bearer ${settings.whisperAsrToken}`;
  }

  const response = await axios.post(`${settings.whisperAsrUrl}/asr`, form, {
    params: {
      task: 'transcribe',
      language: settings.whisperAsrLanguage,
      output: 'txt',
    },
    headers,
    timeout: settings.whisperAsrTimeoutSeconds * 1000,
    maxBodyLength: Infinity,
  });

  return String(response.data || '').trim();
}
