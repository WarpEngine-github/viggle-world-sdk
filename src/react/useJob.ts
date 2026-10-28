import { useCallback, useEffect, useRef, useState } from 'react';

import { isAbortError } from '../core/errors.js';
import type { SceneTask } from '../core/types.js';

/** `submitting` until the API accepts, `processing` while it runs, then `ready` or `failed`. */
export type JobPhase = 'idle' | 'submitting' | 'processing' | 'ready' | 'failed';

export interface JobState<T> {
  phase: JobPhase;
  /** The task being polled, once the API accepted it. */
  taskId: string | null;
  /** When the API accepted it (ms), for an elapsed-time readout: the API reports no progress. */
  startedAt: number | null;
  result: T | null;
  error: Error | null;
}

export interface JobHooks {
  signal: AbortSignal;
  onUpdate: (task: SceneTask) => void;
}

const IDLE: JobState<never> = { phase: 'idle', taskId: null, startedAt: null, result: null, error: null };

/**
 * One submit-then-poll task at a time, as React state. Starting a new run
 * stops polling the previous one (the API keeps running it); so does
 * unmounting.
 */
export function useJob<T, A extends unknown[]>(run: (hooks: JobHooks, ...args: A) => Promise<T>) {
  const [state, setState] = useState<JobState<T>>(IDLE);
  const abortRef = useRef<AbortController | null>(null);
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = useCallback(async (...args: A): Promise<T | null> => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const live = () => abortRef.current === ctl;
    setState({ ...IDLE, phase: 'submitting' });
    try {
      const result = await runRef.current({
        signal: ctl.signal,
        onUpdate: (task) => {
          if (!live()) return;
          setState((s) => (s.taskId === task.id
            ? s
            : { ...s, phase: 'processing', taskId: task.id, startedAt: task.createdAt || Date.now() }));
        },
      }, ...args);
      if (live()) setState((s) => ({ ...s, phase: 'ready', result }));
      return result;
    } catch (err) {
      if (isAbortError(err) || !live()) return null;
      const error = err instanceof Error ? err : new Error(String(err));
      setState((s) => ({ ...s, phase: 'failed', error }));
      return null;
    }
  }, []);

  /** Stop polling. The task itself keeps running on the API. */
  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => (s.phase === 'ready' || s.phase === 'failed' ? s : IDLE));
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  const busy = state.phase === 'submitting' || state.phase === 'processing';
  return { ...state, busy, start, cancel, reset };
}
