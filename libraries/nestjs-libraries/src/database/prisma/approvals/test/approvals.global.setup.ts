import { execSync } from 'child_process';
import { assertTestDatabase } from './approvals.test.env';

// FORK: approvals. Pushes the schema to the test database once per run.
export default async function globalSetup() {
  const url = assertTestDatabase();
  execSync(
    'npx prisma db push --skip-generate --accept-data-loss --schema ./libraries/nestjs-libraries/src/database/prisma/schema.prisma',
    {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: url },
    }
  );
}
