import timingSafeEquals from '../../src/utils/timing-safe-equals';

describe('timingSafeEquals', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEquals('secret', 'secret')).toBe(true);
  });

  it('returns false for different strings with the same length', () => {
    expect(timingSafeEquals('secret', 'secres')).toBe(false);
  });

  it('returns false instead of throwing for different lengths', () => {
    expect(() => timingSafeEquals('secret', 'short')).not.toThrow();
    expect(timingSafeEquals('secret', 'short')).toBe(false);
  });

  it('returns false for missing or empty values', () => {
    expect(timingSafeEquals(undefined, 'secret')).toBe(false);
    expect(timingSafeEquals('secret', undefined)).toBe(false);
    expect(timingSafeEquals('', 'secret')).toBe(false);
    expect(timingSafeEquals('secret', '')).toBe(false);
  });
});
