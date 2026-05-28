// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Phase 1 of plan-182: ComponentContext.events is typed as EventEmitter<ViewerEvents>.
 */
import { describe, it, expectTypeOf } from 'vitest';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import type { EventEmitter } from '../src/core/rv-events';
import type { ViewerEvents } from '../src/core/rv-viewer-events';

describe('ComponentContext type surface (plan-182 Phase 1)', () => {
  it('events field is typed as EventEmitter<ViewerEvents>', () => {
    type Events = NonNullable<ComponentContext['events']>;
    expectTypeOf<Events>().toEqualTypeOf<EventEmitter<ViewerEvents>>();
  });
});
