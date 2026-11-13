import type { JobDetails, JobOrigin } from '../domain/types.js';
import { extractEmails, extractLinkedIn, extractUrls } from './contacts.js';
import { classifyRoles } from './roles.js';
import { classifyRemote } from './remote.js';

export interface JobHeader {
  company: string | null;
  role: string | null;
  location: string | null;
  salary: string | null;
  ycBatch: string | null;
}

const EMPTY: JobHeader = { company: null, role: null, location: null, salary: null, ycBatch: null };

const ROLE_RE =
  /\b(engineers?|engineering|developers?|dev|scientists?|designers?|managers?|leads?|architects?|analysts?|researchers?|founding|head of|director|sre|devops|interns?|cto|ceo|coo|cfo|ciso|vp|officer|administrator|specialist|product|marketing|sales|recruiter|sourcer|tester|ml|ai|frontend|front-end|backend|back-end|full[- ]?stack|programmer|consultant|operations|(?:multiple|various|many) (?:roles|positions|openings))\b/i;
const SALARY_RE = /(?:[$€£]\s?\d|\b(?:usd|eur|gbp)\s?\d|\b\d{2,3}\s?k\b|\bequity\b)/i;
const URLISH_RE = /^(https?:\/\/|www\.)\S+$/i;
/** Segments that describe the contract, not the place: never treat them as a location. */
const EMPLOYMENT_RE =
  /^(full[- ]?time|part[- ]?time|contract(or)?|permanent|freelance|internship|visa|h-?1b|salary|equity|\d+%)/i;

function cleanCompany(raw: string | undefined): string | null {
  if (!raw || /^location\s*:/i.test(raw)) return null;
  const c = raw
    .replace(/https?:\/\/\S+|www\.\S+/gi, '')
    .replace(/\(\s*\)?\s*$|\(\s*\)/g, '')
    .trim();
  return c || null;
}

/**
 * YC job posts: "Acme (YC W24) Is Hiring a Founding Engineer (Remote)"
 */
export function parseYcJobTitle(title: string): JobHeader {
  const t = title.trim();
  const yc = t.match(/^(.+?)\s*\((?:YC\s*)?([WSFX]\d{2})\)\s*(?:is\s+)?hiring\s*(?:an?\s+)?(.*)$/i);
  const plain = yc ? null : t.match(/^(.+?)\s+(?:is\s+)?hiring\s*(?:an?\s+)?(.*)$/i);
  const company = yc?.[1] ?? plain?.[1] ?? null;
  let role: string | null = (yc?.[3] ?? plain?.[2] ?? (company ? '' : t)).trim() || null;
  let location: string | null = null;

  if (role) {
    const paren = role.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (paren?.[1]) {
      role = paren[1].trim();
      location = paren[2]?.trim() ?? null;
    }
    const inLoc = role.match(/^(.*?)\s+in\s+([A-Z][\w .,'-]+)$/);
    if (!location && inLoc?.[1]) {
      role = inLoc[1].trim();
      location = inLoc[2]?.trim() ?? null;
    }
  }
  return {
    company: company?.trim() ?? null,
    role,
    location,
    salary: null,
    ycBatch: yc?.[2]?.toUpperCase() ?? null,
  };
}

/**
 * "Who is hiring" convention: first line is pipe-separated.
 *   "Acme | Senior Backend Engineer | Berlin or REMOTE (EU) | €90k-€120k | https://acme.dev"
 */
export function parseHiringHeader(body: string): JobHeader {
  const firstLine = body.split('\n').find((l) => l.trim()) ?? '';
  if (!firstLine.includes('|')) return { ...EMPTY };
  const parts = firstLine
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);
  const header: JobHeader = { ...EMPTY, company: cleanCompany(parts[0]) };

  for (const part of parts.slice(1)) {
    if (URLISH_RE.test(part)) continue;
    if (!header.salary && SALARY_RE.test(part)) header.salary = part;
    else if (EMPLOYMENT_RE.test(part)) continue;
    else if (!header.role && ROLE_RE.test(part)) header.role = part;
    else if (!header.location && part.length <= 80) header.location = part;
  }
  return header;
}

export function detectRemote(text: string): boolean | null {
  if (/\b(no|not)\s+remote\b|\bremote\s*:\s*no\b/i.test(text)) return false;
  if (/\bremote\b/i.test(text)) return true;
  if (/\b(onsite|on-site|in[- ]office|in[- ]person)\b/i.test(text)) return false;
  return null;
}

export function buildJobDetails(
  origin: JobOrigin,
  title: string | null,
  body: string | null,
  url: string | null,
): JobDetails {
  const header =
    origin === 'yc_jobs' && title ? parseYcJobTitle(title) : parseHiringHeader(body ?? '');
  const text = [title, body].filter(Boolean).join('\n');
  const links = new Set<string>();
  if (url) links.add(url);
  for (const u of extractUrls(text)) links.add(u);

  const remote = detectRemote(text);
  const eligibility = classifyRemote(remote, header.location, text);
  return {
    origin,
    ...header,
    remote,
    remoteScope: eligibility.scope,
    remoteRegions: eligibility.regions,
    emails: extractEmails(text).map((e) => ({ ...e, origin: 'post' as const })),
    linkedinUrls: extractLinkedIn(text),
    links: [...links],
    roleTags: classifyRoles(header.role, title, body),
  };
}
