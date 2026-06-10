import { describe, it, expect } from 'vitest';
import { visiblePagesPredicate } from './page-visibility.js';

describe('visiblePagesPredicate', () => {
  it('binds the spaces and user parameter indexes where expected', () => {
    const sql = visiblePagesPredicate(1, 2);

    expect(sql).toContain(`cp.space_key = ANY($1::text[])`);
    expect(sql).toContain(`cp.created_by_user_id = $2`);
    // Exactly the three OR'd visibility branches, wrapped in parens
    expect(sql.trim().startsWith('(')).toBe(true);
    expect(sql.trim().endsWith(')')).toBe(true);
    expect(sql).toContain(`(cp.source = 'confluence' AND cp.space_key = ANY($1::text[]))`);
    expect(sql).toContain(`OR (cp.source = 'standalone' AND cp.visibility = 'shared')`);
    expect(sql).toContain(`OR (cp.source = 'standalone' AND cp.visibility = 'private' AND cp.created_by_user_id = $2)`);
  });

  it('supports arbitrary parameter indexes', () => {
    const sql = visiblePagesPredicate(7, 9);

    expect(sql).toContain(`ANY($7::text[])`);
    expect(sql).toContain(`created_by_user_id = $9`);
    // No stray references to other parameter slots
    expect(sql.match(/\$\d+/g)).toEqual(['$7', '$9']);
  });

  it('applies a custom table alias to every column reference', () => {
    const sql = visiblePagesPredicate(1, 2, 'p');

    expect(sql).toContain(`p.source = 'confluence'`);
    expect(sql).toContain(`p.space_key = ANY($1::text[])`);
    expect(sql).toContain(`p.visibility = 'shared'`);
    expect(sql).toContain(`p.created_by_user_id = $2`);
    expect(sql).not.toContain('cp.');
  });

  it('does not interpolate user data — only numeric indexes and the alias appear', () => {
    // Parameter indexes are typed as numbers, so the only dynamic text is the
    // alias (a compile-time constant at call sites) and "$<n>" placeholders.
    const sql = visiblePagesPredicate(3, 4);
    expect(sql).not.toContain('undefined');
    expect(sql).toMatch(/\$3::text\[\]/);
    expect(sql).toMatch(/\$4\)/);
  });
});
