import { fetchQueueClusters } from '../lib/clusterBatchRunner.mjs';

async function main() {
  const clusters = await fetchQueueClusters({ minClients: 1, limit: 25 });
  console.log(`\n📋 Unique Job Links in batch_job_queue (${clusters.length} shown):`);
  clusters.forEach((c) => {
    console.log(`- [${c.linkId}] Tasks: ${c.clientCount} clients | URL: ${c.jobUrl}`);
  });
}

main().catch(console.error);
