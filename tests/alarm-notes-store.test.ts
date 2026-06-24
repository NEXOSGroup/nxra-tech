// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * alarm-notes-store tests — seed+user merge, persistence, isolation, and
 * corrupt-storage fallback for the FANUC CRX alarm assistant.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadNotes, addNote } from '../src/plugins/demo/robot-alarm/alarm-notes-store';
import { SYST_320_SCENARIO } from '../src/plugins/demo/robot-alarm/alarm-seed-data';

const KEY = 'demo-alarm-notes:SYST-320';

describe('alarm-notes-store', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('returns exactly the seed notes when localStorage is empty', async () => {
    const notes = await loadNotes('SYST-320');
    expect(notes).toHaveLength(SYST_320_SCENARIO.seedNotes.length);
    expect(notes.map((n) => n.author)).toEqual(['Roberto M.', 'Anja K.', 'Yuki N.']);
    expect(notes.every((n) => n.seed)).toBe(true);
  });

  it('persists a user note; seed notes stay first, user note appended', async () => {
    await addNote('SYST-320', { author: 'You', dateLabel: '24 Jun', shift: 'This shift', text: 'cable drag on J6' });
    const notes = await loadNotes('SYST-320');
    expect(notes).toHaveLength(SYST_320_SCENARIO.seedNotes.length + 1);
    // Seed notes first
    expect(notes[0].seed).toBe(true);
    // User note last
    const last = notes[notes.length - 1];
    expect(last.seed).toBe(false);
    expect(last.author).toBe('You');
    expect(last.text).toBe('cable drag on J6');
  });

  it('isolates notes per alarm id', async () => {
    await addNote('SYST-320', { author: 'You', dateLabel: '24 Jun', shift: 'This shift', text: 'note for 320' });
    const other = await loadNotes('OTHER-999');
    // Unknown id has no seed notes and must not see SYST-320 user notes.
    expect(other).toHaveLength(0);
  });

  it('falls back to seed notes when the stored value is corrupt (no throw)', async () => {
    localStorage.setItem(KEY, '{ this is not json');
    const notes = await loadNotes('SYST-320');
    expect(notes).toHaveLength(SYST_320_SCENARIO.seedNotes.length);
  });

  it('ignores a stored value whose notes is not an array', async () => {
    localStorage.setItem(KEY, JSON.stringify({ notes: 'oops' }));
    const notes = await loadNotes('SYST-320');
    expect(notes).toHaveLength(SYST_320_SCENARIO.seedNotes.length);
  });
});
