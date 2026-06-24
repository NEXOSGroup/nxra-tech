// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RobotContactForceAlarm — The FANUC CRX SYST-320 alarm tile.
 *
 * A red (error) TileCard with a prominent "Ask AI" button and a History icon
 * button (badge = note count). "Ask AI" opens the simulated assistant; the
 * history icon opens the operator-note dialog. Clicking the card body pulses the
 * robot red in 3D and frames it. The "see manual" sub-link opens the bundled PDF
 * at the contact-stop page.
 */

import { useEffect, useState, useCallback } from 'react';
import { Button, IconButton, Badge } from '@mui/material';
import { AutoAwesome, History } from '@mui/icons-material';
import { TileCard } from '../../../core/hmi/TileCard';
import { openPdfViewer } from '../../../core/hmi/pdf-viewer-store';
import type { UISlotProps } from '../../../core/rv-ui-plugin';
import { SYST_320_SCENARIO } from './alarm-seed-data';
import { loadNotes } from './alarm-notes-store';
import { AskAiDialog } from './AskAiDialog';
import { AlarmHistoryDialog } from './AlarmHistoryDialog';

const ALARM_PULSE_DURATION_MS = 3500;

/**
 * Frame the robot in 3D and pulse a red alarm outline for a few seconds. Mirrors
 * the demo's `pulseMotorAlarm` pattern (camera-only fit + outline pass, no focus
 * event). Pure visual cue.
 */
function pulseRobotAlarm(viewer: UISlotProps['viewer'], path: string): void {
  const node = viewer.registry?.getNode(path);
  if (!node) return;
  const outline = viewer.outlineManager;
  const prevStyle = outline.getStyle();
  outline.setStyle({
    visibleEdgeColor: 0xff3030,
    hiddenEdgeColor: 0x8a1a1a,
    edgeStrength: 20,
    edgeThickness: 10,
    edgeGlow: 1.5,
    pulsePeriod: 0.6,
  });
  outline.setOutlined([node]);
  viewer.fitToNodes([node]);
  window.setTimeout(() => {
    outline.setStyle({ ...prevStyle });
    outline.clear();
  }, ALARM_PULSE_DURATION_MS);
}

export function RobotContactForceAlarm({ viewer }: UISlotProps) {
  const alarm = SYST_320_SCENARIO;
  const [askOpen, setAskOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [noteCount, setNoteCount] = useState(alarm.seedNotes.length);

  // Keep the badge in sync with the stored notes.
  const refreshCount = useCallback(() => {
    let cancelled = false;
    loadNotes(alarm.id).then((n) => { if (!cancelled) setNoteCount(n.length); });
    return () => { cancelled = true; };
  }, [alarm.id]);

  useEffect(() => refreshCount(), [refreshCount]);

  // Close dialogs when the model changes (avoid stale refs/notes).
  useEffect(() => {
    const onCleared = () => { setAskOpen(false); setHistoryOpen(false); };
    const off = viewer.on('model-cleared', onCleared);
    return off;
  }, [viewer]);

  const openManual = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const page = alarm.docRefs[1]?.page ?? alarm.docRefs[0]?.page ?? 1;
    openPdfViewer(
      'FANUC CRX — Educational Cell Manual',
      { type: 'url', url: alarm.manualUrl },
      { initialPage: page },
    );
  }, [alarm]);

  const subtitle = (
    <>
      {alarm.subtitle} —{' '}
      <a
        href="#"
        onClick={openManual}
        style={{ color: '#4fc3f7', textDecoration: 'underline', cursor: 'pointer' }}
      >
        see manual
      </a>
    </>
  );

  return (
    <>
      <TileCard
        title={alarm.title}
        subtitle={subtitle}
        severity={alarm.severity}
        icon={alarm.icon}
        timestamp={alarm.timestamp}
        componentPath={alarm.componentPath}
        onAction={() => pulseRobotAlarm(viewer, alarm.componentPath)}
        actions={
          <>
            <Button
              variant="contained"
              size="small"
              startIcon={<AutoAwesome sx={{ fontSize: 16 }} />}
              disabled={askOpen}
              onClick={(e) => { e.stopPropagation(); setAskOpen(true); }}
            >
              Ask AI
            </Button>
            <span style={{ flex: 1 }} />
            <IconButton
              size="small"
              aria-label="View alarm history"
              onClick={(e) => { e.stopPropagation(); setHistoryOpen(true); }}
            >
              <Badge badgeContent={noteCount} color="primary">
                <History sx={{ fontSize: 20 }} />
              </Badge>
            </IconButton>
          </>
        }
      />

      <AskAiDialog
        alarm={alarm}
        open={askOpen}
        onClose={() => setAskOpen(false)}
        onOpenHistory={() => { setAskOpen(false); setHistoryOpen(true); }}
      />

      <AlarmHistoryDialog
        alarm={alarm}
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onNotesChanged={refreshCount}
      />
    </>
  );
}
