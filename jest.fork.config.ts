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
  // './libraries/nestjs-libraries/src/database/prisma/approvals/approval.gate.service.ts',
  // './libraries/nestjs-libraries/src/database/prisma/approvals/approval.service.ts',
  // './libraries/nestjs-libraries/src/database/prisma/approvals/approval.policy.service.ts',
];

const config: Config = {
  rootDir: __dirname,
  testEnvironment: 'node',
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
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, {
    prefix: '<rootDir>/',
  }),
  passWithNoTests: true,
  collectCoverage: true,
  collectCoverageFrom: [
    'libraries/nestjs-libraries/src/database/prisma/approvals/**/*.ts',
    '!**/*.spec.ts',
  ],
  coverageThreshold: {
    global: {},
    ...Object.fromEntries(thresholdFiles.map((file) => [file, branches90])),
  },
};

export default config;
