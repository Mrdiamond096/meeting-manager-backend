import { execFileSync } from 'node:child_process';

export function setup() {
  try {
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'pipe', env: process.env });
  } catch (err) {
    throw new Error(`Tests need PostgreSQL at DATABASE_URL (try: docker compose up -d db). ${String(err)}`);
  }
}
