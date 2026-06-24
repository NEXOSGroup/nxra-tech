// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * alarm-notes-store.ts — Operator-note storage for the alarm assistant.
 *
 * Async by design so a shared REST/Firebase note service can drop in later
 * without changing any call site. Today the implementation is localStorage:
 * the curated seed notes always come first, followed by any user-added notes.
 *
 * Locked (kiosk) deployments cannot persist — `addNote` resolves without
 * writing and the UI surfaces a "not saved" hint via {@link notesArePersistable}.
 */

import { lsLoad, lsSave } from '../../../core/hmi/ls-store-utils';
import { isSettingsLocked } from '../../../core/rv-app-config';
import { ALARM_SCENARIOS, type AlarmNote, type AlarmScenario } from './alarm-seed-data';

/** localStorage key for the user-added notes of one alarm. */
function storageKey(alarmId: string): string {
  return `demo-alarm-notes:${alarmId}`;
}

/** Shape persisted to localStorage. */
interface StoredNotes {
  notes: AlarmNote[];
}

const DEFAULTS: StoredNotes = { notes: [] };

/** Read the user-added notes (never the seed notes) for one alarm. Never throws. */
function loadUserNotes(alarmId: string): AlarmNote[] {
  const stored = lsLoad<StoredNotes>(storageKey(alarmId), DEFAULTS, {
    validate: (_merged, parsed) => {
      // Only accept a well-formed notes array; ignore corrupted entries.
      const arr = (parsed as Partial<StoredNotes>).notes;
      if (!Array.isArray(arr)) return { notes: [] };
      const clean = arr.filter(
        (n): n is AlarmNote =>
          !!n && typeof n === 'object' &&
          typeof (n as AlarmNote).author === 'string' &&
          typeof (n as AlarmNote).text === 'string',
      );
      return { notes: clean };
    },
  });
  return stored.notes;
}

/** Seed notes for one alarm (empty for unknown ids → isolation). */
function seedNotes(alarmId: string): AlarmNote[] {
  const scenario: AlarmScenario | undefined = ALARM_SCENARIOS[alarmId as AlarmScenario['id']];
  return scenario ? scenario.seedNotes.map((n) => ({ ...n, seed: true })) : [];
}

/**
 * Load all notes for an alarm: seed notes first, then user-added notes.
 * Unknown alarm ids return only their (empty) set — no cross-id bleed.
 */
export async function loadNotes(alarmId: string): Promise<AlarmNote[]> {
  return [...seedNotes(alarmId), ...loadUserNotes(alarmId)];
}

/**
 * Append a user note. On locked (kiosk) deployments this is a no-op persist
 * (lsSave already guards on `isSettingsLocked`) — the promise still resolves so
 * the UI does not crash; surface the "not saved" hint via {@link notesArePersistable}.
 */
export async function addNote(alarmId: string, note: AlarmNote): Promise<void> {
  const userNotes = loadUserNotes(alarmId);
  userNotes.push({ ...note, seed: false });
  lsSave<StoredNotes>(storageKey(alarmId), { notes: userNotes });
}

/** False on locked (kiosk) deployments where notes cannot be persisted. */
export function notesArePersistable(): boolean {
  return !isSettingsLocked();
}
