import { describe, expect, it } from 'vitest';
import { InvalidPayloadError } from '../../src/domain/errors.js';
import { computeBackoff } from '../../src/queue/queues.js';
import { deobfuscate, extractEmails, extractLinkedIn, extractUrls } from '../../src/normalize/contacts.js';
import { htmlToText } from '../../src/normalize/html.js';
import { detectRemote, parseHiringHeader, parseYcJobTitle } from '../../src/normalize/jobs.js';
import { normalizeHnItem } from '../../src/sources/hackernews/normalize.js';
import { parseRetryAfter } from '../../src/sources/hackernews/source.js';

describe('htmlToText', () => {
  it('keeps hrefs, splits paragraphs and decodes HN entities', () => {
    const html =
      'Acme | Engineer<p>Apply at <a href="https:&#x2F;&#x2F;acme.dev&#x2F;jobs" rel="nofollow">https:&#x2F;&#x2F;acme.dev&#x2F;j...</a> &amp; say hi';
    expect(htmlToText(html)).toBe('Acme | Engineer\n\nApply at https://acme.dev/jobs & say hi');
  });
});

describe('contact extraction', () => {
  it.each([
    ['jobs [at] acme [dot] com', 'jobs@acme.com'],
    ['jane (at) acme.io', 'jane@acme.io'],
    ['email jane at acme dot co dot uk', 'jane@acme.co.uk'],
    ['jane@acme dot com', 'jane@acme.com'],
    ['JANE.DOE+hn@Gmail.com.', 'jane.doe+hn@gmail.com'],
  ])('deobfuscates %s', (input, expected) => {
    expect(extractEmails(input).map((e) => e.address)).toEqual([expected]);
  });

  it('does not invent emails from prose', () => {
    expect(extractEmails('We are at acme.com and remote (at least 4h overlap)')).toEqual([]);
    expect(deobfuscate('meet at the office')).toBe('meet at the office');
  });

  it('classifies personal vs work addresses', () => {
    expect(extractEmails('a@gmail.com b@acme.com')).toEqual([
      { address: 'a@gmail.com', kind: 'personal' },
      { address: 'b@acme.com', kind: 'work' },
    ]);
  });

  it('ignores image filenames that look like emails', () => {
    expect(extractEmails('logo@2x.png')).toEqual([]);
  });

  it('normalizes LinkedIn profile and company URLs', () => {
    expect(
      extractLinkedIn('me: linkedin.com/in/jane-doe. co: https://uk.linkedin.com/company/acme-inc/'),
    ).toEqual(['https://www.linkedin.com/in/jane-doe', 'https://www.linkedin.com/company/acme-inc']);
  });

  it('extracts non-LinkedIn URLs without trailing punctuation', () => {
    expect(extractUrls('see https://acme.dev/jobs. or (https://lever.co/acme), https://linkedin.com/in/x')).toEqual([
      'https://acme.dev/jobs',
      'https://lever.co/acme',
    ]);
  });
});

describe('job header parsing', () => {
  it('parses YC job titles', () => {
    expect(parseYcJobTitle('Acme (YC W24) Is Hiring a Founding Engineer (Remote)')).toEqual({
      company: 'Acme', role: 'Founding Engineer', location: 'Remote', salary: null, ycBatch: 'W24',
    });
    expect(parseYcJobTitle('Foo (YC S21) is hiring backend engineers in San Francisco')).toMatchObject({
      company: 'Foo', role: 'backend engineers', location: 'San Francisco', ycBatch: 'S21',
    });
  });

  it('parses pipe-separated Who-is-hiring headers in any order', () => {
    expect(
      parseHiringHeader('Acme | Berlin or REMOTE (EU) | Senior Backend Engineer | €90k-€120k | https://acme.dev\n\nmore'),
    ).toEqual({
      company: 'Acme', role: 'Senior Backend Engineer', location: 'Berlin or REMOTE (EU)', salary: '€90k-€120k', ycBatch: null,
    });
  });

  it.each([
    ['Baserow ( https://baserow.io ) | Product Specialist | REMOTE (Europe) | Full-time', { company: 'Baserow', role: 'Product Specialist', location: 'REMOTE (Europe)' }],
    ['PlantingSpace | Full-time | Remote (EU time zone) | https://planting.space', { company: 'PlantingSpace', role: null, location: 'Remote (EU time zone)' }],
    ['Bechtel | Penetration Tester | Remote or onsite (US) | Full-time <$145k', { role: 'Penetration Tester', salary: 'Full-time <$145k' }],
    ['Sumble | Multiple Roles | Remote (US)| Full-time', { role: 'Multiple Roles', location: 'Remote (US)' }],
    ['Location: India (IST) | open to work', { company: null }],
  ])('handles real-world header %s', (line, expected) => {
    expect(parseHiringHeader(line)).toMatchObject(expected);
  });

  it('returns nulls for free-form posts instead of guessing', () => {
    expect(parseHiringHeader('We are hiring lots of people, email us.').company).toBeNull();
  });

  it('detects remote policy', () => {
    expect(detectRemote('REMOTE (US)')).toBe(true);
    expect(detectRemote('Onsite in NYC, no remote')).toBe(false);
    expect(detectRemote('Onsite in NYC')).toBe(false);
    expect(detectRemote('NYC')).toBeNull();
  });
});

describe('normalizeHnItem', () => {
  const fetchedAt = new Date();

  it('builds a job posting from a Who-is-hiring comment', () => {
    const { post, job } = normalizeHnItem('hackernews', {
      externalId: '42',
      fetchedAt,
      payload: {
        id: 42, type: 'comment', by: 'jane', time: 1_700_000_000, parent: 1,
        text: 'Acme | Data Engineer | REMOTE | $150k<p>Email jane [at] gmail [dot] com, linkedin.com&#x2F;in&#x2F;jane',
      },
    }, { jobOrigin: 'who_is_hiring' });
    expect(post).toMatchObject({ kind: 'comment', status: 'active', author: 'jane', qualityIssues: [] });
    expect(job).toMatchObject({
      origin: 'who_is_hiring', company: 'Acme', role: 'Data Engineer', remote: true, salary: '$150k',
      emails: [{ address: 'jane@gmail.com', kind: 'personal', origin: 'post' }],
      linkedinUrls: ['https://www.linkedin.com/in/jane'],
    });
  });

  it('stores partial records with quality issues instead of rejecting them', () => {
    const { post } = normalizeHnItem('hackernews', {
      externalId: '7', fetchedAt, payload: { id: 7, type: 'story', by: 99, title: 'Hi' },
    });
    expect(post.author).toBeNull();
    expect(post.qualityIssues).toEqual(['invalid_by', 'missing_time']);
  });

  it('rejects payloads for the wrong item', () => {
    expect(() =>
      normalizeHnItem('hackernews', { externalId: '7', fetchedAt, payload: { id: 8, type: 'story' } }),
    ).toThrow(InvalidPayloadError);
  });

  it('does not change the content hash when only the score changes', () => {
    const mk = (score: number) =>
      normalizeHnItem('hackernews', { externalId: '1', fetchedAt, payload: { id: 1, type: 'story', by: 'a', time: 1, title: 't', score } }).post.contentHash;
    expect(mk(1)).toBe(mk(500));
  });

  it('drops job details when the post is deleted', () => {
    const { post, job } = normalizeHnItem('hackernews', {
      externalId: '9', fetchedAt, payload: { id: 9, type: 'job', deleted: true },
    });
    expect(post.status).toBe('deleted');
    expect(job).toBeNull();
  });
});

describe('backoff', () => {
  it('grows exponentially with jitter inside [exp/2, exp]', () => {
    // BACKOFF_BASE_MS=20 in vitest config
    expect(computeBackoff(1, undefined, () => 0)).toBe(10);
    expect(computeBackoff(1, undefined, () => 1)).toBe(20);
    expect(computeBackoff(4, undefined, () => 1)).toBe(160);
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null, 1234)).toBe(1234);
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
  });
});
