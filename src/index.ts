import { BotDatabase } from './db.js';
import { config } from './config.js';
import { installLogCapture } from './logs.js';
import { createClient, registerEvents } from './bot.js';
import { startWeeklyScheduler } from './scheduler.js';
import { startWebServer } from './web/server.js';

async function main(): Promise<void> {
  const db = new BotDatabase(config.databasePath);
  installLogCapture(db);
  console.log(`[db] sqlite database at ${config.databasePath}`);

  const client = createClient();
  registerEvents(client, db);

  startWebServer(client, db);
  startWeeklyScheduler(client, db);

  await client.login(config.token);

  const shutdown = (): void => {
    console.log('\n[shutdown] closing...');
    client.destroy();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
