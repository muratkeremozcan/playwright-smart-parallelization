# Vendoring this Action

Some organizations run third-party Actions only from a copy inside their own repository, reviewed by their security team.
This page is the procedure for keeping such a copy in step with this repository.
This repository stays the source of truth: a fix the copy needs lands here first, with tests, and reaches the copy through a sync.

The examples call the copy's repository `acme/actions` and its directory `playwright-smart-parallelization/`.

## What the copy holds

Copied byte for byte: `src/`, `lib/`, `reporter/`, `dist/`, `finish/main.js`, `scripts/build.js`, `LICENSE` and `docs/reference.md`.

Copied, then edited (re-apply the edits after every sync):

| File                              | Edit in the copy                                                                                                                                                                                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `action.yml`, `finish/action.yml` | `author` names your organization.                                                                                                                                                                                                                                               |
| `package.json`                    | `scripts` keeps only `build`; `devDependencies` keeps only `esbuild`; `author` and `repository` (with `directory`) point at the copy.                                                                                                                                           |
| `package-lock.json`               | Derived from this repository's lockfile, see step 5.                                                                                                                                                                                                                            |
| `README.md`                       | Both `uses:` lines carry the copy's path and the same full SHA: `acme/actions/playwright-smart-parallelization@<sha>` and `acme/actions/playwright-smart-parallelization/finish@<sha>`. Links to docs the copy omits and commands its trimmed `package.json` lacks are removed. |

Everything else is left out, including `tests/`, `harness/`, `fixtures/`, `.github/`, the other `scripts/` and `docs/` files, and the lint and format configuration.

The runtime dependencies (`@actions/core`, `@actions/cache`, `@actions/artifact`) and `esbuild` are exact pins. `esbuild` produces `dist/`, so the copy keeps the same pin.

## Sync

1. Here: land the change after `npm run setup`, `npm run build` and `npm run validate`. `validate` rebuilds the bundle and fails on a stale `dist/`, so a changed bundle is committed in the same PR. Note the merge commit SHA.
2. In the copy's repository, branch from the default branch and name the upstream SHA in the branch.
3. Check out that SHA in a scratch directory, `up`. Replace each copied path with its upstream version, so a file deleted upstream disappears from the copy too.
4. Copy both `action.yml` files whole, then set `author` again.
5. Copy upstream's `package-lock.json`, then rebuild `package.json` from upstream's with the edits in the table: its `dependencies` as they are and its `esbuild` pin. Run `npm install --package-lock-only`. Starting from upstream's lockfile keeps every resolved version and only drops the development packages. Do this on every sync, because a lockfile can change while `package.json` does not.
6. Verify from the copy's directory. Each command succeeds with exit status 0:

   ```sh
   up=/path/to/upstream/checkout   # at the synced SHA, after npm ci
   for p in src lib reporter dist finish/main.js scripts/build.js LICENSE docs/reference.md; do
     diff -r "$up/$p" "$p" || echo "differs: $p"
   done
   npm ci
   out=$(mktemp -d)
   node scripts/build.js --out "$out/dist" && diff -r dist "$out/dist"; rc=$?; rm -rf "$out"; test $rc -eq 0
   diff <(cd "$up" && npm ls --omit=dev --all | tail -n +2) <(npm ls --omit=dev --all | tail -n +2)
   git status --short --untracked-files=all
   ```

   The loop prints nothing, the rebuilt bundle matches `dist/`, the runtime dependency trees match, and `git status` lists only the files you expect.

7. Open the PR. Run the rebuild-and-diff check in the copy's CI too, so reviewers can trust `dist/` without reading it.
8. In the PR description, give the upstream SHA range, the behavior change in a sentence or two, and for each dependency bump its name, old and new version and the reason.
9. After merge, move consumers to the copy's merge SHA. Consumers pin the full SHA. A tag in the copy's repository tags the whole repository, so it does not identify this Action's version.

## What reviewers read

- `src/`, `lib/`, `reporter/`, `finish/main.js`, `scripts/build.js` and the lockfile. The `dist/` bundle (about 2.3 MB for `index.js`) is checked by the rebuild in CI.
- `scripts/build.js` bundles and minifies the code and strips legal comments. Its `legacy-buffer` plugin is the one patch to dependency source: it replaces the deprecated `new Buffer()` calls in four packages (`binary`, `buffers`, `tunnel`, `unzip-stream`; five files). Call it out when a sync changes `scripts/build.js` or bumps those packages.
- A dependency bump needs its own justification in the PR. A sync that changes only first-party source does not.

## Tests

The copy carries no tests; this repository's CI runs them on every SHA it syncs from.
Running the suite in the copy needs more than `tests/`: it imports `harness/` and scripts the copy omits, reads `.github/` workflows and installs `fixtures/consumer/`.
