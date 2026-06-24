// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef, useCallback, useEffect, Fragment } from 'react';
import { Vector3 } from 'three';
import { Visibility, VisibilityOff, DirectionsWalk, PhotoCamera, PhotoCameraOutlined, GpsFixed, EventSeat } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import type { FpvPluginAPI, CameraFollowPluginAPI } from '../types/plugin-types';
import { loadVisualSettings, saveVisualSettings, type CameraBookmark } from './visual-settings-store';
import { toggleHmiVisible, useHmiVisible } from './hmi-visibility-store';
import { ActionSegment, ActionDivider } from './action-group';

const LONG_PRESS_MS = 500;
const FLASH_MS = 800;

/**
 * CameraBookmarks — the CAM 1/2/3 viewpoint bookmarks rendered as segments of a
 * shared action group (camera icon label + three CAM segments). Click to
 * restore, long-press to save. Shared with the Visual settings tab via
 * localStorage. Render inside an ActionGroupPill.
 */
export function CameraBookmarks() {
  const viewer = useViewer();
  const [cameras, setCameras] = useState<(CameraBookmark | null)[]>(() => loadVisualSettings().cameras);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);
  /** Index that was just saved — drives the green flash feedback */
  const [savedIdx, setSavedIdx] = useState<number | null>(null);

  const save = useCallback((idx: number) => {
    const state = viewer.getCameraState();
    const p = state.position;
    const t = state.target;
    const bm: CameraBookmark = { px: p.x, py: p.y, pz: p.z, tx: t.x, ty: t.y, tz: t.z };
    const next = [...cameras];
    next[idx] = bm;
    setCameras(next);
    const s = loadVisualSettings();
    s.cameras = next;
    saveVisualSettings(s);
    setSavedIdx(idx);
    setTimeout(() => setSavedIdx(null), FLASH_MS);
  }, [viewer, cameras]);

  const restore = useCallback((idx: number) => {
    const bm = cameras[idx];
    if (!bm) return;
    viewer.animateCameraTo(
      new Vector3(bm.px, bm.py, bm.pz),
      new Vector3(bm.tx, bm.ty, bm.tz),
    );
  }, [viewer, cameras]);

  const handlePointerDown = (idx: number) => {
    didLongPress.current = false;
    pressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      save(idx);
    }, LONG_PRESS_MS);
  };

  const handlePointerUp = (idx: number) => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    if (!didLongPress.current) {
      restore(idx);
    }
  };

  const handlePointerLeave = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  return (
    <>
      {[0, 1, 2].map((i) => {
        const isSaved = savedIdx === i;
        const hasBookmark = !!cameras[i];
        // Outlined camera = empty slot, filled camera = a view is saved here.
        const Icon = hasBookmark ? PhotoCamera : PhotoCameraOutlined;
        const color = isSaved ? '#66bb6a' : hasBookmark ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.42)';
        return (
          <Fragment key={i}>
            {i > 0 && <ActionDivider />}
            <ActionSegment
              title={hasBookmark ? `Camera ${i + 1} — Click: restore · Hold: save` : `Camera ${i + 1} — Hold to save current view`}
              color={color}
              icon={<Icon />}
              label={i + 1}
              buttonProps={{
                onPointerDown: () => handlePointerDown(i),
                onPointerUp: () => handlePointerUp(i),
                onPointerLeave: handlePointerLeave,
              }}
            />
          </Fragment>
        );
      })}
    </>
  );
}

/** HMI-visibility toggle (the "eye") as a single action-group segment. */
export function HmiToggleButton() {
  const hmiVisible = useHmiVisible();
  return (
    <ActionSegment
      title="Toggle HMI (H)"
      onClick={toggleHmiVisible}
      color={hmiVisible ? undefined : 'rgba(255,255,255,0.5)'}
      icon={hmiVisible ? <Visibility /> : <VisibilityOff />}
    />
  );
}

/** First-Person View toggle as a single action-group segment. The host decides
 *  whether to render it (hidden on touch devices). */
export function FpvBarButton() {
  const viewer = useViewer();
  const [active, setActive] = useState(false);
  useEffect(() => {
    const onEnter = () => setActive(true);
    const onExit = () => setActive(false);
    viewer.on('fpv-enter', onEnter);
    viewer.on('fpv-exit', onExit);
    return () => { viewer.off('fpv-enter', onEnter); viewer.off('fpv-exit', onExit); };
  }, [viewer]);
  const handleClick = () => {
    const plugin = viewer.getPlugin<FpvPluginAPI>('fpv');
    plugin?.toggle();
  };
  return (
    <ActionSegment
      title="First-Person View (F)"
      active={active}
      onClick={handleClick}
      icon={<DirectionsWalk />}
    />
  );
}

/** Hook: subscribe to the camera follow mode + whether the selection is followable. */
function useCameraFollowState(): { mode: 'follow' | 'siton' | null; canFollow: boolean } {
  const viewer = useViewer();
  const [mode, setMode] = useState<'follow' | 'siton' | null>(null);
  const [canFollow, setCanFollow] = useState(false);
  useEffect(() => {
    const plugin = () => viewer.getPlugin<CameraFollowPluginAPI>('camera-follow');
    const onMode = (e: { mode: 'follow' | 'siton' | null }) => setMode(e.mode);
    const onSel = () => setCanFollow(!!plugin()?.canFollow());
    viewer.on('camera-mode-changed', onMode);
    viewer.on('selection-changed', onSel);
    onSel(); // initial state
    return () => {
      viewer.off('camera-mode-changed', onMode);
      viewer.off('selection-changed', onSel);
    };
  }, [viewer]);
  return { mode, canFollow };
}

/** Follow toggle — the camera follows the selected moving part keeping the view distance. */
export function FollowCamButton() {
  const viewer = useViewer();
  const { mode, canFollow } = useCameraFollowState();
  return (
    <ActionSegment
      title="Follow selected part"
      active={mode === 'follow'}
      color={canFollow ? undefined : 'rgba(255,255,255,0.35)'}
      icon={<GpsFixed />}
      onClick={() => { if (canFollow) viewer.getPlugin<CameraFollowPluginAPI>('camera-follow')?.toggle('follow'); }}
    />
  );
}

/** Sit-On toggle — the camera rides on the selected part; right-drag to look around. */
export function SitOnCamButton() {
  const viewer = useViewer();
  const { mode, canFollow } = useCameraFollowState();
  return (
    <ActionSegment
      title="Sit on selected part (right-drag to look)"
      active={mode === 'siton'}
      color={canFollow ? undefined : 'rgba(255,255,255,0.35)'}
      icon={<EventSeat />}
      onClick={() => { if (canFollow) viewer.getPlugin<CameraFollowPluginAPI>('camera-follow')?.toggle('siton'); }}
    />
  );
}
