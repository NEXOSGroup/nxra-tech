// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 1 of plan-182: verify that ViewerEvents has been extracted to its
 * own module and that the re-export from rv-viewer.ts keeps existing hook
 * imports functional.
 */
import { describe, it, expect } from 'vitest';
import viewerSrc from '../src/core/rv-viewer.ts?raw';
import eventsSrc from '../src/core/rv-viewer-events.ts?raw';

describe('ViewerEvents extraction (plan-182 Phase 1)', () => {
  it('rv-viewer-events.ts declares the ViewerEvents interface', () => {
    expect(eventsSrc).toMatch(/export\s+interface\s+ViewerEvents\s*\{/);
  });

  it('rv-viewer.ts no longer re-declares ViewerEvents', () => {
    // Permit only the `export type { ViewerEvents } from './rv-viewer-events';` line.
    const declMatches = viewerSrc.match(/export\s+interface\s+ViewerEvents\s*\{/g);
    expect(declMatches).toBeNull();
  });

  it('rv-viewer.ts imports ViewerEvents from rv-viewer-events', () => {
    // Either as a type import or via the re-export line.
    expect(viewerSrc).toMatch(/from\s+['"]\.\/rv-viewer-events['"]/);
  });

  it('rv-viewer.ts re-exports ViewerEvents (backward compat for hook consumers)', () => {
    expect(viewerSrc).toMatch(/export\s+type\s*\{\s*ViewerEvents[^}]*\}\s*from\s+['"]\.\/rv-viewer-events['"]/);
  });

  it('rv-viewer-events.ts does NOT import from rv-viewer (acyclic)', () => {
    expect(eventsSrc).not.toMatch(/from\s+['"]\.\/rv-viewer['"]/);
  });
});
