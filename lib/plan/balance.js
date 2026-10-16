'use strict';

/**
 * Setup-aware balance of units over shards. A unit is one spec file of one project at one repeat:
 * `{ id, project, file, keys, cost, order, active, unknown, deps }`, where `deps` are the setup and
 * teardown projects it needs. A shard pays for the setup of every unit it hosts, packed by phase,
 * and Playwright's own split is scored last so a balanced plan wins only when it is predicted to be
 * strictly faster.
 *
 * Ported to CommonJS from playwright-shard-balancer@0.1.2 (`src/plan.ts` at commit
 * 4c8f847c94324064e06e30815c1cb1a9369c63f8, https://github.com/qa-gary-parker/playwright-shard-balancer).
 * The search, the setup timer, the family and greedy candidates and the built-in split are
 * unchanged; the plan sha here hashes the full unit ids with sha256 and keeps all 64 characters.
 * That code is under this notice:
 *
 * MIT License
 *
 * Copyright (c) 2026 Gary Parker
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
 * associated documentation files (the "Software"), to deal in the Software without restriction,
 * including without limitation the rights to use, copy, modify, merge, publish, distribute,
 * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or
 * substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
 * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
 * OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

const { sha256 } = require('../util');
const { lowerBound, partition, refineWalls, wallTime } = require('./partition');

const groupPush = (map, key, value) => {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
};

// A shard's setup time: each phase's projects packed onto the workers, longest first, and the
// phases one after another.
function setupTimer(setup, phases, workers) {
  return (deps) => {
    const byPhase = new Map();
    for (const dep of new Set(deps)) {
      const key = phases.has(dep) ? `phase ${phases.get(dep)}` : `own ${dep}`;
      groupPush(byPhase, key, setup.has(dep) ? setup.get(dep) : 0);
    }
    let sum = 0;
    for (const costs of byPhase.values()) {
      const items = costs.sort((a, b) => b - a).map((cost, order) => ({ cost, order }));
      sum += wallTime(items, [...items.keys()], workers);
    }
    return sum;
  };
}

const toItems = (units) => units.map((u) => ({ cost: u.cost, order: u.order }));

// No plan beats this: the shard with the most work pays at least the cheapest setup, and the shard
// with the largest unit pays that unit's setup.
function bound(units, shards, workers, setupTime) {
  let cheapest = Infinity;
  let single = 0;
  for (const u of units) {
    const own = setupTime(u.deps);
    cheapest = Math.min(cheapest, own);
    single = Math.max(single, u.cost + own);
  }
  return units.length
    ? Math.max(lowerBound(toItems(units), shards, workers) + cheapest, single)
    : 0;
}

function build(strategy, algorithm, units, bins, workers, setupTime) {
  const items = toItems(units);
  const shards = bins.map((bin, k) => {
    const list = [...bin].sort((a, b) => units[a].order - units[b].order).map((i) => units[i]);
    const setupMs = setupTime(list.flatMap((u) => u.deps));
    return {
      shard: k + 1,
      units: list,
      tests: list.reduce((acc, u) => acc + u.keys.length, 0),
      files: new Set(list.map((u) => `${u.project}\0${u.file}`)).size,
      sumMs: list.reduce((acc, u) => acc + u.cost, 0),
      setupMs,
      wallMs: setupMs + wallTime(items, bin, workers),
    };
  });
  const largest = units.reduce((best, u) => (!best || u.cost > best.cost ? u : best), null);
  let text = '';
  for (const shard of shards) text += `${shard.shard}:${shard.units.map((u) => u.id).join('\n')}\n`;
  return {
    strategy,
    algorithm,
    shards,
    totalMs: units.reduce((acc, u) => acc + u.cost, 0),
    makespanMs: Math.max(0, ...shards.map((s) => s.wallMs)),
    lowerBoundMs: bound(units, bins.length, workers, setupTime),
    largest: largest && { id: largest.id, costMs: largest.cost },
    unknownTests: units.reduce((acc, u) => acc + u.unknown, 0),
    sha: sha256(text),
  };
}

const spread = (plan) => plan.shards.reduce((acc, s) => acc + s.wallMs * s.wallMs, 0);
const byFinish = (a, b) => a.plan.makespanMs - b.plan.makespanMs || spread(a.plan) - spread(b.plan);
// Splits refined again with setup counted: the best ones, since each pass costs as much as the first.
const SETUP_REFINED = 2;

// When projects need different setup projects, a shard pays for the setup of every family it
// hosts. This candidate gives each family its own shards, sized by its work.
function familyBins(units, shards, workers, setupTime) {
  const families = new Map();
  units.forEach((u, i) => groupPush(families, u.deps.join('\0'), i));
  const list = [...families.values()].map((indices) => {
    const members = indices.map((i) => units[i]);
    return {
      indices,
      setup: setupTime(members.flatMap((u) => u.deps)),
      work: members.reduce((acc, u) => acc + u.cost, 0),
    };
  });
  if (list.length < 2 || list.every((f) => f.setup === 0)) return null;
  const bins = Array.from({ length: shards }, () => []);
  if (shards < list.length) {
    const packed = partition(
      list.map((f, k) => ({ cost: f.work + f.setup, order: k })),
      shards,
      1
    );
    packed.bins.forEach((bin, s) => bin.forEach((k) => bins[s].push(...list[k].indices)));
    return bins;
  }
  const counts = list.map(() => 1);
  for (let extra = shards - list.length; extra > 0; extra--) {
    let best = 0;
    for (let k = 1; k < list.length; k++) {
      if (
        list[k].work / counts[k] + list[k].setup >
        list[best].work / counts[best] + list[best].setup
      ) {
        best = k;
      }
    }
    counts[best]++;
  }
  let next = 0;
  list.forEach((family, k) => {
    const sub = family.indices.map((i) => units[i]);
    for (const bin of partition(toItems(sub), counts[k], workers).bins) {
      bins[next++].push(...bin.map((j) => family.indices[j]));
    }
  });
  return bins;
}

// Largest first, each unit to the shard where it ends soonest, counting the setup the shard does
// not run yet. The other candidates split by work alone or by whole family.
function greedyBins(units, shards, workers, setupTime) {
  const bins = Array.from({ length: shards }, () => []);
  const work = new Array(shards).fill(0);
  const hosted = bins.map(() => new Set());
  const sorted = [...units.keys()].sort(
    (a, b) => units[b].cost - units[a].cost || units[a].order - units[b].order || a - b
  );
  for (const i of sorted) {
    const ends = bins.map(
      (_, s) => (work[s] + units[i].cost) / workers + setupTime([...hosted[s], ...units[i].deps])
    );
    let best = 0;
    for (let s = 1; s < shards; s++) if (ends[s] < ends[best]) best = s;
    work[best] += units[i].cost;
    for (const d of units[i].deps) hosted[best].add(d);
    bins[best].push(i);
  }
  return bins;
}

// Playwright's own split (filterForShard): contiguous runs of groups, sized by test count.
function builtinBins(units, shards) {
  const active = units.map((u) => u.active);
  const sizes = active.some(Boolean) ? active : units.map((u) => u.keys.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const shardSizes = Array.from({ length: shards }, () => Math.floor(total / shards));
  const remainder = total - shardSizes.reduce((a, b) => a + b, 0);
  for (let i = 0; i < remainder; i++) shardSizes[i % shards]++;
  const bins = Array.from({ length: shards }, () => []);
  let current = 0;
  units.forEach((_, index) => {
    const position = sizes[index] ? current : Math.max(current - 1, 0);
    let from = 0;
    for (let k = 0; k < shards; k++) {
      if (position >= from && position < from + shardSizes[k]) {
        bins[k].push(index);
        break;
      }
      from += shardSizes[k];
    }
    current += sizes[index];
  });
  return bins;
}

/**
 * The balanced plan for `shards` shards of `workers` workers. `setup` maps a setup or teardown
 * project to its cost, and `phases` maps it to the phase Playwright runs it in.
 */
function balance(units, shards, workers = 1, setup = new Map(), phases = new Map()) {
  const setupTime = setupTimer(setup, phases, workers);
  const items = toItems(units);
  const result = partition(items, shards, workers);
  const plan = (name, bins) => ({
    bins,
    plan: build('balanced', name, units, bins, workers, setupTime),
  });
  const candidates = [plan(result.algorithm, result.bins)];
  if (units.some((u) => setupTime(u.deps) > 0)) {
    const families = familyBins(units, shards, workers, setupTime);
    if (families) candidates.push(plan('setup-families', families));
    const greedy = greedyBins(units, shards, workers, setupTime);
    candidates.push(
      workers > 1
        ? plan('setup-greedy+workers', refineWalls(items, greedy, workers))
        : plan('setup-greedy', greedy)
    );
    // Which groups share a shard decides what setup it runs, so refine the best splits with setup counted.
    const withSetup = (bin) => setupTime(bin.flatMap((i) => units[i].deps));
    for (const c of [...candidates].sort(byFinish).slice(0, SETUP_REFINED)) {
      candidates.push(
        plan(`${c.plan.algorithm}+setup`, refineWalls(items, c.bins, workers, withSetup))
      );
    }
  }
  // Last, so it wins only when strictly faster: no plan is predicted to be slower than Playwright's own.
  candidates.push(plan('playwright-order', builtinBins(units, shards)));
  return candidates.sort(byFinish)[0].plan;
}

/** Playwright's own split of the same units, priced the same way. */
function builtin(units, shards, workers = 1, setup = new Map(), phases = new Map()) {
  return build(
    'builtin',
    'playwright',
    units,
    builtinBins(units, shards),
    workers,
    setupTimer(setup, phases, workers)
  );
}

module.exports = { balance, builtin };
