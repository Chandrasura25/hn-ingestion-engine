/**
 * Does the employer sponsor work visas? For candidates outside the job's country, an onsite
 * role that sponsors is as reachable as a worldwide-remote one.
 * Negatives are checked first: "no visa sponsorship" must never read as a yes.
 */
const NEGATIVE = [
  /\b(?:no|not|unable to|cannot|can't|can not|won't|will not|don't|do not|doesn't|does not|are not able to)\b[^.\n|]{0,30}\b(?:visa|sponsor)/i,
  /\bvisa sponsorship\s*(?::|-|—)?\s*(?:no|none|not available|n\/a|unavailable)\b/i,
  /\bwithout (?:visa )?sponsorship\b/i,
];

const POSITIVE = [
  /\bvisa sponsorship\b/i,
  // "sponsor work visas", "can sponsor a UK Skilled Worker visa"
  /\bsponsor(?:s|ing|ship)?\s+(?:an?\s+|the\s+|your\s+)?(?:[\w-]+\s+){0,3}visas?\b/i,
  // Header shorthand: "| VISA |", "Visa | Relocation", "VISA + relocation", "VISA possible"
  /(?:^|\|)\s*visas?\s*(?:\||$)/im,
  /\bvisas?\s*(?:\+|&|and\s+relocation|possible|ok\b|yes\b|available|provided)/i,
  /\bwill sponsor\b/i,
  /\bvisa (?:support|assistance|provided)\b/i,
  /\b(?:H-?1B|O-?1|blue card|skilled worker visa)\b(?:[^.\n|]{0,20})\b(?:sponsor|transfer|support)/i,
  /\bsponsor(?:ship)?\s+(?:available|provided|offered)\b/i,
];

export function detectVisaSponsorship(text: string): boolean | null {
  if (NEGATIVE.some((re) => re.test(text))) return false;
  if (POSITIVE.some((re) => re.test(text))) return true;
  return null;
}
