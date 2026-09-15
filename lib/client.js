import { Client } from '@hubspot/api-client';

export function createClient(env) {
  const accessToken = env.HUBSPOT_API_KEY || env.HUBSPOT_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Error: HUBSPOT_API_KEY is not set.');
    console.error('Set it in your environment or in a .env / .env.<env> file.');
    process.exit(1);
  }

  return new Client({ accessToken });
}

export async function apiRequest(client, method, endpoint, body) {
  const response = await client.apiRequest({
    method,
    path: endpoint,
    body: body ? JSON.stringify(body) : undefined,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
  });

  const text = await response.body;
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
