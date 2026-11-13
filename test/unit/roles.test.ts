import { describe, expect, it } from 'vitest';
import { classifyRoles } from '../../src/normalize/roles.js';

describe('classifyRoles', () => {
  it.each([
    ['Founding Engineer', ['founding', 'software']],
    ['Senior Backend Engineer', ['backend', 'software']],
    ['Full-Stack Developer (TypeScript)', ['fullstack', 'software']],
    ['Frontend Engineer, React', ['frontend', 'software']],
    ['AI Engineer', ['ai', 'software']],
    ['ML Engineer / LLM infra', ['ai', 'software']],
    ['Platform Engineer', ['backend', 'software']],
    ['Software Engineer', ['software']],
    ['Founding Full-Stack Engineer', ['founding', 'fullstack', 'software']],
    ['Agentic Python Engineer', ['ai', 'software']],
  ])('tags role "%s"', (role, tags) => {
    expect(classifyRoles(role, null, null)).toEqual(tags);
  });

  it.each(['Account Executive', 'Sales Engineer', 'Talent Sourcer', 'Mechanical Engineer', 'Product Designer'])(
    'does not tag non-dev role "%s"',
    (role) => expect(classifyRoles(role, null, null)).toEqual([]),
  );

  it('finds roles listed in the top of the post when the header has none', () => {
    const body = 'Fly.io | REMOTE | Full time\n\nWe are hiring:\n- Backend engineers (Go, Rust)\n- Frontend developer';
    expect(classifyRoles(null, null, body)).toEqual(['backend', 'frontend', 'software']);
  });

  it('does not treat "founding team" prose as a founding role', () => {
    expect(classifyRoles('GTM Engineer', null, 'Acme | GTM Engineer\n\nJoin our founding team.')).toEqual(['software']);
  });

  it('ignores generic "engineers" in prose', () => {
    expect(classifyRoles('Account Executive', null, 'Acme | AE | NYC\n\nJoin our team of 40 engineers.')).toEqual([]);
  });
});
