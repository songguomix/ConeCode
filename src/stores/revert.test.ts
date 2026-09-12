import { describe, it, expect } from 'vitest';
import { reverseEdit } from './codeChanges.store';

describe('reverseEdit (revert of an applied edit)', () => {
  const original = 'function a() {}\nfunction b() { return 1; }\nfunction c() {}\n';
  const updated = 'function a() {}\nfunction b() { return 2; }\nfunction c() {}\n';

  it('restores the original snapshot when the file is untouched since apply', () => {
    expect(reverseEdit(updated, original, updated)).toBe(original);
  });

  it('is a no-op-safe restore when the file was already reverted externally', () => {
    // current === original: caller checks this first, but reverseEdit should
    // still behave sanely (the anchored region matches nothing changed).
    expect(reverseEdit(original, original, updated)).toBeNull();
  });

  it('undoes ONLY its own change when the file gained later edits elsewhere', () => {
    // A later edit changed function c — reverting the b edit must keep it.
    const later = updated.replace('function c() {}', 'function c() { return 3; }');
    const reverted = reverseEdit(later, original, updated);
    expect(reverted).toContain('function b() { return 1; }');
    expect(reverted).toContain('function c() { return 3; }');
  });

  it('refuses when the changed region was itself edited again', () => {
    // Blindly matching the tiny "2" delta would corrupt "return 42" into
    // "return 41" — the context anchor must make this fail instead.
    const conflicting = updated.replace('return 2', 'return 42');
    expect(reverseEdit(conflicting, original, updated)).toBeNull();
  });

  it('reverses a pure insertion', () => {
    const before = 'line1\nline2\nline3\n';
    const after = 'line1\nline2\ninserted\nline3\n';
    expect(reverseEdit(after, before, after)).toBe(before);
    // ...even with unrelated edits elsewhere in the file
    const later = after.replace('line1', 'LINE1');
    expect(reverseEdit(later, before, after)).toBe('LINE1\nline2\nline3\n');
  });

  it('reverses a pure deletion (re-inserts the removed text)', () => {
    const before = 'alpha\nremoved-part\nomega\n';
    const after = 'alpha\nomega\n';
    expect(reverseEdit(after, before, after)).toBe(before);
  });
});
