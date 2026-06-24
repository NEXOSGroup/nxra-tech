// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * alarm-assistant-provider tests — FakeAlarmAssistantProvider builds an
 * AssistantResult from the scenario, considers the supplied notes, and
 * re-ranks the steps when a note flags cable drag. pdf-text is mocked so the
 * test is deterministic and does not depend on the bundled PDF.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the PDF retrieval layer so the provider gets a stable excerpt/page.
vi.mock('../src/core/hmi/pdf-text', () => ({
  extractPdfPageText: vi.fn(async () => 'Contact stop is triggered when DCS detects external force. Check payload.'),
  findFirstPageWithText: vi.fn(async () => 107),
}));

import {
  FakeAlarmAssistantProvider,
  getAlarmAssistantProvider,
} from '../src/plugins/demo/robot-alarm/alarm-assistant-provider';
import { SYST_320_SCENARIO, type AlarmNote } from '../src/plugins/demo/robot-alarm/alarm-seed-data';

const provider = new FakeAlarmAssistantProvider();

describe('FakeAlarmAssistantProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a structured result with diagnosis, steps, excerpt and sources', async () => {
    const res = await provider.analyze({ alarm: SYST_320_SCENARIO, notes: SYST_320_SCENARIO.seedNotes });
    expect(res.diagnosis).toContain('SYST-320');
    expect(res.steps.length).toBe(SYST_320_SCENARIO.recommendedSteps.length);
    expect(res.excerpt).toBeTruthy();
    expect(res.excerpt?.page).toBe(107);
    expect(res.excerpt?.text.length).toBeGreaterThan(0);
    // Sources resolved to the mocked live page.
    expect(res.sources.length).toBe(SYST_320_SCENARIO.docRefs.length);
    expect(res.sources.every((s) => s.page === 107)).toBe(true);
    expect(res.notesConsidered).toHaveLength(SYST_320_SCENARIO.seedNotes.length);
  });

  it('promotes the cable step when a user note flags cable drag', async () => {
    const userCableNote: AlarmNote = {
      author: 'You', dateLabel: '24 Jun', shift: 'This shift',
      text: 'Cable was dragging again on the J6 dress-out.', seed: false,
    };
    const notes = [...SYST_320_SCENARIO.seedNotes, userCableNote];
    const res = await provider.analyze({ alarm: SYST_320_SCENARIO, notes });
    const cableIndex = res.steps.findIndex((s) => /cable/i.test(s));
    // Cable step gets promoted to position 1 (index 1), ahead of its default spot.
    expect(cableIndex).toBe(1);
  });

  it('omits the excerpt block when the PDF text is empty', async () => {
    const pdf = await import('../src/core/hmi/pdf-text');
    (pdf.extractPdfPageText as ReturnType<typeof vi.fn>).mockResolvedValueOnce('');
    (pdf.findFirstPageWithText as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await provider.analyze({ alarm: SYST_320_SCENARIO, notes: [] });
    expect(res.excerpt).toBeUndefined();
  });

  it('getAlarmAssistantProvider returns a working provider', async () => {
    const p = getAlarmAssistantProvider();
    const res = await p.analyze({ alarm: SYST_320_SCENARIO, notes: [] });
    expect(res.diagnosis).toBeTruthy();
  });
});
