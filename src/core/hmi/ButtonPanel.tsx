// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { Circle } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useSlot } from '../../hooks/use-slot';
import { useMcpBridge } from '../../hooks/use-mcp-bridge';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { SETTINGS_PANEL_WIDTH, INSPECTOR_PANEL_WIDTH } from './layout-constants';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { WelcomeModal } from './WelcomeModal';
import { useCustomBranding } from './branding-store';
import { useKioskHasTour, startKioskFromWelcome } from '../../plugins/kiosk-plugin';
import { useActiveContexts, evaluateVisibilityRule } from './ui-context-store';

/* Logo URL: use BASE_URL so it resolves correctly under sub-folder deploys (e.g. Bunny CDN /demo/) */
const logoUrl = `${import.meta.env.BASE_URL}logo.png`;

/**
 * BrandingContent — renders either the default realvirtual branding or
 * a custom logo followed by "powered by realvirtual" when custom branding is set.
 */
function BrandingContent({ isMobile }: { isMobile: boolean }) {
  const custom = useCustomBranding();

  if (!custom) {
    // Default: realvirtual logo only (no text label)
    return <img src={logoUrl} alt="realvirtual" style={{ height: 18, width: 18 }} />;
  }

  // Custom branding: [Custom Logo] | [powered by rv-logo realvirtual]
  const logoHeight = custom.logoHeight ?? 20;
  return (
    <>
      <img src={custom.logoUrl} alt={custom.name ?? 'Logo'} style={{ height: logoHeight, width: 'auto', maxWidth: 180, objectFit: 'contain' }} />
      {!isMobile && (
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.4,
          ml: 0.75, pl: 0.75,
          borderLeft: '1px solid rgba(255,255,255,0.15)',
        }}>
          <Typography sx={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', whiteSpace: 'nowrap', lineHeight: 1 }}>
            powered by
          </Typography>
          <img src={logoUrl} alt="realvirtual" style={{ height: 11, width: 11, opacity: 0.5 }} />
        </Box>
      )}
    </>
  );
}

// ── Logo Badge (inline — embedded in the top-left TopBar Paper) ─────────

/** Logo + connection status badge — rendered as the leftmost element of the
 *  TopBar's button group (no longer a separate fixed-position panel). */
const WELCOME_DISMISSED_KEY = 'rv-welcome-dismissed';

export function LogoBadge() {
  const [aboutOpen, setAboutOpen] = useState(() => !localStorage.getItem(WELCOME_DISMISSED_KEY));
  const isMobile = useMobileLayout();
  const mcp = useMcpBridge();

  // Hide entirely on mobile — top-left toolbar is already cramped.
  if (isMobile) return null;

  return (
    <>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.75,
          px: 0.75,
          py: 0.5,
          mr: 0.25,
          borderRight: '1px solid rgba(255,255,255,0.08)',
          cursor: 'pointer',
          borderRadius: 1,
          '&:hover': { backgroundColor: 'rgba(255,255,255,0.04)' },
        }}
        onClick={() => setAboutOpen(true)}
        title="About"
      >
        <BrandingContent isMobile={isMobile} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <Circle sx={{ fontSize: 6, color: '#66bb6a' }} />
          <Typography sx={{ fontSize: 10, fontWeight: 500, color: 'rgba(102,187,106,0.85)', letterSpacing: 0.3 }}>
            online
          </Typography>
        </Box>
        {mcp.connected && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Circle sx={{ fontSize: 6, color: '#66bb6a' }} />
            <Typography sx={{ fontSize: 10, fontWeight: 500, color: 'rgba(102,187,106,0.85)', letterSpacing: 0.3 }}>
              ai
            </Typography>
          </Box>
        )}
      </Box>

      <WelcomeModalHost
        open={aboutOpen}
        onClose={() => { setAboutOpen(false); localStorage.setItem(WELCOME_DISMISSED_KEY, '1'); }}
      />
    </>
  );
}

/** Thread kiosk-plugin's useKioskHasTour() hook + onStartDemo callback into WelcomeModal. */
function WelcomeModalHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hasKioskTour = useKioskHasTour();
  return (
    <WelcomeModal
      open={open}
      onClose={onClose}
      onStartDemo={hasKioskTour ? startKioskFromWelcome : undefined}
    />
  );
}

// ── Button Panel (slot-driven button group) ─────────────────────────────

/** Slot-driven button group sidebar. */
export function ButtonPanel() {
  const viewer = useViewer();
  const allEntries = useSlot('button-group');

  // Active UI contexts (planner, fpv, xr, …). Drives entry visibility
  // filtering below.
  const contexts = useActiveContexts();

  /**
   * Filter slot entries to those that should currently render.
   *
   * Rules:
   *  - Entry has explicit `visibilityRule` → evaluate it directly
   *    (`shownOnlyIn` + `hiddenIn` precedence as elsewhere in the codebase).
   *  - No rule → visible by default, EXCEPT when `'planner'` is active. In
   *    planner mode the toolbar shows only planner-specific buttons (those
   *    that opt in via `visibilityRule: { shownOnlyIn: ['planner'] }`); all
   *    other model/scene plugins (Drives, Sensors, Alarms, …) get hidden so
   *    the user has a focused, distraction-free layout-editing workspace.
   */
  const entries = useMemo(() => {
    const inPlanner = contexts.has('planner');
    return allEntries.filter((entry) => {
      if (entry.visibilityRule) {
        return evaluateVisibilityRule(entry.visibilityRule, contexts);
      }
      return !inPlanner;
    });
  }, [allEntries, contexts]);

  // Check if hierarchy panel is open (and its width) to shift the button group right
  const { state: editorState } = useEditorPlugin();

  const isMobile = useMobileLayout();

  // Read leftPanelManager for panels managed outside of the extras-editor plugin
  const lpm = viewer.leftPanelManager;
  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);

  // Shift right for hierarchy panel, property inspector, or settings panel
  const inspectorExtra = editorState.panelOpen && editorState.showInspector && editorState.selectedNodePath ? INSPECTOR_PANEL_WIDTH + 8 : 0;
  const settingsWidth = editorState.settingsOpen ? SETTINGS_PANEL_WIDTH + 8 + 8 : 0; // panel + 8px left + 8px gap
  const hierarchyWidth = editorState.panelOpen && !editorState.settingsOpen ? 8 + editorState.panelWidth + 8 + inspectorExtra : 0;
  // Also account for panels managed by leftPanelManager (e.g. machine-control)
  const lpmWidth = (panelSnapshot.activePanel && panelSnapshot.activePanel !== 'settings' && panelSnapshot.activePanel !== 'hierarchy')
    ? 8 + panelSnapshot.activePanelWidth + 8 : 0;
  const buttonLeftOffset = Math.max(settingsWidth, hierarchyWidth, lpmWidth) || 12;

  if (entries.length === 0) return null;

  return (
    <Box
      sx={isMobile ? {
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 1200,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
        pb: 'env(safe-area-inset-bottom, 0px)',
      } : {
        position: 'fixed',
        left: buttonLeftOffset,
        top: 44,
        bottom: 8,
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        pointerEvents: 'none',
        transition: 'left 0.2s ease',
      }}
    >
      <Paper
        elevation={4}
        data-ui-panel
        sx={{
          display: 'flex',
          flexDirection: isMobile ? 'row' : 'column',
          gap: 0.25,
          p: 0.5,
          borderRadius: isMobile ? '12px 12px 0 0' : 2,
          pointerEvents: 'auto',
          ...(isMobile && {
            maxWidth: '100vw',
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
            scrollbarWidth: 'none',
            '&::-webkit-scrollbar': { display: 'none' },
            // Prevent any child button from shrinking
            '& > *': { flexShrink: 0 },
          }),
        }}
      >
        {entries.map((entry, i) => {
          const Comp = entry.component;
          return <Comp key={`btn-${i}`} viewer={viewer} />;
        })}
      </Paper>
    </Box>
  );
}
