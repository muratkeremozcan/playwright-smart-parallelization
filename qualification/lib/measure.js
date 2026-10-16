'use strict';

/** Measurement helpers shared by the footprint checks. */

const fs = require('node:fs');
const path = require('node:path');

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Total size in bytes of the files under `dir`. */
function directoryBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += directoryBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function size(file) {
  return fs.statSync(file).size;
}

module.exports = { directoryBytes, median, size };
