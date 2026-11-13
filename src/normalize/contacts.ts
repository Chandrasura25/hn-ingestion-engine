import type { EmailContact } from '../domain/types.js';

const PERSONAL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'fastmail.com',
  'aol.com',
  'hey.com',
]);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}/gi;
const FILE_TLDS = /\.(png|jpe?g|gif|svg|webp|pdf)$/i;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const LINKEDIN_RE =
  /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(in|company|pub)\/([A-Za-z0-9\-_%.]+)/gi;

/**
 * Undo the common anti-scraper spellings people use in HN posts:
 *   jane [at] acme [dot] com, jane (at) acme.com, jane at acme dot com
 * Bare " at " is only rewritten when the domain also uses " dot ",
 * so prose like "we are at acme.com" is left alone.
 */
export function deobfuscate(text: string): string {
  return text
    .replace(/\s*[[({<]\s*(?:at|@)\s*[\])}>]\s*/gi, '@')
    .replace(/\s*[[({<]\s*(?:dot|\.)\s*[\])}>]\s*/gi, '.')
    .replace(
      /\b([a-z0-9._%+-]+)\s+at\s+([a-z0-9-]+(?:\s+dot\s+[a-z0-9-]+)+)\b/gi,
      (_m, user: string, domain: string) => `${user}@${domain.replace(/\s+dot\s+/gi, '.')}`,
    )
    .replace(
      /([a-z0-9._%+-]+@[a-z0-9-]+)((?:\s+dot\s+[a-z0-9-]+)+)/gi,
      (_m, head: string, rest: string) => head + rest.replace(/\s+dot\s+/gi, '.'),
    );
}

export function emailKind(address: string): EmailContact['kind'] {
  const domain = address.split('@')[1] ?? '';
  return PERSONAL_DOMAINS.has(domain) ? 'personal' : 'work';
}

export function extractEmails(text: string): Array<Omit<EmailContact, 'origin'>> {
  const found = new Set<string>();
  for (const m of deobfuscate(text).matchAll(EMAIL_RE)) {
    const address = m[0].toLowerCase().replace(/\.+$/, '');
    if (!FILE_TLDS.test(address)) found.add(address);
  }
  return [...found].map((address) => ({ address, kind: emailKind(address) }));
}

export function extractLinkedIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(LINKEDIN_RE)) {
    const slug = (m[2] ?? '').replace(/[.]+$/, '');
    if (slug) found.add(`https://www.linkedin.com/${(m[1] ?? 'in').toLowerCase()}/${slug}`);
  }
  return [...found];
}

export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (!/linkedin\.com\//i.test(url)) found.add(url);
  }
  return [...found];
}
