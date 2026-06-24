// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, useSyncExternalStore, useRef } from 'react';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { Typography, Box, Paper } from '@mui/material';
import { Layers } from '@mui/icons-material';
import { useMobileLayout, isMobileDevice } from '../../hooks/use-mobile-layout';
import { useViewer } from '../../hooks/use-viewer';
import { useMode } from '../../hooks/use-mode';
import { HierarchyBrowser } from './rv-hierarchy-browser';
import { PropertyInspector } from './rv-property-inspector';
import { AasDetailPanel } from '../../plugins/aas-link-plugin';
import { FLOATING_TOP_MARGIN, ACTIVITY_BAR_WIDTH } from './layout-constants';
import { useLeftWindowWidth, useRightWindowWidth } from '../../hooks/use-left-window-width';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { ModeDropdown } from './ModeDropdown';
import { CameraBookmarks, HmiToggleButton, FpvBarButton, FollowCamButton, SitOnCamButton } from './CameraBar';
import { ActionGroupPill, ActionSegment, ActionDivider } from './action-group';
import { SettingsPanel } from './SettingsPanel';
import { SceneWindow } from './scene/SceneWindow';
import { getSceneStore } from './scene/scene-store-singleton';
import { MachineControlPanel } from './MachineControlPanel';
import { SlotRenderer } from './HMIShell';
import { useSlot } from '../../hooks/use-slot';

export function TopBar() {
  const viewer = useViewer();
  const [vrOpen, setVrOpen] = useState(false);
  const sceneStore = getSceneStore();

  // Hierarchy panel state from plugin
  const { plugin, state: pluginState } = useEditorPlugin();
  const hierarchyOpen = pluginState.panelOpen;
  const settingsOpen = pluginState.settingsOpen;

  const lpm = viewer.leftPanelManager;

  // leftPanelManager is the single source of truth for which left window is
  // open (the activity bar buttons drive it). The Hierarchy plugin and Settings
  // keep their own open flags, so reconcile them here whenever the active left
  // panel changes — closing any plugin-tracked panel that lost the slot.
  const panelSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const hierarchyOpenRef = useRef(hierarchyOpen);
  hierarchyOpenRef.current = hierarchyOpen;
  const pluginRef = useRef(plugin);
  pluginRef.current = plugin;
  useEffect(() => {
    const active = panelSnapshot.activePanel;
    if (active !== 'settings' && settingsOpenRef.current) {
      pluginRef.current?.setSettingsOpen(false);
    }
    if (active !== 'hierarchy' && hierarchyOpenRef.current) {
      pluginRef.current?.togglePanel();
    }
  }, [panelSnapshot.activePanel]);

  const isMobile = useMobileLayout();

  // Re-render when a model loads so the right-region Groups button appears
  // once the loaded scene exposes groups (groupCount > 0).
  const [, setModelTick] = useState(0);
  useEffect(() => {
    const handler = () => setModelTick(t => t + 1);
    viewer.on('model-loaded', handler);
    return () => { viewer.off('model-loaded', handler); };
  }, [viewer]);

  // Shift the floating mode switcher right to stay in the *visible* viewport
  // next to an open left-docked window (shared with the floating tool toolbar).
  const openWindowWidth = useLeftWindowWidth();
  const modeLeftOffset = ACTIVITY_BAR_WIDTH + (openWindowWidth > 0 ? openWindowWidth + 8 : 8);
  // A mode-locked (kiosk / single-purpose HMI like Mauser) workspace hides the
  // Play/Pause + Reset sim controls along with the mode dropdown — there is no
  // workspace to drive, only a fixed display.
  const { locked: modeLocked } = useMode();
  const hasSimControls = useSlot('toolbar-button-leading').length > 0 && !modeLocked;
  // Shift the floating camera cluster left of an open right-docked window
  // (e.g. the Layout Planner library) so it stays visible — same as the left.
  const rightWindowWidth = useRightWindowWidth();
  const camRightOffset = rightWindowWidth > 0 ? rightWindowWidth + 8 : 8;
  // Push the floating top-left cluster below the optional title bar when present.
  const topInset = useViewportInsets().top;

  return (
    <>
      {/* The top app bar was removed — the realvirtual logo now lives at the top
          of the left activity bar, window-openers live in the activity bar, and
          the sim/mode + camera/view controls float in the viewport corners
          (below). TopBar remains the HMI host for those floating clusters, the
          docked windows, and the modals. */}

      {/* Floating top-left cluster — workspace mode switcher + the sim-control
          action group (Play/Pause + Reset). Sits in the 3D viewport's top-left
          corner, just right of the activity bar's logo, and shifts right past an
          open left-docked window so it stays in the visible view. */}
      <Box
        sx={{
          position: 'fixed',
          top: topInset + FLOATING_TOP_MARGIN,
          left: { xs: 8, sm: modeLeftOffset },
          zIndex: 1200,
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          pointerEvents: 'none',
          '& > *': { pointerEvents: 'auto' },
        }}
      >
        <ModeDropdown />
        {/* Sim-control action group (Play/Pause + Reset) — renders the
            toolbar-button-leading slot as its own glassy pill. */}
        {hasSimControls && (
          <ActionGroupPill>
            <SlotRenderer slot="toolbar-button-leading" />
          </ActionGroupPill>
        )}
      </Box>

      {/* Floating BOTTOM-right cluster — separate camera / view action groups,
          each its own glassy pill (CAM bookmarks, HMI toggle, optional Groups,
          FPV). Shifts left of an open right-docked window so it stays visible.
          The orientation gizmo now owns the top-right corner. Hidden on mobile. */}
      <Box
        sx={{
          position: 'fixed',
          bottom: FLOATING_TOP_MARGIN,
          right: camRightOffset,
          zIndex: 1200,
          display: { xs: 'none', sm: 'flex' },
          alignItems: 'center',
          gap: 0.5,
          pointerEvents: 'none',
          '& > *': { pointerEvents: 'auto' },
        }}
      >
        <SlotRenderer slot="toolbar-button-trailing" />
        <ActionGroupPill>
          <CameraBookmarks />
          {/* Follow / Sit-On sit next to the camera bookmarks. Right-click drag
              for Sit-On look has no touch equivalent → desktop only. */}
          {!isMobileDevice() && (
            <>
              <ActionDivider />
              <FollowCamButton />
              <ActionDivider />
              <SitOnCamButton />
            </>
          )}
        </ActionGroupPill>
        <ActionGroupPill><HmiToggleButton /></ActionGroupPill>
        {viewer.groups && viewer.groups.groupCount > 0 && (
          <ActionGroupPill>
            <ActionSegment
              title="Toggle Groups panel"
              active={viewer.groupsOverlayOpen}
              onClick={() => viewer.toggleGroupsOverlay()}
              icon={<Layers />}
            />
          </ActionGroupPill>
        )}
        {/* VR/AR + First-Person share one action group. */}
        {(() => {
          const showVr = !isMobile;
          const showFpv = !isMobileDevice();
          if (!showVr && !showFpv) return null;
          return (
            <ActionGroupPill>
              {showVr && (
                <ActionSegment
                  title={vrOpen ? 'Close VR/AR' : 'VR / AR'}
                  active={vrOpen}
                  onClick={() => setVrOpen(!vrOpen)}
                  label="VR"
                />
              )}
              {showVr && showFpv && <ActionDivider />}
              {showFpv && <FpvBarButton />}
            </ActionGroupPill>
          );
        })()}
      </Box>

      {/* Hierarchy browser panel (disabled on mobile, hidden when settings open) */}
      {!isMobile && hierarchyOpen && !settingsOpen && <HierarchyBrowser viewer={viewer} />}

      {/* Property inspector — docked: requires hierarchy open; detached: independent */}
      {!isMobile && !settingsOpen && pluginState.showInspector && pluginState.selectedNodePath
        && (hierarchyOpen || localStorage.getItem('rv-inspector-detached') === 'true')
        && <PropertyInspector viewer={viewer} />}

      {/* Machine Control Panel */}
      <MachineControlPanel />

      {/* AAS detail floating panel */}
      <AasDetailPanel />

      {/* Slot-based overlay panels (Layout Planner, etc.) */}
      <SlotRenderer slot="overlay" />

      {/* VR/AR modal */}
      {vrOpen && <VRModal onClose={() => setVrOpen(false)} />}

      {/* Settings side panel (opened from the activity bar) */}
      {settingsOpen && (
        <SettingsPanel
          onClose={() => { plugin?.setSettingsOpen(false); lpm.close('settings'); }}
        />
      )}

      {/* Scene / Models panel (opened from the activity bar) */}
      {panelSnapshot.activePanel === 'scene' && sceneStore && (
        <SceneWindow
          store={sceneStore}
          onClose={() => lpm.close('scene')}
        />
      )}
    </>
  );
}

/* ─── VR/AR Modal ─── */

function VRModal({ onClose }: { onClose: () => void }) {
  const vrUrl = window.location.origin + window.location.pathname;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&bgcolor=121212&color=ffffff&data=${encodeURIComponent(vrUrl)}`;

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.5)',
        pointerEvents: 'auto',
      }}
      onClick={onClose}
    >
      <Paper
        elevation={12}
        sx={{ borderRadius: 2, width: 420, maxWidth: '95vw', p: { xs: 2.5, sm: 4 }, display: 'flex', flexDirection: 'column', gap: 2.5, alignItems: 'center', maxHeight: '90dvh', overflow: 'auto' }}
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <Typography variant="h6" sx={{ fontWeight: 700, color: '#4fc3f7' }}>
          VR / AR
        </Typography>

        <Box
          component="img"
          src={qrUrl}
          alt="QR Code"
          sx={{ width: 200, height: 200, borderRadius: 1, border: '1px solid rgba(255,255,255,0.1)' }}
        />

        <Typography variant="body2" sx={{ color: 'text.secondary', textAlign: 'center', lineHeight: 1.7 }}>
          Scan this QR code with your phone or enter the URL in your <strong style={{ color: '#fff' }}>Meta Quest</strong> browser.
        </Typography>

        <Box
          sx={{
            width: '100%',
            bgcolor: 'rgba(0,0,0,0.3)',
            borderRadius: 1,
            p: 1.5,
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            cursor: 'pointer',
            '&:hover': { bgcolor: 'rgba(79,195,247,0.1)' },
          }}
          onClick={() => navigator.clipboard.writeText(vrUrl)}
          title="Click to copy URL"
        >
          <Typography
            variant="body2"
            sx={{
              color: '#4fc3f7',
              fontFamily: 'monospace',
              fontSize: '0.85rem',
              flex: 1,
              textAlign: 'center',
              wordBreak: 'break-all',
              userSelect: 'all',
            }}
          >
            {vrUrl}
          </Typography>
          <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap' }}>
            COPY
          </Typography>
        </Box>

        <Box sx={{ width: '100%', borderTop: '1px solid rgba(255,255,255,0.08)', pt: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            How to start
          </Typography>
          <StepRow n={1} text="Put on your headset and open the browser" />
          <StepRow n={2} text="Enter the URL above or scan the QR code with your phone" />
          <StepRow n={3} text="Wait for the scene to load, then tap 'Enter VR'" />
        </Box>

        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
          WebXR requires WebGL renderer. WebGPU does not support VR/AR sessions.
        </Typography>
      </Paper>
    </Box>
  );
}

function StepRow({ n, text }: { n: number; text: string }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
      <Box sx={{
        width: 22, height: 22, borderRadius: '50%', bgcolor: 'rgba(79,195,247,0.15)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Typography variant="caption" sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 11 }}>{n}</Typography>
      </Box>
      <Typography variant="body2" sx={{ color: 'text.secondary', fontSize: 13 }}>{text}</Typography>
    </Box>
  );
}
