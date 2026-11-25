import { BotDatabase } from './db.js';
import { config } from './config.js';
import { installLogCapture } from './logs.js';
import { createClient, registerEvents } from './bot.js';
import { startChallengeTicker, startVoiceXpTicker, startWeeklyScheduler } from './scheduler.js';
import { startWebServer } from './web/server.js';
import { BuilderRunner } from './builder/runner.js';

async function main(): Promise<void> {
  const db = new BotDatabase(config.databasePath);
  installLogCapture(db);
  console.log(`[db] sqlite database at ${config.databasePath}`);

  const client = createClient();
  const builder = new BuilderRunner(client, db);
  registerEvents(client, db, builder);

  startWebServer(client, db);
  startWeeklyScheduler(client, db);
  startVoiceXpTicker(client, db);
  startChallengeTicker(client, db);

  await client.login(config.token);
  builder.start();

  const shutdown = (): void => {
    console.log('\n[shutdown] closing...');
    builder.stop();
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
