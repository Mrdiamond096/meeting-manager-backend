import { hash } from 'bcryptjs';
import type { z } from 'zod';
import { db } from './client.js';
import { seedDemoData } from './seed.js';
import { BCRYPT_COST } from '../modules/auth/password.js';
import { email as emailSchema, password as passwordSchema } from '../modules/auth/schemas.js';

/**
 * `npm run db:seed` (make seed). The demo login is written in the README; both values can be overridden with
 * SEED_DEMO_EMAIL and SEED_DEMO_PASSWORD, and are checked with the same rules as registration.
 */
export const DEFAULT_DEMO_EMAIL = 'demo@example.com';
export const DEFAULT_DEMO_PASSWORD = 'demo-password-123';

function parseSetting(name: string, schema: z.ZodType<string, z.ZodTypeDef, string>, value: string): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${name} is not valid: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
  return parsed.data;
}

async function main() {
  const email = parseSetting('SEED_DEMO_EMAIL', emailSchema, process.env.SEED_DEMO_EMAIL ?? DEFAULT_DEMO_EMAIL);
  const password = parseSetting(
    'SEED_DEMO_PASSWORD',
    passwordSchema,
    process.env.SEED_DEMO_PASSWORD ?? DEFAULT_DEMO_PASSWORD,
  );

  const result = await seedDemoData(db, { email, passwordHash: await hash(password, BCRYPT_COST), now: new Date() });
  console.log(
    `Seeded ${result.candidates} candidates, ${result.meetings} meetings and ${result.feedback} feedback notes for ${email}.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error('Seeding failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
