import { fetchQueueClusters } from '../lib/clusterBatchRunner.mjs';

async function main() {
  const clusters = await fetchQueueClusters({ minClients: 5, limit: 5 });
  console.log(`Top clusters ready for headed run (${clusters.length} clusters found):`);
  for (const c of clusters) {
    console.log(`  • ${c.company} | ${c.roleTitle} | ${c.clientCount} clients | ${c.jobUrl}`);
  }
}

main();
