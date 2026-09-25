import { createApp } from './app';
import { config } from './config';
import { Dataset } from './dataset';
import { Store } from './db';

const store = new Store(config.dbPath);
const dataset = Dataset.load(config.datasetDir);
console.log(`dataset: ${dataset.songs.length} songs, ${dataset.titles.length} titles`);

const { server, manager } = createApp({
  store, dataset, masterPassword: config.masterPassword, trustProxy: config.trustProxy,
  webDist: config.production ? config.webDist : undefined,
});
console.log(`restored ${manager.rooms.size} rooms`);

server.listen(config.port, config.host, () => console.log(`listening on http://${config.host}:${config.port}`));

const shutdown = () => {
  server.close();
  store.db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
