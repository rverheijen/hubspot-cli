import { Client } from '@hubspot/api-client';

export function createClient(env) {
  const accessToken = env.HUBSPOT_ACCESS_TOKEN;
  if (!accessToken) {
    console.error('Error: HUBSPOT_ACCESS_TOKEN is not set.');
    console.error('Set it in your environment or in a .env / .env.<env> file.');
    process.exit(1);
  }
  return new Client({ accessToken });
}
