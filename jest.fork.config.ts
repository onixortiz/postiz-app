import type { Config } from 'jest';
import { pathsToModuleNameMapper } from 'ts-jest';
import { readFileSync } from 'fs';

// FORK: approvals. The root jest.config.ts needs @nx/jest, which isn't installed,
// so the fork tests run with their own config.
const { compilerOptions } = JSON.parse(
  readFileSync(`${__dirname}/tsconfig.base.json`, 'utf8')
);

// each file gets its threshold in the phase that creates it
const branches90 = { branches: 90 };
const thresholdFiles: string[] = [
  './libraries/nestjs-libraries/src/database/prisma/approvals/approval.gate.service.ts',
  './libraries/nestjs-libraries/src/database/prisma/approvals/approval.policy.service.ts',
  // './libraries/nestjs-libraries/src/database/prisma/approvals/approval.service.ts',
];

const config: Config = {
  rootDir: __dirname,
  testEnvironment: 'node',
  // the tests share one real Postgres (FORK_TEST_DATABASE_URL)
  maxWorkers: 1,
  testTimeout: 60000,
  setupFiles: [
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/approvals/test/approvals.test.env.ts',
  ],
  globalSetup:
    '<rootDir>/libraries/nestjs-libraries/src/database/prisma/approvals/test/approvals.global.setup.ts',
  testMatch: ['**/approvals/**/*.spec.ts', '**/*.approvals.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          ...compilerOptions,
          paths: undefined,
          baseUrl: undefined,
        },
        isolatedModules: true,
      },
    ],
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  // the stubs go first: jest uses the first pattern that matches
  moduleNameMapper: {
    '^@gitroom/nestjs-libraries/integrations/integration.manager$':
      '<rootDir>/libraries/nestjs-libraries/src/database/prisma/approvals/test/stubs/integration.manager.ts',
    '^@gitroom/nestjs-libraries/upload/upload.factory$':
      '<rootDir>/libraries/nestjs-libraries/src/database/prisma/approvals/test/stubs/upload.factory.ts',
    '^file-type$':
      '<rootDir>/libraries/nestjs-libraries/src/database/prisma/approvals/test/stubs/file-type.ts',
    '^isomorphic-dompurify$':
      '<rootDir>/libraries/nestjs-libraries/src/database/prisma/approvals/test/stubs/isomorphic-dompurify.ts',
    ...pathsToModuleNameMapper(compilerOptions.paths, {
      prefix: '<rootDir>/',
    }),
  },
  passWithNoTests: true,
  collectCoverage: true,
  collectCoverageFrom: [
    'libraries/nestjs-libraries/src/database/prisma/approvals/**/*.ts',
    '!**/*.spec.ts',
    '!**/approvals/test/**',
  ],
  coverageThreshold: {
    global: {},
    ...Object.fromEntries(thresholdFiles.map((file) => [file, branches90])),
  },
};

export default config;
