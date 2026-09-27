import { syncEngine } from '../sync/sync.engine.js';
import { prisma } from '../db/prisma.js';
async function main() {
  console.log('Running syncRecent...');
  const r = await syncEngine.syncRecent();
  console.log('Done:', JSON.stringify(r));
  await prisma.$disconnect();
  process.exit(0);
}
main();
