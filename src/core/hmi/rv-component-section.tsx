// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-section.tsx — Collapsible component section for the Property Inspector.
 *
 * Groups fields by component type (Drive, Sensor, etc.) with a colored header,
 * consumedOnly filter support, and per-component reset.
 */

import { useState, useMemo, useCallback } from 'react';
import {
  Box,
  Typography,
  Tooltip,
  Button,
} from '@mui/material';
import { ExpandMore, ChevronRight } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import { getConsumedFields } from '../engine/rv-extras-validator';
import { getFieldDescriptor } from '../engine/rv-component-registry';
import {
  baseComponentType,
  classifyField,
  componentColor,
  getSignalHeaderColor,
  inferFieldType,
  isComponentRef,
  isScriptableObject,
  isFieldHidden,
} from './rv-inspector-helpers';
import { flattenObjectFields } from './rv-field-editors';
import { FieldRow } from './rv-field-row';
import { fieldRendererRegistry } from './rv-field-renderer-registry';
import { componentActionRegistry, type ComponentActionContext } from './rv-component-action-registry';

// ── Expand state persistence (default: expanded) ────────────────────────

const LS_KEY_COLLAPSED = 'rv-inspector-collapsed';
const LS_KEY_SECTION_COLLAPSED = 'rv-inspector-section-collapsed';

/** Module-level caches to avoid re-parsing localStorage on every toggle. */
let _collapsedCache: Set<string> | null = null;
let _sectionCollapsedCache: Set<string> | null = null;

function loadSet(storageKey: string, cacheRef: 'other' | 'section'): Set<string> {
  if (cacheRef === 'other' && _collapsedCache) return _collapsedCache;
  if (cacheRef === 'section' && _sectionCollapsedCache) return _sectionCollapsedCache;
  let set: Set<string>;
  try {
    const raw = localStorage.getItem(storageKey);
    set = raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    set = new Set();
  }
  if (cacheRef === 'other') _collapsedCache = set;
  else _sectionCollapsedCache = set;
  return set;
}

function persistSet(storageKey: string, set: Set<string>): void {
  localStorage.setItem(storageKey, JSON.stringify([...set]));
}

function loadCollapsedSet(): Set<string> {
  return loadSet(LS_KEY_COLLAPSED, 'other');
}

function persistCollapsed(key: string, collapsed: boolean): void {
  const set = loadCollapsedSet();
  if (collapsed) set.add(key); else set.delete(key);
  persistSet(LS_KEY_COLLAPSED, set);
}

function loadSectionCollapsedSet(): Set<string> {
  return loadSet(LS_KEY_SECTION_COLLAPSED, 'section');
}

function persistSectionCollapsed(key: string, collapsed: boolean): void {
  const set = loadSectionCollapsedSet();
  if (collapsed) set.add(key); else set.delete(key);
  persistSet(LS_KEY_SECTION_COLLAPSED, set);
}

/** Stable empty-actions array — shared by every section without registered actions. */
const EMPTY_ACTIONS: readonly import('./rv-component-action-registry').ComponentAction[] = Object.freeze([]);

// ── ComponentSection ─────────────────────────────────────────────────────

export interface ComponentSectionProps {
  nodePath: string;
  componentType: string;
  data: Record<string, unknown>;
  overriddenFields: Set<string>;
  consumedOnly: boolean;
  signalValue?: string | null;
  /** Optional action element rendered in the component header (e.g. "Open AAS" button). */
  headerAction?: React.ReactNode;
  /** Optional extra content rendered inside the expanded card, below the field rows (e.g. BehaviorLiveStateSections). */
  extraContent?: React.ReactNode;
  onFieldEdit: (fieldName: string, value: unknown) => void;
  onFieldReset: (fieldName: string) => void;
  onResetComponent: () => void;
  viewer: RVViewer | null;
  signalStore: SignalStore | null;
}

export function ComponentSection({ nodePath, componentType, data, overriddenFields, consumedOnly, signalValue, headerAction, extraContent, onFieldEdit, onFieldReset, onResetComponent, viewer, signalStore }: ComponentSectionProps) {
  const color = componentColor(componentType);
  const base = baseComponentType(componentType);
  const expandKey = `${nodePath}:${componentType}`;
  const [showOther, setShowOther] = useState(() => !loadCollapsedSet().has(expandKey));
  const [sectionExpanded, setSectionExpanded] = useState(() => !loadSectionCollapsedSet().has(expandKey));

  const toggleOther = useCallback(() => {
    setShowOther(prev => {
      const next = !prev;
      persistCollapsed(expandKey, !next);
      return next;
    });
  }, [expandKey]);

  const toggleSection = useCallback(() => {
    setSectionExpanded(prev => {
      const next = !prev;
      persistSectionCollapsed(expandKey, !next);
      return next;
    });
  }, [expandKey]);

  /**
   * Flatten entries: if a value is a non-ref, non-vector3 object/array,
   * expand it into sub-field rows (e.g. Status.Connected, Status.Value).
   * This way objects like Status render as regular grayed-out field rows.
   */
  const flattenEntries = useCallback((entries: [string, unknown][]): [string, unknown][] => {
    const result: [string, unknown][] = [];
    for (const [key, value] of entries) {
      const ft = inferFieldType(key, value);
      if (ft === 'object' && !isComponentRef(value) && !isScriptableObject(value)) {
        // Flatten object/array sub-fields into regular rows
        const flat = flattenObjectFields(value as Record<string, unknown> | unknown[], key);
        for (const f of flat) result.push([f.key, f.value]);
      } else {
        result.push([key, value]);
      }
    }
    return result;
  }, []);

  // Separate consumed fields (editable) from non-consumed (read-only)
  const { consumedEntries, otherEntries } = useMemo(() => {
    const consumed = new Set(getConsumedFields(base));
    const consumedRaw: [string, unknown][] = [];
    const otherRaw: [string, unknown][] = [];

    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith('_')) continue;
      if (isFieldHidden(base, key)) continue;
      // A readonly schema field renders its value but never an editor → route it
      // into the read-only ("other") branch rather than the consumed/editable one.
      const isReadonly = getFieldDescriptor(base, key)?.readonly === true;
      if (consumed.has(key) && !isReadonly) {
        consumedRaw.push([key, value]);
      } else {
        otherRaw.push([key, value]);
      }
    }

    // Consumed entries keep objects as-is (editable ObjectEditor handles them)
    // Other entries flatten objects into sub-field rows
    return { consumedEntries: consumedRaw, otherEntries: flattenEntries(otherRaw) };
  }, [base, data, flattenEntries]);

  // Action buttons contributed by plugins for this component type. Re-resolved
  // on every render — the registry is small and lookups are O(1); this keeps
  // visibility/isActive snappy without a separate tick-mechanism.
  const actions = useMemo(() => {
    // Look up by both the literal componentType (e.g. "ReplayRecording_1")
    // and its stripped base (e.g. "ReplayRecording") so plugins can register
    // against either form. Concrete-first lets a per-instance override beat
    // a generic base registration, should we ever ship one.
    const concrete = componentActionRegistry.get(componentType);
    const baseList = base !== componentType ? componentActionRegistry.get(base) : EMPTY_ACTIONS;
    return [...concrete, ...baseList];
  }, [componentType, base]);

  // Re-evaluation tick — `isActive` reads from `node.userData`, which the
  // action mutates synchronously. React doesn't see that change on its own
  // (no state subscription), so we bump a local counter on every click to
  // force isActive() to re-run for the icon's active/outlined style.
  // Re-render is local to this section.
  const [actionTick, setActionTick] = useState(0);

  const actionCtx = useMemo<ComponentActionContext | null>(() => {
    if (!viewer || actions.length === 0) return null;
    const node = viewer.registry?.getNode(nodePath);
    if (!node) return null;
    return { node, nodePath, viewer, componentData: data };
    // actionTick is intentionally in deps so the ctx identity changes on
    // click — drives the actions.map() loop to re-evaluate isActive().
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, nodePath, data, actions.length, actionTick]);

  return (
    <Box>
      {/* Component type header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: 0.375,
          bgcolor: color + '11',
          borderBottom: `1px solid ${color}22`,
          borderTop: `1px solid ${color}22`,
        }}
      >
        <Box
          onClick={toggleSection}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 0.25,
            cursor: 'pointer',
            userSelect: 'none',
            '&:hover .rv-comp-title': { textDecoration: 'underline' },
          }}
        >
          {sectionExpanded
            ? <ExpandMore sx={{ fontSize: 14, color: color }} />
            : <ChevronRight sx={{ fontSize: 14, color: color }} />}
          <Typography
            className="rv-comp-title"
            sx={{
              fontSize: 10,
              fontWeight: 700,
              color: color,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            {componentType}
          </Typography>
        </Box>
        {signalValue != null && (
          <Typography
            sx={{
              fontSize: 10,
              fontWeight: 600,
              fontFamily: 'monospace',
              ml: 'auto',
              color: getSignalHeaderColor(componentType, String(signalValue)),
            }}
          >
            {signalValue}
          </Typography>
        )}
        {headerAction}
        {overriddenFields.size > 0 && (
          <Tooltip title="Click to reset all overrides for this component" placement="top">
            <Typography
              onClick={(e) => { e.stopPropagation(); onResetComponent(); }}
              sx={{
                fontSize: 9,
                color: '#4fc3f7',
                ml: 'auto',
                cursor: 'pointer',
                '&:hover': { color: '#ffa726', textDecoration: 'underline' },
              }}
            >
              {overriddenFields.size} override{overriddenFields.size !== 1 ? 's' : ''}
            </Typography>
          </Tooltip>
        )}
      </Box>

      {/* Consumed (editable) fields */}
      {sectionExpanded && consumedEntries.map(([fieldName, value]) => {
        // Check for a custom field renderer plugin
        const CustomRenderer = fieldRendererRegistry.getRenderer(componentType, fieldName);
        if (CustomRenderer) {
          return (
            <CustomRenderer
              key={fieldName}
              value={value}
              fieldName={fieldName}
              componentType={componentType}
              nodePath={nodePath}
              viewer={viewer}
              signalStore={signalStore}
            />
          );
        }
        return (
          <FieldRow
            key={fieldName}
            fieldName={fieldName}
            value={value}
            status="consumed"
            isOverridden={overriddenFields.has(fieldName)}
            onEdit={(v) => onFieldEdit(fieldName, v)}
            onReset={() => onFieldReset(fieldName)}
            viewer={viewer}
            signalStore={signalStore}
            descriptor={getFieldDescriptor(base, fieldName)}
          />
        );
      })}

      {/* Action buttons contributed by plugins (e.g. Splat Invert X/Y/Z,
          Drive Jog, Sensor Reset). Rendered between consumed fields and the
          collapsible "other fields" section so they sit visually with the
          editable area, not with the diagnostic dump.
          Styling: theme primary accent — intentionally NOT the component's
          own color, so the buttons read consistently across all sections and
          stand out from the section's text/header tint. */}
      {sectionExpanded && actions.length > 0 && actionCtx && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 0.5, px: 1, py: 0.5 }}>
          {actions.map((action) => {
            // Per-render visibility check — lets plugins hide actions based
            // on node state (e.g. "Stop" only when running).
            if (action.visible && !action.visible(actionCtx)) return null;
            const active = action.isActive ? action.isActive(actionCtx) : false;
            const Icon = action.icon;
            const button = (
              <Button
                key={action.id}
                size="small"
                // Explicit `color` overrides the theme primary — used by
                // axis-coded buttons (Splat Invert X/Y/Z = red/green/blue
                // to match Three.js axis convention). Falls back to MUI's
                // theme primary when not specified.
                color={action.color ? undefined : 'primary'}
                variant={active ? 'contained' : 'outlined'}
                onClick={() => {
                  action.onClick(actionCtx);
                  // Immediately re-evaluate isActive — the action mutated
                  // userData synchronously, but React has no way to notice
                  // without our nudge.
                  setActionTick(t => t + 1);
                }}
                startIcon={Icon ? <Icon sx={{ fontSize: 14 }} /> : undefined}
                sx={{
                  minWidth: 0,
                  height: 24,
                  px: 0.75,
                  py: 0,
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: 'none',
                  // Custom color path — overrides MUI's color prop. Active
                  // = filled (contained), inactive = outlined; hover
                  // brightens proportionally.
                  ...(action.color ? {
                    color: active ? '#fff' : action.color,
                    bgcolor: active ? action.color : 'transparent',
                    borderColor: action.color,
                    '&:hover': {
                      bgcolor: active ? action.color : action.color + '22',
                      borderColor: action.color,
                    },
                  } : {}),
                }}
              >
                {action.label ?? action.id}
              </Button>
            );
            return action.tooltip
              ? <Tooltip key={action.id} title={action.tooltip} placement="top">{button}</Tooltip>
              : button;
          })}
        </Box>
      )}

      {/* Collapsible other (read-only) fields — hidden when consumedOnly is active */}
      {sectionExpanded && !consumedOnly && otherEntries.length > 0 && (
        <>
          <Box
            onClick={toggleOther}
            sx={{
              display: 'flex',
              alignItems: 'center',
              px: 1,
              py: 0.125,
              cursor: 'pointer',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.02)' },
            }}
          >
            <ExpandMore sx={{
              fontSize: 12,
              color: 'text.disabled',
              transform: showOther ? 'rotate(0deg)' : 'rotate(-90deg)',
              transition: 'transform 0.15s',
            }} />
            <Typography sx={{ fontSize: 9, color: 'text.disabled', ml: 0.25 }}>
              {otherEntries.length} more field{otherEntries.length !== 1 ? 's' : ''}
            </Typography>
          </Box>
          {showOther && otherEntries.map(([fieldName, value]) => (
            <FieldRow
              key={fieldName}
              fieldName={fieldName}
              value={value}
              status={classifyField(componentType, fieldName)}
              isOverridden={overriddenFields.has(fieldName)}
              onEdit={(v) => onFieldEdit(fieldName, v)}
              onReset={() => onFieldReset(fieldName)}
              viewer={viewer}
              signalStore={signalStore}
              descriptor={getFieldDescriptor(base, fieldName)}
            />
          ))}
        </>
      )}

      {sectionExpanded && extraContent}
    </Box>
  );
}
