// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Separate vitest config for Node-environment tests.
 *
 * Use case: tests that need Node-only APIs (fs, glob, ESLint instance) and
 * thus cannot run in the Playwright browser-mode used by the default config.
 *
 * Convention: file extension `*.node.test.ts` (vs `*.test.ts` for browser tests).
 *
 * Invocation: `npm run test:node` (see package.json).
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'node',
    environment: 'node',
    include: ['tests/**/*.node.test.ts'],
    pool: 'forks',
  },
});
