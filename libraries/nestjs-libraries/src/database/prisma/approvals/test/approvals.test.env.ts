// FORK: approvals. The fork tests run on a real Postgres, never on the app database.
export const DEFAULT_TEST_DATABASE_URL =
  'postgresql://postgres:test@127.0.0.1:5440/postiz_fork_test';

export const assertTestDatabase = () => {
  const url = process.env.FORK_TEST_DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  if (!/test/i.test(new URL(url).pathname)) {
    throw new Error(
      `FORK_TEST_DATABASE_URL must point to a database whose name contains "test", got ${url}`
    );
  }
  return url;
};

process.env.DATABASE_URL = assertTestDatabase();
process.env.APPROVALS_ENABLED = 'true';
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:4200';
process.env.UPLOAD_DIRECTORY = process.env.UPLOAD_DIRECTORY || '/uploads';
