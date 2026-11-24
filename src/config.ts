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
  /** OpenCode agent server (self-building feature). */
  opencodeUrl: optional('OPENCODE_URL', 'http://opencode:4096').replace(/\/+$/, ''),
  /** Basic-auth password for the OpenCode server. null = self-building unavailable. */
  opencodePassword: process.env.OPENCODE_PASSWORD?.trim() || null,
  /** Dokploy deployment status pill (optional; all three must be set). */
  dokployUrl: process.env.DOKPLOY_URL?.trim().replace(/\/+$/, '') || null,
  dokployApiKey: process.env.DOKPLOY_API_KEY?.trim() || null,
  dokployComposeId: process.env.DOKPLOY_COMPOSE_ID?.trim() || null,
  databasePath: resolve(optional('DATABASE_PATH', 'data/bot.db')),
};

mkdirSync(dirname(config.databasePath), { recursive: true });
