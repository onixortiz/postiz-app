#!/usr/bin/env node
// FORK: approvals. Fails when the fork's schema.prisma would change or remove
// anything that exists upstream. The fork may only add tables, enums, indexes
// and constraints of its own: upstream keeps using `prisma db push`, and a
// destructive change would break the merge from upstream or lose data.
//
// usage: node scripts/fork/check-schema-additive.mjs <upstream.prisma> <fork.prisma>
//
// The SQL from `prisma migrate diff` is only read, never run.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [upstreamPath, forkPath] = process.argv.slice(2);
if (!upstreamPath || !forkPath) {
  console.error(
    'usage: node scripts/fork/check-schema-additive.mjs <upstream.prisma> <fork.prisma>'
  );
  process.exit(2);
}

// the tables and enums upstream owns
const upstream = readFileSync(upstreamPath, 'utf8');
const owned = new Set(
  [...upstream.matchAll(/^\s*(?:model|enum)\s+(\w+)\s*\{/gm)].map((m) => m[1])
);

const sql = execFileSync(
  'pnpm',
  [
    'dlx',
    'prisma@6.5.0',
    'migrate',
    'diff',
    '--from-schema-datamodel',
    upstreamPath,
    '--to-schema-datamodel',
    forkPath,
    '--script',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
);

// one statement per entry, comments out
const statements = sql
  .split(/;\s*$/m)
  .map((p) =>
    p
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
  .filter((p) => p);

// the object a statement changes: ALTER TABLE "X", DROP TABLE "X", ALTER TYPE "X"...
const targetOf = (statement) =>
  /^(?:ALTER|DROP)\s+(?:TABLE|TYPE|INDEX)\s+(?:IF EXISTS\s+)?"([^"]+)"/i.exec(
    statement
  )?.[1];

const destructive = /\b(DROP|RENAME)\b|\bALTER\s+COLUMN\b|^ALTER\s+TYPE\b/i;

const problems = statements.filter((statement) => {
  const target = targetOf(statement);
  return !!target && owned.has(target) && destructive.test(statement);
});

if (problems.length) {
  console.error(
    'The fork schema changes or removes something upstream owns:\n'
  );
  for (const statement of problems) {
    console.error(`  ${statement}`);
  }
  console.error(
    '\nKeep the fork additive: new tables, enums and relations only (see FORK_TOUCHPOINTS.md).'
  );
  process.exit(1);
}

console.log(
  `Schema is additive: ${statements.length} statements, none touching the ${owned.size} upstream tables and enums.`
);
