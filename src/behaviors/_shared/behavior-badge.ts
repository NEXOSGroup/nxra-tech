// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared hierarchy/inspector badge for behavior-marker capabilities
 * (Conveyor, Turntable, …). One source of truth for the badge colour and
 * filter label so every transport behavior registers an identical capability.
 */
export const BEHAVIOR_BADGE = {
  badgeColor: '#7e57c2',
  filterLabel: 'Behavior',
  hierarchyVisible: true,
  inspectorVisible: true,
} as const;
