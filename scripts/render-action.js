'use strict';

/**
 * Renders `action.yml`. A composite action has no loops, so every Node step carries the same env
 * block of inputs and the compare-and-swap of the history is unrolled into `ATTEMPTS` copies of
 * its six steps. This script writes them from one place; `npm test` fails when the committed file
 * differs from its output. `node scripts/render-action.js --write` updates the file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { ATTEMPTS } = require('../lib/store');
const { CACHE_PATH } = require('../lib/identity');
const { INPUTS, envName } = require('../lib/inputs');

// Only the step that reads the jobs API gets the token; above all, the step that runs the user's
// Playwright command never has it in its environment.
const envBlock = (indent, extra = {}, { token = false } = {}) => {
  const pad = ' '.repeat(indent);
  const names = INPUTS.filter((i) => token || i !== 'github-token');
  const lines = names.map((i) => `${pad}${envName(i)}: \${{ inputs.${i} }}`);
  for (const [k, v] of Object.entries(extra)) lines.push(`${pad}${k}: ${v}`);
  return lines.join('\n');
};
const node = (step) => `node "$GITHUB_ACTION_PATH/main.js" ${step}`;
let out = '';
const add = (text) => {
  out += `${text}\n`;
};
add(`name: 'Playwright Smart Parallelization'
description: 'Duration-balanced Playwright sharding for GitHub Actions: one Action, three phases (prepare, run, finish).'
author: muratkeremozcan
branding:
  icon: 'zap'
  color: 'green'

inputs:
  phase:
    description: 'prepare (once, before the shard matrix), run (once per shard) or finish (once, after the shards).'
    required: true
  shards:
    description: 'prepare: the number of shards.'
    required: false
    default: '2'
  command:
    description: |
      prepare: the Playwright command each shard runs, without --shard. One command, no shell syntax;
      the Action appends --shard, --workers and --add-reporter. It keys the history, so a filtered
      command keeps a history of its own.
    required: false
    default: 'npx playwright test'
  working-directory:
    description: 'prepare: the directory of the Playwright project, relative to the workspace.'
    required: false
    default: '.'
  workers:
    description: 'prepare: workers per shard, passed to Playwright and to the plan. Empty leaves the config alone and plans for 1.'
    required: false
    default: ''
  runner-label:
    description: 'prepare: the runner class of the shard jobs, which the history belongs to. Empty means the prepare job runner.os-runner.arch.'
    required: false
    default: ''
  history-key:
    description: 'prepare: any extra text that separates one history from another, such as an environment name.'
    required: false
    default: ''
  enabled:
    description: 'prepare: false turns balancing off for the whole run: plain --shard, no reporter, no history write.'
    required: false
    default: 'true'
  plan:
    description: 'run and finish: the plan output of the prepare job.'
    required: false
    default: ''
  shard:
    description: 'run: this shard, from the matrix.'
    required: false
    default: ''
  blob-report:
    description: 'run: the folder of the blob report, relative to working-directory, uploaded when present and merged by finish.'
    required: false
    default: 'blob-report'
  publish-history:
    description: 'finish: false never writes the history.'
    required: false
    default: 'true'
  github-token:
    description: 'finish: reads the jobs API to measure the per-shard overhead for the summary.'
    required: false
    default: \${{ github.token }}

outputs:
  matrix:
    description: 'prepare: {"shard":[1..n]} for strategy.matrix.'
    value: \${{ steps.prepare.outputs.matrix }}
  plan:
    description: 'prepare: the plan every run and finish step takes back.'
    value: \${{ steps.prepare.outputs.plan }}
  mode:
    description: 'prepare: balanced, native or disabled.'
    value: \${{ steps.prepare.outputs.mode }}

runs:
  using: composite
  steps:
    - name: Check the phase
      shell: bash
      run: ${node('phase')}
      env:
${envBlock(8)}

    # prepare: decide the mode of the whole run and pin one history snapshot.
    - name: Prepare, history key
      id: prepare-key
      if: inputs.phase == 'prepare'
      shell: bash
      run: ${node('prepare-key')}
      env:
${envBlock(8)}
    - name: Prepare, restore the newest history
      id: prepare-restore
      if: inputs.phase == 'prepare' && steps.prepare-key.outputs.restore == 'true'
      uses: actions/cache/restore@v6
      with:
        path: ${CACHE_PATH}
        key: \${{ steps.prepare-key.outputs.prefix }}
        restore-keys: \${{ steps.prepare-key.outputs.prefix }}
    - name: Prepare, plan
      id: prepare
      if: inputs.phase == 'prepare'
      shell: bash
      run: ${node('prepare-plan')}
      env:
${envBlock(8, { PSP_MATCHED_KEY: '${{ steps.prepare-restore.outputs.cache-matched-key }}' })}
    - name: Prepare, upload the snapshot
      if: inputs.phase == 'prepare' && steps.prepare.outputs.mode == 'balanced'
      uses: actions/upload-artifact@v7
      with:
        name: \${{ steps.prepare.outputs.artifact }}
        path: \${{ steps.prepare.outputs.snapshot-dir }}
        if-no-files-found: error
        overwrite: true

    # run: one shard.
    - name: Run, setup
      id: run-setup
      if: inputs.phase == 'run'
      shell: bash
      run: ${node('run-setup')}
      env:
${envBlock(8)}
    - name: Run, download the snapshot
      if: inputs.phase == 'run' && steps.run-setup.outputs.mode == 'balanced'
      uses: actions/download-artifact@v8
      with:
        name: \${{ steps.run-setup.outputs.artifact }}
        path: \${{ steps.run-setup.outputs.snapshot-dir }}
    - name: Run, Playwright
      id: run
      if: inputs.phase == 'run'
      shell: bash
      run: ${node('run-exec')}
      env:
${envBlock(8)}
    - name: Run, upload the record
      if: always() && inputs.phase == 'run' && steps.run-setup.outputs.record == 'true'
      uses: actions/upload-artifact@v7
      with:
        name: \${{ steps.run-setup.outputs.record-name }}
        path: \${{ steps.run-setup.outputs.record-path }}
        if-no-files-found: ignore
        overwrite: true
    - name: Run, upload the blob report
      if: always() && inputs.phase == 'run' && steps.run-setup.outcome == 'success'
      uses: actions/upload-artifact@v7
      with:
        name: \${{ steps.run-setup.outputs.blob-name }}
        path: \${{ steps.run-setup.outputs.blob-path }}
        if-no-files-found: ignore
        overwrite: true

    # finish: check, summarize, merge the reports and publish the history.
    - name: Finish, setup
      id: finish-setup
      if: inputs.phase == 'finish'
      shell: bash
      run: ${node('finish-setup')}
      env:
${envBlock(8)}
    - name: Finish, download the records
      if: inputs.phase == 'finish' && steps.finish-setup.outputs.records == 'true'
      uses: actions/download-artifact@v8
      with:
        pattern: \${{ steps.finish-setup.outputs.records-pattern }}
        path: \${{ steps.finish-setup.outputs.records-dir }}
    - name: Finish, download the blob reports
      if: inputs.phase == 'finish' && steps.finish-setup.outcome == 'success'
      uses: actions/download-artifact@v8
      with:
        pattern: \${{ steps.finish-setup.outputs.blob-pattern }}
        path: \${{ steps.finish-setup.outputs.blob-dir }}
    - name: Finish, check the run
      id: finish-check
      if: always() && inputs.phase == 'finish' && steps.finish-setup.outcome == 'success'
      shell: bash
      run: ${node('finish-check')}
      env:
${envBlock(8, {}, { token: true })}
    - name: Finish, merge the blob reports
      id: finish-report
      if: always() && inputs.phase == 'finish' && steps.finish-setup.outcome == 'success'
      shell: bash
      run: ${node('finish-report')}
      env:
${envBlock(8)}
    - name: Finish, upload the merged report
      if: always() && steps.finish-report.outputs.merged == 'true'
      uses: actions/upload-artifact@v7
      with:
        name: \${{ steps.finish-setup.outputs.report-name }}
        path: \${{ steps.finish-setup.outputs.report-dir }}
        overwrite: true
`);
const stateEnv = (extra) => ({
  PSP_STATE_DIR: '${{ steps.finish-setup.outputs.state-dir }}',
  ...extra,
});
for (let k = 1; k <= ATTEMPTS; k++) {
  const go =
    k === 1
      ? "steps.finish-check.outputs.publish == 'true'"
      : `steps.cas${k - 1}-verify.outputs.retry == 'true'`;
  add(`    # compare-and-swap, attempt ${k} of ${ATTEMPTS}
    - name: History, attempt ${k}, restore the newest entry
      id: cas${k}-read
      if: ${go}
      uses: actions/cache/restore@v6
      with:
        path: ${CACHE_PATH}
        key: \${{ steps.finish-check.outputs.prefix }}
        restore-keys: \${{ steps.finish-check.outputs.prefix }}
    - name: History, attempt ${k}, merge and write
      id: cas${k}-write
      if: ${go}
      shell: bash
      run: ${node('store-write')}
      env:
${envBlock(8, stateEnv({ PSP_MATCHED_KEY: `\${{ steps.cas${k}-read.outputs.cache-matched-key }}` }))}
    - name: History, attempt ${k}, save
      if: steps.cas${k}-write.outputs.save == 'true'
      uses: actions/cache/save@v6
      with:
        path: ${CACHE_PATH}
        key: \${{ steps.cas${k}-write.outputs.key }}
    - name: History, attempt ${k}, clear
      if: steps.cas${k}-write.outputs.save == 'true'
      shell: bash
      run: ${node('store-clear')}
      env:
${envBlock(8)}
    - name: History, attempt ${k}, read the key back
      id: cas${k}-check
      if: steps.cas${k}-write.outputs.save == 'true'
      uses: actions/cache/restore@v6
      with:
        path: ${CACHE_PATH}
        key: \${{ steps.cas${k}-write.outputs.key }}
    - name: History, attempt ${k}, verify
      id: cas${k}-verify
      if: steps.cas${k}-write.outputs.save == 'true'
      shell: bash
      run: ${node('store-verify')}
      env:
${envBlock(8, stateEnv({ PSP_CACHE_HIT: `\${{ steps.cas${k}-check.outputs.cache-hit }}` }))}`);
}
add(`
    - name: Finish, conclude
      if: always() && inputs.phase == 'finish' && steps.finish-setup.outcome == 'success'
      shell: bash
      run: ${node('finish-conclude')}
      env:
${envBlock(8)}`);
const FILE = path.join(__dirname, '..', 'action.yml');

if (require.main === module) {
  if (process.argv.includes('--write')) fs.writeFileSync(FILE, out);
  else process.stdout.write(out);
}

module.exports = { FILE, rendered: out };
