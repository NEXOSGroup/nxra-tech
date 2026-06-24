// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useMemo } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { IconButton, Tooltip } from '@mui/material';
import { VisibilityOff } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';

// Core HMI components
import { rvDarkTheme, createBrandedTheme } from './theme';
import { useCustomBranding } from './branding-store';
import { HMIShell, SlotRenderer } from './HMIShell';
import { TopBar } from './TopBar';
import { TitleBar } from './TitleBar';
import { KpiBar } from './KpiBar';
import { ActivityBar } from './ActivityBar';
import { ViewportFrame } from './ViewportFrame';
import { ButtonPanel } from './ButtonPanel';
import { MessagePanel } from './MessagePanel';
import { BottomBar } from './BottomBar';

import { loadVisualSettings } from './visual-settings-store';
import { useHmiVisible, toggleHmiVisible } from './hmi-visibility-store';
import { useUIVisible } from './ui-context-store';

// Generic tooltip system (replaces former DriveTooltip)
import { TooltipLayer } from './tooltip/TooltipLayer';
import { AnchoredPopover } from './AnchoredPopover';
import './IKTargetQuickEdit'; // self-registers the 'ik-target' popover content
import { tooltipRegistry } from './tooltip/tooltip-registry';
// Import tooltip content providers (triggers self-registration of content + data resolvers).
// Drive tooltip is NOT imported here — it's optional and lives in per-model plugin packs
// (DemoRealvirtualWeb side-effect-imports it). Side-effect-import the file from your
// own model plugin if you want the live drive HUD floating over the scene.
import './tooltip/PipeTooltipContent';
import './tooltip/TankTooltipContent';
import './tooltip/PumpTooltipContent';
import './tooltip/ProcessingUnitTooltipContent';
import './tooltip/MetadataTooltipContent';
import './tooltip/WebSensorTooltipContent';
import './tooltip/PdfTooltipSection';
// Generic PDF viewer bridge (self-registers as controller)
import './pdf-viewer-store';
// Generic info overlay bridge (self-registers as controller)
import './info-overlay-store';
// Generic controller replaces DriveTooltipController, PipelineTooltipController, MetadataTooltipController
import './tooltip/GenericTooltipController';
import { tooltipStore } from './tooltip/tooltip-store';
// Import custom field renderers to trigger self-registration
import './rv-metadata-field-renderer';
import './rv-ik-path-field-renderer';

// Context menu (plugin-extensible right-click / long-press menu)
import { ContextMenuLayer } from './ContextMenuLayer';
import { SetPositionDialog } from './SetPositionDialog';

// Generic Instruction Overlay (unified positional text/callout/banner primitive)
import { InstructionLayer } from './InstructionLayer';

// Annotation & Shared View overlays
import { AnnotationPanel } from './AnnotationPanel';
import { SharedViewBanner } from './SharedViewBanner';
import { GPUWarningBanner } from './GPUWarningBanner';
import { AnnotationEditModal } from './AnnotationEditModal';

// Measurement panel
import { MeasurementPanel } from './MeasurementPanel';

// Order Manager panel
import { OrderPanel } from '../../plugins/order-manager-plugin';

// Sensor History Panel (opens from pinned WebSensor tooltip "Show" button)
import { SensorHistoryPanel } from './SensorHistoryPanel';

// Connect panel (realvirtual CONNECT gateway)
import { ConnectPanel } from './ConnectPanel';



/** Apply persisted visual settings to the viewer on startup (batch — single recompile). */
function useApplyPersistedSettings() {
  const viewer = useViewer();
  useEffect(() => {
    const s = loadVisualSettings();
    viewer.applyVisualSettings(s);
  }, [viewer]);
}

/** Connect tooltip store to viewer for model-cleared cleanup. */
function useTooltipStoreConnection() {
  const viewer = useViewer();
  useEffect(() => {
    tooltipStore.connectViewer(viewer);
  }, [viewer]);
}

export function App() {
  useApplyPersistedSettings();
  useTooltipStoreConnection();
  const hmiVisible = useHmiVisible();
  const branding = useCustomBranding();

  // Build theme: apply custom branding colors if set
  const theme = useMemo(
    () => branding?.primaryColor || branding?.secondaryColor
      ? createBrandedTheme(branding.primaryColor, branding.secondaryColor)
      : rvDarkTheme,
    [branding?.primaryColor, branding?.secondaryColor],
  );

  // Context-aware visibility: each area declares its default hiddenIn rule.
  // These defaults can be overridden by settings.json `ui.visibilityOverrides`.
  const showKpiBar = useUIVisible('kpi-bar', { hiddenIn: ['fpv', 'planner', 'xr'] });
  const showTopBar = useUIVisible('top-bar', { hiddenIn: ['xr'] });
  // ButtonPanel stays visible in planner mode — the planner now contributes
  // its own grid/snap/drop toolbar buttons there (PlannerToolbarButtons.tsx).
  // FPV / XR remain in the hidden list because they own the entire viewport.
  const showActivityBar = useUIVisible('activity-bar', { hiddenIn: ['fpv', 'xr'] });
  const showButtonPanel = useUIVisible('button-panel', { hiddenIn: ['fpv', 'xr'] });
  const showMessagePanel = useUIVisible('message-panel', { hiddenIn: ['fpv', 'planner', 'xr'] });
  const showViewsSlot = useUIVisible('views-slot', { hiddenIn: ['fpv', 'planner', 'xr'] });

  return (
    <ThemeProvider theme={theme}>
      <HMIShell>
        {/* Confines the WebGL canvas to the central region (must run even when
            the HMI is hidden, to restore full-bleed). */}
        <ViewportFrame />
        <TooltipLayer />
        <AnchoredPopover />
        <SensorHistoryPanel />
        <ContextMenuLayer />
        <InstructionLayer />
        <SetPositionDialog />
        {hmiVisible && branding?.titleBar && <TitleBar />}
        {hmiVisible && showKpiBar && <KpiBar />}
        {hmiVisible && showTopBar && <TopBar />}
        {hmiVisible && showActivityBar && <ActivityBar />}
        {hmiVisible && showButtonPanel && <ButtonPanel />}
        {hmiVisible && showMessagePanel && <MessagePanel />}
        <BottomBar />
        {hmiVisible && showViewsSlot && <SlotRenderer slot="views" />}
        <SharedViewBanner />
        <GPUWarningBanner />
        {hmiVisible && <AnnotationPanel />}
        {hmiVisible && <MeasurementPanel />}
        {hmiVisible && <OrderPanel />}
        {hmiVisible && <ConnectPanel />}
        <AnnotationEditModal />
        {/* When the HMI is hidden, the eye toggle in the top bar's right
            region is gone too — keep a minimal always-present restore control
            so touch users (no 'H' key) can bring the HMI back. */}
        {!hmiVisible && <HmiRestoreButton />}
      </HMIShell>
      {tooltipRegistry.getControllers().map((ctrl, i) => {
        const C = ctrl.component;
        return <C key={i} />;
      })}
    </ThemeProvider>
  );
}

/** Minimal restore affordance shown only while the HMI is hidden — a single
 *  eye button in the top-right corner that toggles the full HMI back on. */
function HmiRestoreButton() {
  return (
    <Tooltip title="Show HMI (H)" placement="left">
      <IconButton
        onClick={toggleHmiVisible}
        sx={{
          position: 'fixed', top: 8, right: 8, zIndex: 9001,
          bgcolor: 'rgba(20,20,20,0.85)', backdropFilter: 'blur(8px)',
          color: 'rgba(255,255,255,0.85)',
          '&:hover': { bgcolor: 'rgba(40,40,40,0.95)' },
        }}
      >
        <VisibilityOff fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}
