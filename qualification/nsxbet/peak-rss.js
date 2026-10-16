'use strict';

/**
 * Preload that appends the peak resident set size of the process, in kilobytes, to the file named
 * by `PSP_RSS_LOG` when the process exits. Node reports it in kilobytes on every platform.
 */

const fs = require('node:fs');

process.on('exit', () => {
  if (process.env.PSP_RSS_LOG) {
    fs.appendFileSync(
      process.env.PSP_RSS_LOG,
      `${JSON.stringify({ pid: process.pid, maxRssKb: process.resourceUsage().maxRSS })}\n`
    );
  }
});
