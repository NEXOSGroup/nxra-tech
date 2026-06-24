// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * alarm-assistant-provider.ts — The seam between the alarm UI and an "AI".
 *
 * The dialog never builds canned text directly — it asks an
 * {@link AlarmAssistantProvider}. Today the only implementation is
 * {@link FakeAlarmAssistantProvider}: curated text + a real PDF excerpt +
 * simulated latency. A future LLM-backed provider implements the same async
 * contract and the UI does not change.
 *
 * Deliberately NOT built here: backend proxy, API keys, embeddings, streaming.
 */

import { extractPdfPageText, findFirstPageWithText } from '../../../core/hmi/pdf-text';
import type { AlarmDocRef, AlarmNote, AlarmScenario } from './alarm-seed-data';

/** A structured assistant answer the UI renders verbatim. */
export interface AssistantResult {
  diagnosis: string;
  steps: string[];
  /** Real excerpt pulled live from the PDF (omitted when extraction is empty). */
  excerpt?: { text: string; page: number };
  /** The notes that were considered (drives the "previous operators" block). */
  notesConsidered: AlarmNote[];
  /** Deep-link targets (resolved to real pages) for the Sources block. */
  sources: AlarmDocRef[];
}

/** Input handed to the provider for one analysis. */
export interface AlarmAssistantInput {
  alarm: AlarmScenario;
  notes: AlarmNote[];
  /** Pre-extracted manual text, if the caller already has it (optional). */
  manualText?: string;
}

/** The contract every assistant provider implements. */
export interface AlarmAssistantProvider {
  analyze(input: AlarmAssistantInput): Promise<AssistantResult>;
}

/** Simulated "thinking" latency for the fake provider (ms). */
const FAKE_LATENCY_MS = 1800;

/** Trim an excerpt to the first ~3 sentences so it stays glanceable. */
function shortenExcerpt(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const sentences = trimmed.match(/[^.!?]+[.!?]+/g);
  if (sentences && sentences.length > 0) {
    return sentences.slice(0, 3).join(' ').trim();
  }
  // No sentence punctuation — fall back to a character cap.
  return trimmed.length > 320 ? `${trimmed.slice(0, 317).trimEnd()}…` : trimmed;
}

/** True when any note mentions cable drag / dress-out (re-ranks the steps). */
function notesMentionCableDrag(notes: AlarmNote[]): boolean {
  return notes.some((n) => /cable|drag|dress[- ]?out|routing/i.test(n.text));
}

/**
 * Resolve each docRef to a live page via `findFirstPageWithText`, falling back to
 * its static page when nothing matches. Never throws.
 */
async function resolveSources(manualUrl: string, refs: AlarmDocRef[]): Promise<AlarmDocRef[]> {
  return Promise.all(
    refs.map(async (ref) => {
      const live = await findFirstPageWithText(manualUrl, ref.searchTerms);
      return { ...ref, page: live ?? ref.page };
    }),
  );
}

/**
 * Fake provider: curated diagnosis + steps, a REAL PDF excerpt, real page
 * deep-links, and simulated latency. Steps are lightly re-ranked when a recent
 * note flags cable drag.
 */
export class FakeAlarmAssistantProvider implements AlarmAssistantProvider {
  async analyze(input: AlarmAssistantInput): Promise<AssistantResult> {
    const { alarm, notes } = input;

    // Simulated "thinking" delay (the dialog also shows a spinner during this).
    await new Promise<void>((resolve) => setTimeout(resolve, FAKE_LATENCY_MS));

    // Resolve the live excerpt page, then pull its real text.
    const excerptPage =
      (await findFirstPageWithText(alarm.manualUrl, alarm.excerptSearchTerms)) ??
      alarm.docRefs[0]?.page ??
      1;
    const rawExcerpt = input.manualText ?? (await extractPdfPageText(alarm.manualUrl, excerptPage));
    const excerptText = shortenExcerpt(rawExcerpt);

    // Re-rank steps: if a recent note flags cable drag, promote the cable step.
    const steps = [...alarm.recommendedSteps];
    if (notesMentionCableDrag(notes)) {
      const cableIdx = steps.findIndex((s) => /cable/i.test(s));
      if (cableIdx > 1) {
        const [cableStep] = steps.splice(cableIdx, 1);
        steps.splice(1, 0, cableStep);
      }
    }

    const sources = await resolveSources(alarm.manualUrl, alarm.docRefs);

    return {
      diagnosis: alarm.diagnosis,
      steps,
      excerpt: excerptText ? { text: excerptText, page: excerptPage } : undefined,
      notesConsidered: notes,
      sources,
    };
  }
}

/** Singleton fake provider instance. */
const _fakeProvider = new FakeAlarmAssistantProvider();

/**
 * Provider factory. Returns the fake provider today; a later flag/real provider
 * is hooked in here without touching the UI.
 */
export function getAlarmAssistantProvider(): AlarmAssistantProvider {
  return _fakeProvider;
}
