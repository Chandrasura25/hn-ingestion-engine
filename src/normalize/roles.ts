export const ROLE_TAGS = ['founding', 'backend', 'fullstack', 'frontend', 'ai', 'software'] as const;
export type RoleTag = (typeof ROLE_TAGS)[number];

const PATTERNS: Array<[RoleTag, RegExp]> = [
  // "founding team"/"founding story" in prose is not a founding-engineer role.
  ['founding', /\bfounding (?:[\w+-]+ ){0,2}(?:engineers?|developers?|engineering|cto|hire)\b|\bfirst (?:engineer|engineering hire|technical hire)\b|\bengineer #\s?1\b/i],
  ['fullstack', /\bfull[- ]?stack\b/i],
  ['backend', /\bback[- ]?end\b|\bserver[- ]side\b|\b(?:platform|infrastructure|infra|api|distributed systems|data|systems) (?:engineer|developer)s?\b/i],
  ['frontend', /\bfront[- ]?end\b|\b(?:ui|web|react|mobile|ios|android) (?:engineer|developer)s?\b/i],
  ['ai', /\b(?:ai|ml|llm|genai|agentic|machine learning|applied ai|deep learning)(?:\/ml)? (?:[\w+-]+ )?(?:engineer|developer|researcher|scientist)s?\b|\b(?:engineer|developer)s? \((?:ai|ml|llm)\)|\bai engineering\b/i],
  ['software', /\b(?:software|product|founding|staff|senior|principal|lead|swe|forward deployed) (?:engineer|developer)s?\b|\bswe\b|\bsoftware engineering\b/i],
];
/** Bare "engineer"/"developer" only counts in the header, not in prose like "our team of engineers". */
const GENERIC_DEV = /\b(?:developers?|engineers?|programmers?)\b/i;

/** Things that contain "engineer"/"developer" but aren't dev jobs we want. */
const NON_DEV = /\b(?:sales|solutions|support|field|hardware|mechanical|electrical|civil|chemical|manufacturing|asic|fpga|rf|test|qa|developer relations|devrel|business development)\b(?: \w+)? engineers?\b|\bbusiness developer\b/gi;

/**
 * Tags a job with role categories. Looks at the parsed role, the title, and the top of the
 * post (where HN posters list openings), not the whole body: a "we use React" line deep in
 * the description shouldn't make a backend role "frontend".
 */
export function classifyRoles(role: string | null, title: string | null, body: string | null): RoleTag[] {
  const firstLine = body?.split('\n').find((l) => l.trim()) ?? '';
  const head = [role, title, firstLine].filter(Boolean).join('\n').replace(NON_DEV, ' ');
  const text = [head, body?.slice(0, 900) ?? ''].join('\n').replace(NON_DEV, ' ');
  const tags = new Set<RoleTag>();
  for (const [tag, re] of PATTERNS) if (re.test(text)) tags.add(tag);
  if (GENERIC_DEV.test(head)) tags.add('software');
  // Any specific dev category implies a software role.
  if (tags.size > 0) tags.add('software');
  return ROLE_TAGS.filter((t) => tags.has(t));
}
