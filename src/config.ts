import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) throw new Error(`Missing required env var ${name}`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

export const config = {
  token: required('DISCORD_TOKEN'),
  clientId: required('CLIENT_ID'),
  clientSecret: required('CLIENT_SECRET'),
  guildId: required('GUILD_ID'),
  adminRoleId: process.env.ADMIN_ROLE_ID?.trim() || null,
  dashboardUrl: required('DASHBOARD_URL').replace(/\/+$/, ''),
  dashboardPort: Number(optional('DASHBOARD_PORT', '3000')),
  sessionSecret: required('SESSION_SECRET'),
  /** FreeStuff webhook signing key (base64 SPKI DER). null = webhook disabled. */
  freestuffPublicKey: process.env.FREESTUFF_PUBLIC_KEY?.trim() || null,
  databasePath: resolve(optional('DATABASE_PATH', 'data/bot.db')),
};

mkdirSync(dirname(config.databasePath), { recursive: true });
