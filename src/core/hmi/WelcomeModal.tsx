// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Box, Paper, Typography, Button } from '@mui/material';
import SlideshowOutlinedIcon from '@mui/icons-material/SlideshowOutlined';
import ViewQuiltOutlinedIcon from '@mui/icons-material/ViewQuiltOutlined';
import GridViewOutlinedIcon from '@mui/icons-material/GridViewOutlined';
import { setWelcomeModalOpen } from './welcome-modal-store';
import { useCustomBranding } from './branding-store';

/** Primary use cases, shown as a compact list. */
const USE_CASES: Array<[string, string]> = [
  ['3D HMI & monitoring', 'live PLC dashboards in the browser'],
  ['Machine & maintenance info', 'documents, guides and drawings on 3D parts'],
  ['Product configuration', 'interactive configurators from a single GLB'],
  ['Sales & presales', 'share a live digital twin with one link'],
  ['Training', 'safe, interactive learning environments'],
];

/** Deep links to the two built-in demos (resolved against the deploy base path). */
const HMI_DEMO_HREF = `${import.meta.env.BASE_URL}?model=DemoRealvirtualWeb.glb`;
const PLANNER_DEMO_HREF = `${import.meta.env.BASE_URL}?scene=published:DemoPlanner&mode=planner`;

interface WelcomeModalProps {
  open: boolean;
  onClose: () => void;
  /** Optional: when supplied, a "Start Demo" button is rendered beside "Got it". */
  onStartDemo?: () => void;
}

export function WelcomeModal({ open, onClose, onStartDemo }: WelcomeModalProps) {
  // Track visibility in the welcome-modal-store so KioskPlugin can pause idle
  // detection while the modal blocks interaction. Cleanup on unmount sets false.
  useEffect(() => {
    setWelcomeModalOpen(open);
    return () => { setWelcomeModalOpen(false); };
  }, [open]);

  // Demo links only make sense on the public realvirtual demo. A customer deploy
  // sets custom branding, so we hide the demo shortcuts there.
  const custom = useCustomBranding();

  if (!open) return null;

  return createPortal(
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 10000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.6)',
        pointerEvents: 'auto',
      }}
      onClick={onClose}
    >
      <Paper
        elevation={12}
        sx={{
          borderRadius: 2,
          width: 520,
          maxWidth: '95vw',
          p: { xs: 2.5, sm: 4 },
          display: 'flex',
          flexDirection: 'column',
          gap: 2.5,
          maxHeight: '90dvh',
          overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Typography variant="h6" sx={{ fontWeight: 700, color: '#4fc3f7' }}>
          realvirtual WEB
        </Typography>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.45)', letterSpacing: 2, textTransform: 'uppercase', fontSize: 10, mt: -1 }}>
          Open. Light. Industrial. Anywhere.
        </Typography>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          A browser-based 3D HMI and digital-twin viewer for industrial automation —
          everything from a single GLB export, live in the browser. Use it for:
        </Typography>

        <Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          {USE_CASES.map(([label, desc]) => (
            <Typography key={label} component="li" variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.5 }}>
              <strong style={{ color: '#fff' }}>{label}</strong> &mdash; {desc}
            </Typography>
          ))}
        </Box>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          One link is all it takes. Share interactive 3D digital twins with operators,
          service technicians, sales teams, and customers — directly in the browser,
          on any device, no installation required.
          No cloud lock-in. Your data, your server.
        </Typography>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          Connect to real PLCs via WebSocket or MQTT. Attach documents, maintenance guides,
          and technical drawings directly to 3D components. Build product configurators,
          KPI dashboards, and training environments — all from a single GLB export.
        </Typography>

        {!custom && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <Typography variant="body2" sx={{ color: '#fff', fontWeight: 600 }}>
              Two demos to explore
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Button
                component="a"
                href={HMI_DEMO_HREF}
                variant="outlined"
                size="small"
                startIcon={<ViewQuiltOutlinedIcon />}
                data-testid="welcome-demo-hmi"
                sx={{ textTransform: 'none', fontWeight: 600, minWidth: 150, justifyContent: 'flex-start' }}
              >
                HMI Demo
              </Button>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Operate &amp; monitor a running line
              </Typography>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Button
                component="a"
                href={PLANNER_DEMO_HREF}
                variant="outlined"
                size="small"
                startIcon={<GridViewOutlinedIcon />}
                data-testid="welcome-demo-planner"
                sx={{ textTransform: 'none', fontWeight: 600, minWidth: 150, justifyContent: 'flex-start' }}
              >
                Planner Demo
              </Button>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                Build a layout from reusable library objects
              </Typography>
            </Box>
          </Box>
        )}

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          Open source under the <strong style={{ color: '#fff' }}>AGPL-3.0 license</strong>.
          Part of the{' '}
          <a href="https://realvirtual.io" target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'none' }}>
            realvirtual.io
          </a>{' '}
          industrial digital twin platform.
        </Typography>

        <Typography variant="body2" sx={{ color: 'text.secondary', lineHeight: 1.7 }}>
          <a href="https://github.com/game4automation/realvirtual-WEB" target="_blank" rel="noopener noreferrer" style={{ color: '#4fc3f7', textDecoration: 'none' }}>
            github.com/game4automation/realvirtual-WEB
          </a>
        </Typography>

        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)' }}>
          &copy; 2025 realvirtual GmbH
        </Typography>

        <Box sx={{ display: 'flex', justifyContent: onStartDemo ? 'space-between' : 'flex-end', mt: 1, gap: 1 }}>
          {onStartDemo && (
            <Button
              variant="contained"
              color="primary"
              size="small"
              startIcon={<SlideshowOutlinedIcon />}
              onClick={() => { onClose(); onStartDemo(); }}
              data-testid="welcome-start-demo"
              sx={{ textTransform: 'none', fontWeight: 600 }}
            >
              Start Demo
            </Button>
          )}
          <Button variant="contained" size="small" onClick={onClose} sx={{ textTransform: 'none', fontWeight: 600 }}>
            Got it
          </Button>
        </Box>
      </Paper>
    </Box>,
    document.body,
  );
}
