'use strict';

/**
 * Pure checks over an intended leaf set and the leaves each shard executed. A shard is
 * `{ index, exitCode, leaves }`. Every check returns violations `{ kind, key | group | shard,
 * detail }` and never throws on bad input, so a broken partition always yields a finding.
 */

function byKey(leaves) {
  return new Map(leaves.map((leaf) => [leaf.key, leaf]));
}

/**
 * Every intended primary leaf runs exactly once across all shards. Dependency leaves are checked
 * by `checkDependencies`. A leaf outside the intended set is `unexpected`.
 */
function checkCoverage(intended, shards) {
  const violations = [];
  const intendedByKey = byKey(intended);
  const counts = new Map();
  for (const shard of shards) {
    for (const leaf of shard.leaves || []) {
      const known = intendedByKey.get(leaf.key);
      if (!known) {
        violations.push({
          kind: 'unexpected',
          key: leaf.key,
          detail: `shard ${shard.index} ran a leaf that is not in the intended set`,
        });
        continue;
      }
      const where = counts.get(leaf.key) || [];
      where.push(shard.index);
      counts.set(leaf.key, where);
    }
  }
  for (const leaf of intended) {
    if (leaf.dependency) continue;
    const where = counts.get(leaf.key) || [];
    if (where.length === 0) {
      violations.push({ kind: 'missing', key: leaf.key, detail: 'no shard ran this leaf' });
    } else if (where.length > 1) {
      violations.push({
        kind: 'duplicate',
        key: leaf.key,
        detail: `ran ${where.length} times, in shards ${where.join(', ')}`,
      });
    }
  }
  return violations;
}

/** Members of one serial group never land in two shards. */
function checkSerialGroups(intended, shards) {
  const groupOf = new Map();
  for (const leaf of intended) {
    if (leaf.serialGroup && !leaf.dependency) groupOf.set(leaf.key, leaf.serialGroup);
  }
  const placement = new Map();
  for (const shard of shards) {
    for (const leaf of shard.leaves || []) {
      const group = groupOf.get(leaf.key);
      if (!group) continue;
      const set = placement.get(group) || new Set();
      set.add(shard.index);
      placement.set(group, set);
    }
  }
  const violations = [];
  for (const [group, set] of placement) {
    if (set.size > 1) {
      violations.push({
        kind: 'serial-split',
        group,
        detail: `members ran in shards ${[...set].sort((a, b) => a - b).join(', ')}`,
      });
    }
  }
  return violations;
}

/** Projects a set of projects needs, following dependencies transitively. */
function requiredProjects(projects, dependencies) {
  const needed = new Set();
  const queue = [...projects];
  while (queue.length > 0) {
    const project = queue.pop();
    for (const dependency of dependencies[project] || []) {
      if (!needed.has(dependency)) {
        needed.add(dependency);
        queue.push(dependency);
      }
    }
  }
  return needed;
}

/**
 * A shard that runs a dependent leaf runs each setup and teardown leaf of that project exactly
 * once. `dependencies` maps a project to the projects it depends on.
 */
function checkDependencies(intended, shards, dependencies) {
  const violations = [];
  const intendedByKey = byKey(intended);
  for (const shard of shards) {
    const executed = shard.leaves || [];
    const primaryProjects = new Set(
      executed
        .filter((leaf) => intendedByKey.has(leaf.key) && !intendedByKey.get(leaf.key).dependency)
        .map((leaf) => leaf.project)
    );
    const counts = new Map();
    for (const leaf of executed) {
      const known = intendedByKey.get(leaf.key);
      if (known && known.dependency) counts.set(leaf.key, (counts.get(leaf.key) || 0) + 1);
    }
    const needed = requiredProjects(primaryProjects, dependencies);
    for (const leaf of intended) {
      if (!leaf.dependency || !needed.has(leaf.project)) continue;
      const count = counts.get(leaf.key) || 0;
      if (count === 0) {
        violations.push({
          kind: 'dependency-missing',
          shard: shard.index,
          key: leaf.key,
          detail: `shard ${shard.index} runs dependent leaves but not this dependency leaf`,
        });
      }
    }
    for (const [key, count] of counts) {
      if (count > 1) {
        violations.push({
          kind: 'dependency-duplicate',
          shard: shard.index,
          key,
          detail: `shard ${shard.index} ran this dependency leaf ${count} times`,
        });
      }
    }
  }
  return violations;
}

/** A shard that exited nonzero or wrote no leaves file failed. */
function checkShardRuns(shards) {
  const violations = [];
  for (const shard of shards) {
    if (shard.exitCode !== 0) {
      violations.push({
        kind: 'shard-failed',
        shard: shard.index,
        detail: `shard ${shard.index} exited with code ${shard.exitCode}`,
      });
    } else if (!shard.leaves) {
      violations.push({
        kind: 'shard-failed',
        shard: shard.index,
        detail: `shard ${shard.index} reported no leaves file`,
      });
    }
  }
  return violations;
}

/** Executions of each dependency leaf summed over all shards, keyed by leaf key. */
function countDependencyExecutions(intended, shards) {
  const dependencyKeys = new Set(
    intended.filter((leaf) => leaf.dependency).map((leaf) => leaf.key)
  );
  const counts = {};
  for (const shard of shards) {
    for (const leaf of shard.leaves || []) {
      if (dependencyKeys.has(leaf.key)) counts[leaf.key] = (counts[leaf.key] || 0) + 1;
    }
  }
  return counts;
}

/** `(slowest - mean) / mean` over shard `durationMs`. Zero when there is nothing to compare. */
function imbalance(shards) {
  if (shards.length === 0) return 0;
  const durations = shards.map((shard) => shard.durationMs);
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  if (mean === 0) return 0;
  return (Math.max(...durations) - mean) / mean;
}

module.exports = {
  checkCoverage,
  checkDependencies,
  checkSerialGroups,
  checkShardRuns,
  countDependencyExecutions,
  imbalance,
};
