import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerRelationshipProducer,
  listRelationshipProducers,
  _resetRelationshipProducersForTests,
  type RelationshipProducer,
} from './embedding-relationship-hooks.js';

describe('embedding-relationship-hooks', () => {
  beforeEach(() => {
    _resetRelationshipProducersForTests();
  });

  it('lists producers in registration order', () => {
    const a: RelationshipProducer = vi.fn().mockResolvedValue(0);
    const b: RelationshipProducer = vi.fn().mockResolvedValue(0);
    registerRelationshipProducer('a', a);
    registerRelationshipProducer('b', b);

    const list = listRelationshipProducers();
    expect(list.map((p) => p.name)).toEqual(['a', 'b']);
  });

  it('replaces a producer when re-registered with the same name (idempotent boot)', () => {
    const v1: RelationshipProducer = vi.fn().mockResolvedValue(0);
    const v2: RelationshipProducer = vi.fn().mockResolvedValue(0);
    registerRelationshipProducer('explicitLink', v1);
    registerRelationshipProducer('explicitLink', v2);

    const list = listRelationshipProducers();
    expect(list).toHaveLength(1);
    expect(list[0]!.fn).toBe(v2);
  });

  it('listRelationshipProducers returns a copy (caller cannot mutate registry)', () => {
    const fn: RelationshipProducer = vi.fn().mockResolvedValue(0);
    registerRelationshipProducer('x', fn);

    const list = listRelationshipProducers() as { name: string; fn: RelationshipProducer }[];
    list.length = 0;

    expect(listRelationshipProducers()).toHaveLength(1);
  });
});
