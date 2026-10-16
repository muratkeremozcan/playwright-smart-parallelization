'use strict';

/** Markdown table helpers shared by the engine reports. */

const KIB = 1024;

function kib(bytes) {
  return `${(bytes / KIB).toFixed(1)} KiB`;
}

function mib(bytes) {
  return `${(bytes / KIB / KIB).toFixed(1)} MiB`;
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function signedPercent(value) {
  return `${value >= 0 ? '+' : ''}${percent(value)}`;
}

function kinds(counts) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? 'none' : entries.map(([kind, n]) => `${kind} ${n}`).join(', ');
}

function table(header, rows) {
  for (const row of rows) {
    if (row.length !== header.length) {
      throw new Error(`table row has ${row.length} cells for ${header.length} columns`);
    }
  }
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

/** Collapses table padding so a hand-formatted table equals a rendered one. */
function normalizeTable(text) {
  return text
    .split('\n')
    .map((line) =>
      line
        .split('|')
        .map((cell) => cell.trim().replace(/^-+$/, '---'))
        .join('|')
    )
    .join('\n');
}

module.exports = { KIB, kib, kinds, mib, normalizeTable, percent, signedPercent, table };
