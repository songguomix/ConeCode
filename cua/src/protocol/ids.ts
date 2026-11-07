import { randomUUID } from 'node:crypto';

export type IdPrefix =
  | 'task'
  | 'run'
  | 'ses'
  | 'obs'
  | 'act'
  | 'ver'
  | 'evt'
  | 'art'
  | 'ckpt'
  | 'lease'
  | 'wf'
  | 'msg'
  | 'call';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${randomUUID()}`;
}

export function isId(value: unknown, prefix?: IdPrefix): boolean {
  if (typeof value !== 'string') return false;
  return prefix ? value.startsWith(`${prefix}_`) : /^[a-z]+_[0-9a-f-]{36}$/.test(value);
}

/** Fencing tokens only need to increase; they are never reused. */
export function newFencingToken(): number {
  return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}
