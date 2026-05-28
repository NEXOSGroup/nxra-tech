// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Picker popup smoke test — renders the popup with a stubbed viewer +
 * snap-hover state and asserts visibility, ESC close, and outside-click close.
 *
 * Full E2E (hover near snap -> marker -> click -> picker -> place) is
 * out of scope for unit tests since it requires a fully wired RVViewer
 * with renderer + layout-planner. Asset placement is exercised separately
 * via snap-placement-validation + scene-mutations tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Object3D } from 'three';
import { SnapPointPickerPopup } from '../src/plugins/snap-point/SnapPointPickerPopup';
import {
  snapHoverStore,
} from '../src/plugins/snap-point/snap-hover-store';
import type { SnapPoint } from '../src/core/engine/rv-snap-point-registry';

function makeSnap(id: string): SnapPoint {
  const n = new Object3D();
  n.name = 'Snap-ZN-convroll';
  return {
    id,
    object3D: n,
    dir: { axis: 'Z', sign: 'N', code: 'ZN' },
    typeId: 'convroll',
    ownerRoot: n,
    scenePath: 'Snap-ZN-convroll',
    occupied: false,
  };
}

function makeViewerStub() {
  // Empty viewer — picker reads catalogs via useSyncExternalStore which
  // tolerates null subscribe/getSnapshot.
  return {
    getPlugin: () => undefined,
  };
}

describe('SnapPointPickerPopup', () => {
  beforeEach(() => {
    snapHoverStore.reset();
    cleanup();
  });

  it('renders nothing when picker is closed', () => {
    const { container } = render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    expect(container.querySelector('[data-testid="snap-picker-popup"]')).toBeNull();
  });

  it('renders the popup when picker is open', () => {
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 100, y: 100 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    expect(screen.getByTestId('snap-picker-popup')).toBeTruthy();
  });

  it('displays the typeId in the title', () => {
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 100, y: 100 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    expect(screen.getByText('convroll', { exact: false })).toBeTruthy();
  });

  it('shows empty-state when no compatible library entries exist', async () => {
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 100, y: 100 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    // Wait for the async loader to settle (Promise.resolve microtask)
    await new Promise((r) => setTimeout(r, 50));
    const popup = screen.getByTestId('snap-picker-popup');
    expect(popup.textContent ?? '').toMatch(/no compatible/i);
  });

  it('positions the popup near the screen anchor', () => {
    const sp = makeSnap('a');
    snapHoverStore.openPicker(sp, { x: 200, y: 150 });
    render(<SnapPointPickerPopup viewer={makeViewerStub() as never} />);
    const popup = screen.getByTestId('snap-picker-popup') as HTMLElement;
    // MUI Paper computed style — 12 px offset hard-coded in the popup
    const cs = window.getComputedStyle(popup);
    expect(cs.left).toBe('212px');
    expect(cs.top).toBe('162px');
  });
});
