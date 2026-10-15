# Workflow and history

Applies only after CAP-3 selects an engine. Names below are a proposed interface, not existing ones.

## Reusable workflow

- **Inputs:** working directory, config path, projects and filters, shard count, workers, timing artifact location, retention, engine enable/disable switch.
- **Prepare:** validate inputs. Lock one history snapshot or assignment for the whole run. Keep the caller's own dependency install and app start steps.
- **Execute:** matrix over shards running ordinary Playwright commands under the selected engine. Upload uniquely named per-run, per-attempt, per-shard artifacts even when tests fail.
- **Aggregate:** check expected shard completeness, merge native results, update timings from eligible observations, summarize slowest-shard time and imbalance.
- **Rollback:** a single switch disables balancing for the entire run and keeps existing native reporting.

Reuse `gh-build-matrix` for matrix generation where it fits.

## History policy

- One trusted writer. Each record carries source commit and run, configuration fingerprint, schema version, and time.
- A delayed older run never overwrites newer history.
- Observations for tests absent from a filtered run are preserved.
- Failed, cancelled, or incomplete runs, and zero-valued data, never replace good history.
- Bounded observation window, with a review that history adapts after tests get faster. No endless max-over-history accumulation.
- Separate history per browser, runner class, and worker count unless a normalization is justified.
- Reuse the engine's format and merger first. Change policy only when measurements show a problem.
- Persist in the consuming repo's own Actions storage (artifact or cache); the simplest option that works.

## Deliverables beyond code

Documentation of cold start, refresh, diagnostics (imbalance summary), and rollback.
