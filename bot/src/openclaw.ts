import axios from 'axios';

import type { Settings } from './config.js';

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

function parseChatCompletionsBody(body: unknown): string {
  if (!body || typeof body !== 'object') {
    throw new Error(`Unexpected OpenClaw chat response: ${JSON.stringify(body)}`);
  }
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new Error(`OpenClaw chat response has no choices: ${JSON.stringify(body)}`);
  }
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  const content = message?.content;
  if (typeof content === 'string' && content.trim()) return content;
  throw new Error(`OpenClaw chat response has no message content: ${JSON.stringify(body)}`);
}

export async function openClawSendMessage(settings: Settings, message: string): Promise<string> {
  if (!settings.openclawBaseUrl || !settings.openclawApiToken) {
    throw new Error('OpenClaw not configured');
  }

  const url = `${settings.openclawBaseUrl}/v1/chat/completions`;
  const response = await axios.post(
    url,
    {
      model: settings.openclawModel,
      messages: [{ role: 'user', content: message }],
    },
    {
      headers: authHeaders(settings.openclawApiToken),
      timeout: settings.openclawTimeoutSeconds * 1000,
      validateStatus: () => true,
    },
  );

  if (response.status === 404) {
    throw new Error(
      'OpenClaw /v1/chat/completions not found — enable gateway.http.endpoints.chatCompletions in OpenClaw config',
    );
  }
  if (response.status < 200 || response.status >= 300) {
    const detail =
      typeof response.data === 'string'
        ? response.data.slice(0, 500)
        : JSON.stringify(response.data).slice(0, 500);
    throw new Error(`OpenClaw HTTP ${response.status}: ${detail}`);
  }

  const contentType = String(response.headers['content-type'] || '');
  if (contentType.includes('text/html')) {
    console.error('OpenClaw returned HTML:', String(response.data || '').slice(0, 1000));
    throw new Error(
      'OpenClaw returned HTML — enable chatCompletions in OpenClaw gateway config',
    );
  }

  return parseChatCompletionsBody(response.data);
}
