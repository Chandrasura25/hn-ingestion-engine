/**
 * Where can you work from? "Remote" on HN very often means "remote within the US".
 * We classify the remote scope so candidates outside the US/EU can filter to jobs that
 * would actually hire them.
 */
export type RemoteScope = 'worldwide' | 'regional' | 'unstated';

export interface RemoteEligibility {
  scope: RemoteScope | null; // null = not a remote job
  regions: string[];
}

const WORLDWIDE =
  /\b(?:worldwide|world-wide|anywhere|globally|global(?: remote)?|international(?:ly)?|fully distributed|all time ?zones|any (?:country|location|time ?zone))\b/i;

const REGIONS: Array<[string, RegExp]> = [
  ['nigeria', /\b(?:nigeria|lagos|abuja)\b/i],
  ['africa', /\bafrica[n]?\b/i],
  ['emea', /\bEMEA\b/i],
  // Case-sensitive so the pronoun "us" ("contact us") doesn't count.
  ['us', /\bUS\b|\bU\.S\.|\bUSA\b|\bUS[- ](?:only|based|timezones?)\b|\bunited states\b|\bnorth america\b|\b(?:EST|PST|CST|ET|PT)\b/],
  ['us', /\bunited states\b|\bnorth america\b|\bus[- ]only\b|\bus[- ]based\b/i],
  ['canada', /\bcanada\b/i],
  ['latam', /\blatam\b|\blatin america\b|\bsouth america\b|\bamericas\b/i],
  ['europe', /\bEU\b|\bUK\b|\beurope(?:an)?\b|\bCET\b|\bCEST\b|\bGMT\b/],
  ['europe', /\beurope(?:an)?\b|\bunited kingdom\b/i],
  ['apac', /\bAPAC\b|\basia\b|\baustralia\b|\bindia\b|\bsingapore\b|\bnew zealand\b/i],
];

/** Regions that would accept a candidate based in Nigeria. */
export const NIGERIA_FRIENDLY = ['nigeria', 'africa', 'emea'];

export function classifyRemote(
  remote: boolean | null,
  location: string | null,
  body: string | null,
): RemoteEligibility {
  if (remote !== true) return { scope: null, regions: [] };

  // Only look where people describe remote policy: the location field, the header line,
  // and short windows around the word "remote". "Offices in NYC" elsewhere is irrelevant.
  const firstLine = body?.split('\n').find((l) => l.trim()) ?? '';
  const windows = [...(body ?? '').matchAll(/remote/gi)]
    .slice(0, 6)
    .map((m) => (body ?? '').slice(Math.max(0, m.index - 40), m.index + 80));
  const text = [location ?? '', firstLine, ...windows].join('\n');

  const regions = new Set<string>();
  for (const [region, re] of REGIONS) if (re.test(text)) regions.add(region);

  if (WORLDWIDE.test(text)) return { scope: 'worldwide', regions: [...regions] };
  if (regions.size) return { scope: 'regional', regions: [...regions] };
  return { scope: 'unstated', regions: [] };
}

export function openToNigeria(e: RemoteEligibility): boolean {
  return e.scope === 'worldwide' || e.regions.some((r) => NIGERIA_FRIENDLY.includes(r));
}
