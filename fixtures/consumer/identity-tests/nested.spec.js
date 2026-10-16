'use strict';

const { test } = require('@playwright/test');

// The inner serial suite is declared above the outer one, so it has the smaller line number: a
// group id picked by source line would choose the inner suite and let the outer one split.
function innerSerial() {
  test.describe('inner', () => {
    test.describe.configure({ mode: 'serial' });
    test('inner one', async () => {});
    test('inner two', async () => {});
  });
}

test.describe('outer', () => {
  test.describe.configure({ mode: 'serial' });
  test('outer before', async () => {});
  innerSerial();
  test('outer after', async () => {});
});
