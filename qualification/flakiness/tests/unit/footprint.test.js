/** Tests for the footprint helpers that read a Playwright JSON report. */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { lastTestEnd } = require('../../scenarios/footprint');

const result = (startTime, duration) => ({ startTime, duration });
const report = (results) => ({
  suites: [{ specs: [], suites: [{ specs: [{ tests: [{ results }] }] }] }],
});

describe('lastTestEnd', () => {
  test('is the latest start plus duration of any result, in nested suites too', () => {
    const early = result('2026-01-01T00:00:00.000Z', 5000);
    const late = result('2026-01-01T00:00:02.000Z', 1500);
    assert.strictEqual(lastTestEnd(report([early, late])), Date.parse('2026-01-01T00:00:05.000Z'));
  });

  test('ignores the run duration, so global teardown is not counted as report generation', () => {
    const only = result('2026-01-01T00:00:00.000Z', 100);
    assert.strictEqual(
      lastTestEnd({ stats: { duration: 60000 }, ...report([only]) }),
      Date.parse('2026-01-01T00:00:00.100Z')
    );
  });

  test('refuses a report with no result', () => {
    assert.throws(() => lastTestEnd(report([])), /no test result/);
  });
});
