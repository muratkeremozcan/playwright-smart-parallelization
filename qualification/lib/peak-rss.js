'use strict';

/**
 * Preload that appends the peak resident set size of the process, in kilobytes, to the file named
 * by `PSP_RSS_LOG` when the process exits. Node reports it in kilobytes on every platform. `ipc`
 * tells a process started with an IPC channel (a Playwright worker) from the one that started it.
 */

const fs = require('node:fs');

process.on('exit', () => {
  if (process.env.PSP_RSS_LOG) {
    fs.appendFileSync(
      process.env.PSP_RSS_LOG,
      `${JSON.stringify({
        pid: process.pid,
        ipc: typeof process.send === 'function',
        maxRssKb: process.resourceUsage().maxRSS,
      })}\n`
    );
  }
});
