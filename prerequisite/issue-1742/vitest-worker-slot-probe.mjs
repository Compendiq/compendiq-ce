import assert from 'node:assert/strict';
import { workerIdFromEnv } from '/private/tmp/compendiq-1905.a8zOun/issue-1742/backend/src/test-worker-isolation.ts';

const workerId = workerIdFromEnv();
assert.equal(workerId, 1, 'The setup-free prerequisite runner must use its actual pool slot 1');
console.log(`Setup-free actual Vitest pool slot: ${workerId}`);
