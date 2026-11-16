import { hash } from 'bcryptjs';
import { pino } from 'pino';
import type { z } from 'zod';
import { config } from '../config.js';
import { db } from './client.js';
import { demoSeedRefusal, seedDemoData } from './seed.js';
import { BCRYPT_COST } from '../modules/auth/password.js';
import { email as emailSchema, password as passwordSchema } from '../modules/auth/schemas.js';

/**
 * `npm run db:seed` (make seed). Never part of the image's CMD or of a migration.
 *
 * The demo login is written in the README; both values can be overridden with SEED_DEMO_EMAIL and
 * SEED_DEMO_PASSWORD, and are checked with the same rules as registration. In production it needs
 * ALLOW_DEMO_SEED=true (make seed passes it for the one command). Output is JSON lines like the server's logs.
 */
export const DEFAULT_DEMO_EMAIL = 'demo@example.com';
export const DEFAULT_DEMO_PASSWORD = 'demo-password-123';

const log = pino({ base: { service: 'seed' } }, pino.destination({ dest: 1, sync: true }));

function parseSetting(name: string, schema: z.ZodType<string, string>, value: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${name} is not valid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}

async function main() {
  const refusal = demoSeedRefusal(config);
  if (refusal) {
    log.error(refusal);
    process.exitCode = 1;
    return;
  }

  const email = parseSetting('SEED_DEMO_EMAIL', emailSchema, process.env.SEED_DEMO_EMAIL ?? DEFAULT_DEMO_EMAIL);
  const password = parseSetting(
    'SEED_DEMO_PASSWORD',
    passwordSchema,
    process.env.SEED_DEMO_PASSWORD ?? DEFAULT_DEMO_PASSWORD,
  );

  const result = await seedDemoData(db, { email, passwordHash: await hash(password, BCRYPT_COST), now: new Date() });
  log.info(
    { candidates: result.candidates, meetings: result.meetings, feedback: result.feedback },
    'demo data seeded; log in as the demo user (see README)',
  );
}

main()
  .catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : 'seeding failed');
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
