// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { ErrorStore } from '../src/core/engine/rv-error-store';

describe('ErrorStore', () => {
  it('adds an active error and lists it', () => {
    const s = new ErrorStore();
    s.setActive('A/B', true, 'Overtemp');
    expect(s.getActive().map(e => e.path)).toEqual(['A/B']);
    expect(s.getCount()).toBe(1);
    expect(s.getActive()[0].text).toBe('Overtemp');
  });

  it('removes error when signal goes low', () => {
    const s = new ErrorStore();
    s.setActive('A/B', true, 'x');
    s.setActive('A/B', false, 'x');
    expect(s.getActive()).toHaveLength(0);
    expect(s.getCount()).toBe(0);
  });

  it('remove(path) deletes the entry', () => {
    const s = new ErrorStore();
    s.setActive('A/B', true, 'x');
    s.remove('A/B');
    expect(s.getActive()).toHaveLength(0);
  });

  it('clear() empties all entries (model switch)', () => {
    const s = new ErrorStore();
    s.setActive('A/B', true, 'x');
    s.setActive('C/D', true, 'y');
    s.clear();
    expect(s.getActive()).toHaveLength(0);
    expect(s.getCount()).toBe(0);
  });

  it('getActive() is sorted by since (chronological)', () => {
    const s = new ErrorStore();
    s.setActive('first', true, 'x');
    s.setActive('second', true, 'y');
    expect(s.getActive().map(e => e.path)).toEqual(['first', 'second']);
  });

  it('dirty-check: no notify on unchanged setActive', () => {
    const s = new ErrorStore();
    let n = 0;
    s.subscribe(() => n++);
    s.setActive('A/B', true, 'x');   // change → notify
    const after = n;
    s.setActive('A/B', true, 'x');   // identical → NO notify
    expect(n).toBe(after);
  });

  it('notifies on text change while staying active', () => {
    const s = new ErrorStore();
    let n = 0;
    s.subscribe(() => n++);
    s.setActive('A/B', true, 'x');
    const after = n;
    s.setActive('A/B', true, 'y');   // text changed → notify
    expect(n).toBeGreaterThan(after);
    expect(s.getActive()[0].text).toBe('y');
  });

  it('dirty-check: no notify when removing an absent path', () => {
    const s = new ErrorStore();
    let n = 0;
    s.subscribe(() => n++);
    s.remove('nope');
    expect(n).toBe(0);
  });

  it('dirty-check: no notify when setting inactive on an absent path', () => {
    const s = new ErrorStore();
    let n = 0;
    s.subscribe(() => n++);
    s.setActive('nope', false, 'x');
    expect(n).toBe(0);
  });

  it('clear() does not notify when already empty', () => {
    const s = new ErrorStore();
    let n = 0;
    s.subscribe(() => n++);
    s.clear();
    expect(n).toBe(0);
  });

  it('notifies subscribers on real change', () => {
    const s = new ErrorStore();
    let n = 0;
    s.subscribe(() => n++);
    s.setActive('A/B', true, 'x');
    expect(n).toBeGreaterThan(0);
  });

  it('subscribe returns a working unsubscribe', () => {
    const s = new ErrorStore();
    let n = 0;
    const off = s.subscribe(() => n++);
    s.setActive('A/B', true, 'x');
    const after = n;
    off();
    s.setActive('C/D', true, 'y');
    expect(n).toBe(after);
  });
});
