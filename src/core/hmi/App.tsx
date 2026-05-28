// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect, useMemo } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import { useViewer } from '../../hooks/use-viewer';

// Core HMI components
import { rvDarkTheme, createBrandedTheme } from './theme';
import { useCustomBranding } from './branding-store';
import { HMIShell, SlotRenderer } from './HMIShell';
import { TopBar } from './TopBar';
import { KpiBar } from './KpiBar';
import { ButtonPanel } from './ButtonPanel';
import { MessagePanel } from './MessagePanel';
import { BottomBar } from './BottomBar';

import { loadVisualSettings } from './visual-settings-store';
import { useHmiVisible } from './hmi-visibility-store';
import { useUIVisible } from './ui-context-store';

// Generic tooltip system (replaces former DriveTooltip)
import { TooltipLayer } from './tooltip/TooltipLayer';
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
// Import metadata field renderer to trigger self-registration
import './rv-metadata-field-renderer';

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
  const showButtonPanel = useUIVisible('button-panel', { hiddenIn: ['fpv', 'xr'] });
  const showMessagePanel = useUIVisible('message-panel', { hiddenIn: ['fpv', 'planner', 'xr'] });
  const showViewsSlot = useUIVisible('views-slot', { hiddenIn: ['fpv', 'planner', 'xr'] });

  return (
    <ThemeProvider theme={theme}>
      <HMIShell>
        <TooltipLayer />
        <SensorHistoryPanel />
        <ContextMenuLayer />
        <InstructionLayer />
        <SetPositionDialog />
        {hmiVisible && showKpiBar && <KpiBar />}
        {hmiVisible && showTopBar && <TopBar />}
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
      </HMIShell>
      {tooltipRegistry.getControllers().map((ctrl, i) => {
        const C = ctrl.component;
        return <C key={i} />;
      })}
    </ThemeProvider>
  );
}
