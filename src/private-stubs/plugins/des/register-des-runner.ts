// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * register-des-runner.ts (PUBLIC STUB) -- Plan 194 §2.6 P5.
 *
 * When the private folder (realvirtual-WebViewer-Private~) is absent, Vite's
 * `@rv-private` alias resolves `@rv-private/plugins/des/register-des-runner` to
 * THIS stub. `createDesRunner` is `null`, so the `SimulationKernel`
 * (`hasDesRunner()`) reports DES as unavailable and the Realtime/DES toggle is
 * hidden — the public build runs continuous-only.
 *
 * The private build replaces this with the real factory
 * (`…/src/plugins/des/register-des-runner.ts`) that builds a `DESRunner`. This
 * re-export keeps the import site in `rv-viewer.ts` identical for both builds.
 */

export { createDesRunner } from '../../des-runner-stub';
export type { CreateDesRunner } from '../../des-runner-stub';
