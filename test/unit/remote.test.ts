import { describe, expect, it } from 'vitest';
import { classifyRemote, openToNigeria } from '../../src/normalize/remote.js';

const c = (location: string | null, body = '') => classifyRemote(true, location, body);

describe('classifyRemote', () => {
  it.each([
    ['REMOTE (Worldwide)', 'worldwide'],
    ['Remote, anywhere', 'worldwide'],
    ['REMOTE worldwide', 'worldwide'],
    ['REMOTE (Worldwide: US timezone overlap)', 'worldwide'],
    ['REMOTE (US)', 'regional'],
    ['Remote, US only', 'regional'],
    ['REMOTE (EU)', 'regional'],
    ['Remote (EMEA)', 'regional'],
    ['Remote', 'unstated'],
  ])('%s → %s', (loc, scope) => {
    expect(c(loc).scope).toBe(scope);
  });

  it('does not read the pronoun "us" as the United States', () => {
    expect(c('Remote', 'Acme | Engineer | Remote\n\nCome work with us remotely!').scope).toBe('unstated');
  });

  it('only looks near the word "remote" in the body', () => {
    expect(c(null, 'Acme | Engineer | Remote\n\nOur HQ is in the US but you can be remote from Africa or Europe.').regions)
      .toEqual(expect.arrayContaining(['africa', 'europe']));
  });

  it('decides who can hire from Nigeria', () => {
    expect(openToNigeria(c('REMOTE (Worldwide)'))).toBe(true);
    expect(openToNigeria(c('Remote (EMEA)'))).toBe(true);
    expect(openToNigeria(c('Remote — Africa'))).toBe(true);
    expect(openToNigeria(c('REMOTE (US)'))).toBe(false);
    expect(openToNigeria(c('REMOTE (EU)'))).toBe(false);
    expect(openToNigeria(c('Remote'))).toBe(false);
  });

  it('is null for non-remote jobs', () => {
    expect(classifyRemote(false, 'NYC', '')).toEqual({ scope: null, regions: [] });
  });
});
