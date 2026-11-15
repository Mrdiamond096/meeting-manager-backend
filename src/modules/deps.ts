import type { Database } from '../db/client.js';

/** Dependencies every module router receives. `now` lets tests control time. */
export interface ModuleDeps {
  db: Database;
  now: () => Date;
}
