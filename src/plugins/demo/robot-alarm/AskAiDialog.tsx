// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AskAiDialog — Simulated AI analysis of an alarm.
 *
 * Flow: a ~2 s "analyzing" spinner, then the structured answer types itself in
 * line by line. The answer comes from an AlarmAssistantProvider (fake today),
 * blends a REAL live PDF excerpt with the curated diagnosis, and cites its
 * sources as direct page deep-links into the manual.
 *
 * All three async flows (spinner timeout, provider/PDF work, typewriter
 * interval) share one `cancelled` flag and are torn down on unmount / re-run so
 * no setState fires after the dialog closes or the model changes.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Box, Typography, Button, IconButton, CircularProgress, Link,
} from '@mui/material';
import { Close, AutoAwesome, Description, StickyNote2, MenuBook } from '@mui/icons-material';
import { openPdfViewer } from '../../../core/hmi/pdf-viewer-store';
import type { AlarmScenario, AlarmNote, AlarmDocRef } from './alarm-seed-data';
import { loadNotes } from './alarm-notes-store';
import { getAlarmAssistantProvider, type AssistantResult } from './alarm-assistant-provider';

export interface AskAiDialogProps {
  alarm: AlarmScenario;
  open: boolean;
  onClose: () => void;
  /** Open the operator-note history (Sources "🗒" link + footer button). */
  onOpenHistory: () => void;
}

/** How long the answer lines reveal, one at a time (ms per line). */
const TYPEWRITER_INTERVAL_MS = 220;

/** Open the manual at a given 1-based page. */
function openManualAt(alarm: AlarmScenario, page: number): void {
  openPdfViewer(
    'FANUC CRX — Educational Cell Manual',
    { type: 'url', url: alarm.manualUrl },
    { initialPage: page },
  );
}

/**
 * Build the human "What previous operators did" summary from the considered
 * notes. Counts payload vs. cable resolutions and surfaces a recent user note.
 */
function buildOperatorSummary(notes: AlarmNote[]): string[] {
  const lines: string[] = [];
  const seed = notes.filter((n) => n.seed);
  const payloadCount = seed.filter((n) => /payload/i.test(n.text)).length;
  const cableCount = seed.filter((n) => /cable|drag|dress[- ]?out/i.test(n.text)).length;
  if (seed.length > 0) {
    lines.push(
      `In the last ${seed.length} logged cases, ${payloadCount} were resolved by correcting ` +
      `the payload and ${cableCount} by securing a dragging cable. One operator traced a ` +
      `recurring trip to a part edge and raised the approach height by 5 mm.`,
    );
  }
  const userCableNote = notes.find((n) => !n.seed && /cable|drag|dress[- ]?out/i.test(n.text));
  if (userCableNote) {
    lines.push('A recent note also flags cable drag — verify the dress-out as well.');
  }
  return lines;
}

/** A labeled section that fades in as the typewriter reaches it. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ color: '#4fc3f7', fontWeight: 700, mb: 0.5 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

export function AskAiDialog({ alarm, open, onClose, onOpenHistory }: AskAiDialogProps) {
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<AssistantResult | null>(null);
  const [error, setError] = useState('');
  // Number of "lines" revealed by the typewriter (sections gate on this).
  const [revealed, setRevealed] = useState(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Total number of reveal steps once a result is available.
  const totalLines = result
    ? 1 /* diagnosis */ + result.steps.length + (result.excerpt ? 1 : 0)
      + buildOperatorSummary(result.notesConsidered).length + 1 /* sources */
    : 0;

  const run = useCallback(() => {
    // Tear down any previous run first.
    cleanupRef.current?.();

    let cancelled = false;
    let typeTimer: ReturnType<typeof setInterval> | null = null;

    setLoading(true);
    setResult(null);
    setError('');
    setRevealed(0);

    (async () => {
      try {
        const notes = await loadNotes(alarm.id);
        if (cancelled) return;
        const provider = getAlarmAssistantProvider();
        const res = await provider.analyze({ alarm, notes });
        if (cancelled) return;

        setResult(res);
        setLoading(false);

        // Typewriter: reveal one line every interval.
        typeTimer = setInterval(() => {
          if (cancelled) return;
          setRevealed((r) => r + 1);
        }, TYPEWRITER_INTERVAL_MS);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      }
    })();

    const cleanup = () => {
      cancelled = true;
      if (typeTimer) { clearInterval(typeTimer); typeTimer = null; }
    };
    cleanupRef.current = cleanup;
    return cleanup;
  }, [alarm]);

  // Run on open; tear down on close / unmount.
  useEffect(() => {
    if (!open) return;
    const cleanup = run();
    return cleanup;
  }, [open, run]);

  // Stop the typewriter once everything is revealed.
  useEffect(() => {
    if (result && revealed >= totalLines) {
      cleanupRef.current?.();
    }
  }, [revealed, totalLines, result]);

  const operatorSummary = result ? buildOperatorSummary(result.notesConsidered) : [];

  // Reveal-gate offsets for each section.
  let cursor = 0;
  const diagnosisShown = result !== null && revealed > cursor++;
  const stepsShownUpTo = result ? revealed - cursor : 0;
  if (result) cursor += result.steps.length;
  const excerptShown = result?.excerpt ? revealed > cursor++ : false;
  const summaryShownUpTo = result ? revealed - cursor : 0;
  cursor += operatorSummary.length;
  const sourcesShown = result !== null && revealed > cursor;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 6 }}>
        <AutoAwesome sx={{ color: '#ce93d8' }} />
        <span>AI Assistant · Alarm {alarm.code}</span>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }} aria-label="Close">
          <Close />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers sx={{ minHeight: 200 }}>
        {loading && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3 }}>
            <CircularProgress size={22} />
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Analyzing alarm {alarm.code}… reading the FANUC CRX manual and {alarm.seedNotes.length} operator notes.
            </Typography>
          </Box>
        )}

        {error && (
          <Typography variant="body2" sx={{ color: '#f44336', py: 2 }}>
            Analysis failed: {error}
          </Typography>
        )}

        {result && !error && (
          <Box>
            {diagnosisShown && (
              <Section title="Diagnosis">
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>{result.diagnosis}</Typography>
              </Section>
            )}

            {stepsShownUpTo > 0 && (
              <Section title="Recommended steps">
                <Box component="ol" sx={{ pl: 2.5, m: 0 }}>
                  {result.steps.slice(0, Math.max(0, stepsShownUpTo)).map((s, i) => (
                    <Typography component="li" variant="body2" key={i} sx={{ color: 'text.secondary', mb: 0.5 }}>
                      {s}
                    </Typography>
                  ))}
                </Box>
              </Section>
            )}

            {result.excerpt && excerptShown && (
              <Section title={`From the manual (p.${result.excerpt.page})`}>
                <Box sx={{ borderLeft: '3px solid #4fc3f7', pl: 1.5, py: 0.5 }}>
                  <Typography variant="body2" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
                    “{result.excerpt.text}”
                  </Typography>
                  <Button
                    size="small"
                    startIcon={<Description sx={{ fontSize: 16 }} />}
                    onClick={() => openManualAt(alarm, result.excerpt!.page)}
                    sx={{ mt: 0.5 }}
                  >
                    Open p.{result.excerpt.page}
                  </Button>
                </Box>
              </Section>
            )}

            {summaryShownUpTo > 0 && operatorSummary.length > 0 && (
              <Section title="What previous operators did">
                {operatorSummary.slice(0, Math.max(0, summaryShownUpTo)).map((line, i) => (
                  <Typography variant="body2" key={i} sx={{ color: 'text.secondary', mb: 0.5 }}>
                    {line}
                  </Typography>
                ))}
              </Section>
            )}

            {sourcesShown && (
              <Section title="Sources">
                {result.sources.map((ref: AlarmDocRef, i) => (
                  <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
                    <Description sx={{ fontSize: 16, color: 'text.secondary' }} />
                    <Link
                      component="button"
                      variant="body2"
                      onClick={() => openManualAt(alarm, ref.page)}
                      sx={{ textAlign: 'left' }}
                    >
                      {ref.label} (p.{ref.page})
                    </Link>
                  </Box>
                ))}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <StickyNote2 sx={{ fontSize: 16, color: 'text.secondary' }} />
                  <Link component="button" variant="body2" onClick={onOpenHistory} sx={{ textAlign: 'left' }}>
                    Operator notes ({result.notesConsidered.length})
                  </Link>
                </Box>
              </Section>
            )}
          </Box>
        )}
      </DialogContent>

      <DialogActions>
        <Button
          startIcon={<MenuBook />}
          onClick={() => openManualAt(alarm, alarm.docRefs[0]?.page ?? 1)}
        >
          Open manual
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onOpenHistory}>View history</Button>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
