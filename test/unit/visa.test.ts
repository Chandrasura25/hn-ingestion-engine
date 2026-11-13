import { describe, expect, it } from 'vitest';
import { detectVisaSponsorship } from '../../src/normalize/visa.js';

describe('detectVisaSponsorship', () => {
  it.each([
    'Acme | Backend Engineer | Berlin | Full-time | Visa sponsorship | https://acme.dev',
    'We will sponsor visas and help with relocation.',
    'Visa sponsorship available',
    'Visa sponsorship: yes',
    'We sponsor work visas for strong candidates',
    'H-1B transfer and sponsorship supported',
    'Relocation + visa support provided',
    'Mesmer (YC P25) | Founding Engineer | Berlin | ONSITE | VISA + relocation | €100–140k',
    'Flow Traders | Research Engineer | Hong Kong | Full Time | Visa | Relocation',
    'ChainSecurity | Security Engineer | Zurich | VISA possible (for an employment) | https://x.com',
    'For exceptional candidates we can sponsor a UK Skilled Worker visa.',
  ])('detects sponsorship in "%s"', (text) => {
    expect(detectVisaSponsorship(text)).toBe(true);
  });

  it.each([
    'No visa sponsorship',
    'Unfortunately we cannot sponsor visas at this time.',
    'We are unable to offer visa sponsorship',
    'Visa sponsorship: No',
    "We don't sponsor",
    'Must be authorized to work in the US without sponsorship',
  ])('detects a refusal in "%s"', (text) => {
    expect(detectVisaSponsorship(text)).toBe(false);
  });

  it('returns null when visas are not mentioned', () => {
    expect(detectVisaSponsorship('Acme | Engineer | NYC | Onsite')).toBeNull();
  });
});
