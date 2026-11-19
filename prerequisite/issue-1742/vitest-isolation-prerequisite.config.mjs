export default {
  test: {
    globals: true,
    environment: 'node',
    include: ['/private/tmp/compendiq-1905.a8zOun/issue-1742/backend/src/test-worker-isolation.test.ts'],
    setupFiles: ['/private/tmp/compendiq-1905.a8zOun/issue-1742/prerequisite/issue-1742/vitest-worker-slot-probe.mjs'],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30_000,
  },
};
