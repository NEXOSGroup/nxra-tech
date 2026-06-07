// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef } from 'react';
import { Typography, Box, Switch, Slider, Select, MenuItem, type SelectChangeEvent } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { loadVisualSettings, saveVisualSettings, type VisualSettings } from '../visual-settings-store';
import { ENVIRONMENT_PRESETS, matchEnvironmentPreset, markEnvironmentUserModified, type EnvironmentPresetName } from '../environment-presets';

export function EnvironmentTab() {
  const viewer = useViewer();
  const settingsRef = useRef(loadVisualSettings());

  const [bgBright, setBgBright] = useState<number>(settingsRef.current.backgroundBrightness);
  const [groundOn, setGroundOn] = useState<boolean>(settingsRef.current.groundEnabled);
  const [groundBright, setGroundBright] = useState<number>(settingsRef.current.groundBrightness);
  const [groundColor, setGroundColor] = useState<string>(settingsRef.current.groundColor);
  const [contrast, setContrast] = useState<number>(settingsRef.current.checkerContrast);
  const [reflectionOn, setReflectionOn] = useState<boolean>(settingsRef.current.reflectionEnabled);
  const [reflectionStrength, setReflectionStrength] = useState<number>(settingsRef.current.reflectionStrength);
  const [reflectionBlur, setReflectionBlur] = useState<number>(settingsRef.current.reflectionBlur);

  const persist = (patch: Partial<VisualSettings>) => {
    Object.assign(settingsRef.current, patch);
    saveVisualSettings(settingsRef.current);
  };

  const applyPreset = (e: SelectChangeEvent<string>) => {
    const name = e.target.value as EnvironmentPresetName;
    const preset = ENVIRONMENT_PRESETS[name];
    if (!preset) return;
    const floorColor = preset.floorColor ?? '#ffffff';
    viewer.backgroundBrightness = preset.background;
    // Set color before brightness so the combine recomputes once with both inputs.
    viewer.groundColor = floorColor;
    viewer.groundBrightness = preset.floor;
    viewer.checkerContrast = preset.contrast;
    setBgBright(preset.background);
    setGroundBright(preset.floor);
    setGroundColor(floorColor);
    setContrast(preset.contrast);
    persist({
      backgroundBrightness: preset.background,
      groundBrightness: preset.floor,
      groundColor: floorColor,
      checkerContrast: preset.contrast,
    });
  };

  const currentPreset = matchEnvironmentPreset(bgBright, groundBright, contrast, groundColor);

  const updateBgBright = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.backgroundBrightness = val;
    setBgBright(val);
    persist({ backgroundBrightness: val });
    markEnvironmentUserModified();
  };

  const updateGroundOn = (_: unknown, v: boolean) => {
    viewer.groundEnabled = v;
    setGroundOn(v);
    persist({ groundEnabled: v });
    markEnvironmentUserModified();
  };

  const updateGroundBright = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.groundBrightness = val;
    setGroundBright(val);
    persist({ groundBrightness: val });
    markEnvironmentUserModified();
  };

  const updateGroundColor = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    viewer.groundColor = val;
    setGroundColor(val);
    persist({ groundColor: val });
    markEnvironmentUserModified();
  };

  const updateContrast = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.checkerContrast = val;
    setContrast(val);
    persist({ checkerContrast: val });
    markEnvironmentUserModified();
  };

  const updateReflectionOn = (_: unknown, v: boolean) => {
    viewer.reflectionEnabled = v;
    setReflectionOn(v);
    persist({ reflectionEnabled: v });
    markEnvironmentUserModified();
  };

  const updateReflectionStrength = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.reflectionStrength = val;
    setReflectionStrength(val);
    persist({ reflectionStrength: val });
    markEnvironmentUserModified();
  };

  const updateReflectionBlur = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.reflectionBlur = val;
    setReflectionBlur(val);
    persist({ reflectionBlur: val });
    markEnvironmentUserModified();
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      {/* Preset */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Preset
        </Typography>
        <Select
          size="small"
          fullWidth
          value={currentPreset === 'Custom' ? '' : currentPreset}
          displayEmpty
          onChange={applyPreset}
          renderValue={(v) => (v ? (v as string) : currentPreset)}
          sx={{ mt: 0.5 }}
        >
          {Object.keys(ENVIRONMENT_PRESETS).map((name) => (
            <MenuItem key={name} value={name}>{name}</MenuItem>
          ))}
        </Select>
      </Box>

      {/* Background */}
      <Box>
        <Typography variant="body2" sx={{ color: 'text.primary' }}>Background</Typography>
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            Background Brightness
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
            <Slider size="small" min={0} max={2} step={0.05} value={bgBright} onChange={updateBgBright} sx={{ flex: 1 }} />
            <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
              {bgBright.toFixed(2)}
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Floor / Ground Plane */}
      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.primary' }}>Floor</Typography>
          <Switch size="small" checked={groundOn} onChange={updateGroundOn} />
        </Box>
        {groundOn && (
          <>
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                Floor Brightness
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                <Slider size="small" min={0} max={2} step={0.05} value={groundBright} onChange={updateGroundBright} sx={{ flex: 1 }} />
                <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                  {groundBright.toFixed(2)}
                </Typography>
              </Box>
            </Box>
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                Floor Color
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                <Box
                  component="input"
                  type="color"
                  value={groundColor}
                  onChange={updateGroundColor}
                  sx={{
                    flex: 1,
                    height: 28,
                    p: 0,
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 0.5,
                    bgcolor: 'transparent',
                    cursor: 'pointer',
                  }}
                />
                <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 64, textAlign: 'right' }}>
                  {groundColor.toUpperCase()}
                </Typography>
              </Box>
            </Box>
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                Checker Contrast
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                <Slider size="small" min={0} max={2} step={0.05} value={contrast} onChange={updateContrast} sx={{ flex: 1 }} />
                <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                  {contrast.toFixed(2)}
                </Typography>
              </Box>
            </Box>
            <Box sx={{ mt: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                Reflection
              </Typography>
              <Switch size="small" checked={reflectionOn} onChange={updateReflectionOn} />
            </Box>
            {reflectionOn && (
              <Box sx={{ mt: 1 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                  Reflection Strength
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                  <Slider size="small" min={0} max={1} step={0.05} value={reflectionStrength} onChange={updateReflectionStrength} sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                    {reflectionStrength.toFixed(2)}
                  </Typography>
                </Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1, mt: 1, display: 'block' }}>
                  Reflection Blur
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                  <Slider size="small" min={0} max={1} step={0.05} value={reflectionBlur} onChange={updateReflectionBlur} sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                    {reflectionBlur.toFixed(2)}
                  </Typography>
                </Box>
              </Box>
            )}
          </>
        )}
      </Box>
    </Box>
  );
}
