import { getEnterprisePlugin } from './loader.js';
import { logger } from '../utils/logger.js';

import { randomUUID } from 'node:crypto';
import { AiDecisionObservationSchema, type AiDecisionEvent, type AiOperationContext } from '@compendiq/contracts';

/** Allocate once at the request/job boundary and retain across stages/retries. */
export function newAiOperation(source: string, actor: AiOperationContext['actor'] = { kind: 'unknown', id: null }): AiOperationContext {
  return { operationId: randomUUID(), actor, source, cascadeId: null };
}

export function emitAiDecision(event: AiDecisionEvent): void {
  try {
    const validated = AiDecisionObservationSchema.parse(event);
    void Promise.resolve(getEnterprisePlugin().onAiDecision?.(validated)).catch((err: unknown) => {
      logger.warn({ err, eventId: event.eventId }, 'AI decision observer failed');
    });
  } catch (err) {
    logger.warn({ err, eventId: event.eventId }, 'AI decision observer failed');
  }
}

