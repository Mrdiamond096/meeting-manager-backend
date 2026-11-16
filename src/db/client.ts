import { PrismaPg } from '@prisma/adapter-pg';
import { config } from '../config.js';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';

export const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: config.databaseUrl,
    statement_timeout: config.dbStatementTimeoutMs,
  }),
});

export type Database = PrismaClient;
/** What a repository needs: the client itself or the `tx` handed out by `db.$transaction`. */
export type Executor = Prisma.TransactionClient;

export async function pingDb(): Promise<void> {
  await db.$queryRaw`select 1`;
}
