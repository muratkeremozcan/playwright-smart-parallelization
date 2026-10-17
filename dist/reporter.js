"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};

// lib/util.js
var require_util = __commonJS({
  "lib/util.js"(exports2, module2) {
    "use strict";
    var crypto = require("node:crypto");
    var fs2 = require("node:fs");
    var path2 = require("node:path");
    var sha2562 = (data) => crypto.createHash("sha256").update(data).digest("hex");
    var short2 = (sha) => sha ? String(sha).slice(0, 12) : "-";
    function sortKeys(value) {
      if (Array.isArray(value)) return value.map(sortKeys);
      if (value && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
        return out;
      }
      return value;
    }
    var canonicalJson = (value) => `${JSON.stringify(sortKeys(value))}
`;
    function writeAtomic2(file, text) {
      fs2.mkdirSync(path2.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs2.writeFileSync(tmp, text);
      fs2.renameSync(tmp, file);
    }
    function readJsonFile(file) {
      return JSON.parse(fs2.readFileSync(file, "utf8"));
    }
    function formatMs2(ms) {
      if (ms === null || ms === void 0 || !Number.isFinite(ms)) return "-";
      if (ms < 1e4) return `${(ms / 1e3).toFixed(1)}s`;
      const s = Math.round(ms / 1e3);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
      return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
    }
    async function mapLimit(items, limit, fn) {
      const results = new Array(items.length);
      let next = 0;
      let failed = null;
      const lane = async () => {
        while (next < items.length && !failed) {
          const index = next++;
          try {
            results[index] = await fn(items[index], index);
          } catch (error) {
            failed = failed || { error };
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
      if (failed) throw failed.error;
      return results;
    }
    function compareVersions(a, b) {
      const pa = String(a).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
      const pb = String(b).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
      for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
      }
      return 0;
    }
    module2.exports = {
      canonicalJson,
      compareVersions,
      formatMs: formatMs2,
      mapLimit,
      readJsonFile,
      sha256: sha2562,
      short: short2,
      sortKeys,
      writeAtomic: writeAtomic2
    };
  }
});

// lib/plan/partition.js
var require_partition = __commonJS({
  "lib/plan/partition.js"(exports2, module2) {
    "use strict";
    var SUM_ITERATIONS = 2e4;
    var SEARCH_NODES = 4e5;
    var WALL_ITERATIONS = 200;
    var WALL_CANDIDATES = 48;
    var WALL_TARGETS = 4;
    var WALL_SWAP_VISITS = 1e5;
    function wallTime(items, bin, workers) {
      let sum = 0;
      for (const i of bin) sum += items[i].cost;
      if (workers <= 1 || bin.length <= 1) return sum;
      const free = new Array(Math.min(workers, bin.length)).fill(0);
      const ordered = [...bin].sort((a, b) => items[a].order - items[b].order || a - b);
      for (const i of ordered) {
        let w = 0;
        for (let k = 1; k < free.length; k++) if (free[k] < free[w]) w = k;
        free[w] += items[i].cost;
      }
      return Math.max(...free);
    }
    function lowerBound(items, n, workers) {
      let total = 0;
      let largest = 0;
      for (const item of items) {
        total += item.cost;
        largest = Math.max(largest, item.cost);
      }
      return Math.max(Math.ceil(total / (n * Math.max(1, workers))), largest);
    }
    function lpt(items, n, sorted) {
      const bins = Array.from({ length: n }, () => []);
      const sums = new Array(n).fill(0);
      for (const i of sorted) {
        let best = 0;
        for (let s = 1; s < n; s++) if (sums[s] < sums[best]) best = s;
        bins[best].push(i);
        sums[best] += items[i].cost;
      }
      return bins;
    }
    function flatten(rope, out) {
      const stack = [rope];
      while (stack.length) {
        const r = stack.pop();
        if (r.items) out.push(...r.items);
        if (r.parts) stack.push(r.parts[1], r.parts[0]);
      }
      return out;
    }
    var Heap = class {
      constructor(before) {
        this.before = before;
        this.data = [];
      }
      get size() {
        return this.data.length;
      }
      push(value) {
        const d = this.data;
        d.push(value);
        let i = d.length - 1;
        while (i > 0) {
          const p = i - 1 >> 1;
          if (!this.before(d[i], d[p])) break;
          [d[i], d[p]] = [d[p], d[i]];
          i = p;
        }
      }
      pop() {
        const d = this.data;
        const top = d[0];
        const last = d.pop();
        if (d.length) {
          d[0] = last;
          let i = 0;
          for (; ; ) {
            const l = 2 * i + 1;
            const r = l + 1;
            let m = i;
            if (l < d.length && this.before(d[l], d[m])) m = l;
            if (r < d.length && this.before(d[r], d[m])) m = r;
            if (m === i) break;
            [d[i], d[m]] = [d[m], d[i]];
            i = m;
          }
        }
        return top;
      }
    };
    function karmarkarKarp(items, n, sorted) {
      let seq = 0;
      const spread = (p) => p.sums[0] - p.sums[n - 1];
      const heap = new Heap(
        (a, b) => spread(a) > spread(b) || spread(a) === spread(b) && a.seq < b.seq
      );
      for (const i of sorted) {
        const sums = new Array(n).fill(0);
        sums[0] = items[i].cost;
        const sets = Array.from({ length: n }, (_, k) => ({ items: k === 0 ? [i] : [] }));
        heap.push({ sums, sets, seq: seq++ });
      }
      if (heap.size === 0) return Array.from({ length: n }, () => []);
      while (heap.size > 1) {
        const a = heap.pop();
        const b = heap.pop();
        const merged = Array.from({ length: n }, (_, k) => ({
          sum: a.sums[k] + b.sums[n - 1 - k],
          set: { parts: [a.sets[k], b.sets[n - 1 - k]] },
          k
        }));
        merged.sort((x, y) => y.sum - x.sum || x.k - y.k);
        heap.push({ sums: merged.map((m) => m.sum), sets: merged.map((m) => m.set), seq: seq++ });
      }
      return heap.pop().sets.map((set) => flatten(set, []));
    }
    function search(items, n, sorted, incumbent) {
      const m = sorted.length;
      const cost = sorted.map((i) => items[i].cost);
      const remaining = new Array(m + 1).fill(0);
      for (let k = m - 1; k >= 0; k--) remaining[k] = remaining[k + 1] + cost[k];
      const total = remaining[0];
      const floor = Math.max(Math.ceil(total / n), cost[0] === void 0 ? 0 : cost[0]);
      if (incumbent <= floor) return null;
      const loads = new Array(n).fill(0);
      const assign = new Array(m).fill(0);
      let best = incumbent;
      let bestAssign = null;
      let nodes = 0;
      const frames = [];
      const open = (maxLoad) => {
        if (++nodes > SEARCH_NODES) return "stop";
        if (maxLoad >= best) return "back";
        if (frames.length === m) {
          best = maxLoad;
          bestAssign = [...assign];
          return best <= floor ? "stop" : "back";
        }
        frames.push({
          maxLoad,
          order: [...loads.keys()].sort((a, b) => loads[a] - loads[b] || a - b),
          next: 0,
          last: -1,
          placed: -1
        });
        return "open";
      };
      let state = open(0);
      while (state !== "stop" && frames.length) {
        const k = frames.length - 1;
        const frame = frames[k];
        if (frame.placed !== -1) loads[frame.placed] -= cost[k];
        frame.placed = -1;
        while (frame.next < frame.order.length) {
          const s = frame.order[frame.next++];
          if (loads[s] === frame.last) continue;
          frame.last = loads[s];
          if (loads[s] + cost[k] >= best) frame.next = frame.order.length;
          else frame.placed = s;
          break;
        }
        if (frame.placed === -1) {
          frames.pop();
          continue;
        }
        loads[frame.placed] += cost[k];
        assign[k] = frame.placed;
        state = open(Math.max(frame.maxLoad, loads[frame.placed]));
      }
      if (!bestAssign) return null;
      const bins = Array.from({ length: n }, () => []);
      bestAssign.forEach((s, k) => bins[s].push(sorted[k]));
      return bins;
    }
    function refineSums(items, bins) {
      const n = bins.length;
      const cost = (i) => items[i].cost;
      const byCost = (a, b) => cost(a) - cost(b) || a - b;
      const sorted = bins.map((b) => [...b].sort(byCost));
      const sums = sorted.map((b) => b.reduce((acc, i) => acc + cost(i), 0));
      for (let iter = 0; iter < SUM_ITERATIONS; iter++) {
        let s = 0;
        for (let k = 1; k < n; k++) if (sums[k] > sums[s]) s = k;
        let best = { score: 0, t: -1, a: -1, b: -1 };
        for (let t = 0; t < n; t++) {
          const gap = sums[s] - sums[t];
          if (t === s || gap <= 1) continue;
          const src = sorted[s];
          const dst = sorted[t];
          let j = 0;
          for (const a of src) {
            const ca = cost(a);
            if (ca <= 0) continue;
            if (ca < gap) {
              const score = ca * (gap - ca);
              if (score > best.score) best = { score, t, a, b: -1 };
            }
            const target = ca - gap / 2;
            while (j < dst.length && cost(dst[j]) < target) j++;
            for (const k of [j - 1, j]) {
              if (k < 0 || k >= dst.length) continue;
              const d = ca - cost(dst[k]);
              if (d <= 0 || d >= gap) continue;
              const score = d * (gap - d);
              if (score > best.score) best = { score, t, a, b: dst[k] };
            }
          }
        }
        if (best.t === -1) break;
        const remove = (arr, i) => arr.splice(arr.indexOf(i), 1);
        const insert = (arr, i) => {
          let lo = 0;
          let hi = arr.length;
          while (lo < hi) {
            const mid = lo + hi >> 1;
            if (byCost(arr[mid], i) < 0) lo = mid + 1;
            else hi = mid;
          }
          arr.splice(lo, 0, i);
        };
        remove(sorted[s], best.a);
        insert(sorted[best.t], best.a);
        sums[s] -= cost(best.a);
        sums[best.t] += cost(best.a);
        if (best.b !== -1) {
          remove(sorted[best.t], best.b);
          insert(sorted[s], best.b);
          sums[best.t] -= cost(best.b);
          sums[s] += cost(best.b);
        }
      }
      return sorted;
    }
    function refineWalls(items, bins, workers, extra = () => 0) {
      const n = bins.length;
      const result = bins.map((b) => [...b]);
      const wall = (bin) => wallTime(items, bin, workers) + extra(bin);
      const walls = result.map(wall);
      let visits = WALL_SWAP_VISITS;
      for (let iter = 0; iter < WALL_ITERATIONS; iter++) {
        let s = 0;
        for (let k = 1; k < n; k++) if (walls[k] > walls[s]) s = k;
        const targets = [...walls.keys()].filter((t2) => t2 !== s).sort((a2, b2) => walls[a2] - walls[b2] || a2 - b2).slice(0, WALL_TARGETS);
        const candidates = [...result[s]].sort((a2, b2) => items[b2].cost - items[a2].cost || a2 - b2).slice(0, WALL_CANDIDATES);
        let best = null;
        const consider = (t2, a2, b2, ws, wt) => {
          const max = Math.max(ws, wt);
          const sq = ws * ws + wt * wt;
          if (max < walls[s] && (!best || max < best.max || max === best.max && sq < best.sq)) {
            best = { t: t2, a: a2, b: b2, ws, wt, max, sq };
          }
        };
        for (const a2 of candidates) {
          const ws = wall(result[s].filter((i) => i !== a2));
          for (const t2 of targets) consider(t2, a2, -1, ws, wall([...result[t2], a2]));
        }
        swaps: for (const t2 of best ? [] : targets) {
          const partners = [...result[t2]].sort((x, y) => items[y].cost - items[x].cost || x - y).slice(0, WALL_CANDIDATES);
          for (const a2 of candidates) {
            for (const b2 of partners) {
              if (items[b2].cost >= items[a2].cost) continue;
              if ((visits -= result[s].length + result[t2].length) < 0) break swaps;
              const ws = wall([...result[s].filter((i) => i !== a2), b2]);
              consider(t2, a2, b2, ws, wall([...result[t2].filter((i) => i !== b2), a2]));
            }
          }
        }
        if (!best) break;
        const { t, a, b } = best;
        result[s] = result[s].filter((i) => i !== a);
        result[t].push(a);
        if (b !== -1) {
          result[t] = result[t].filter((i) => i !== b);
          result[s].push(b);
        }
        walls[s] = best.ws;
        walls[t] = best.wt;
      }
      return result;
    }
    function evaluate(items, bins, workers, algorithm, bound) {
      const ordered = bins.map((b) => [...b].sort((a, c) => items[a].order - items[c].order || a - c));
      const sums = ordered.map((b) => b.reduce((acc, i) => acc + items[i].cost, 0));
      const walls = ordered.map((b) => wallTime(items, b, workers));
      return {
        bins: ordered,
        sums,
        walls,
        makespan: Math.max(0, ...walls),
        lowerBound: bound,
        algorithm
      };
    }
    var spreadScore = (p) => p.walls.reduce((acc, w) => acc + w * w, 0);
    function partition(items, n, workers = 1) {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`shard count must be a positive integer, got ${n}`);
      }
      const w = Math.max(1, Math.floor(workers));
      const bound = lowerBound(items, n, w);
      const sorted = [...items.keys()].sort(
        (a, b) => items[b].cost - items[a].cost || items[a].order - items[b].order || a - b
      );
      const sumMax = (bins) => Math.max(0, ...bins.map((b) => b.reduce((acc, i) => acc + items[i].cost, 0)));
      const splits = [
        ["lpt+refine", refineSums(items, lpt(items, n, sorted))],
        ["kk+refine", refineSums(items, karmarkarKarp(items, n, sorted))]
      ];
      const exact = search(items, n, sorted, Math.min(...splits.map(([, bins]) => sumMax(bins))));
      if (exact) splits.push(["search", exact]);
      const candidates = splits.map(
        ([name, bins]) => w > 1 ? evaluate(items, refineWalls(items, bins, w), w, `${name}+workers`, bound) : evaluate(items, bins, w, name, bound)
      );
      candidates.sort((a, b) => a.makespan - b.makespan || spreadScore(a) - spreadScore(b));
      return candidates[0];
    }
    module2.exports = { lowerBound, partition, refineWalls, wallTime };
  }
});

// lib/plan/balance.js
var require_balance = __commonJS({
  "lib/plan/balance.js"(exports2, module2) {
    "use strict";
    var { sha256: sha2562 } = require_util();
    var { lowerBound, partition, refineWalls, wallTime } = require_partition();
    var groupPush = (map, key, value) => {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(value);
    };
    function setupTimer(setup, phases, workers) {
      return (deps) => {
        const byPhase = /* @__PURE__ */ new Map();
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
    var toItems = (units) => units.map((u) => ({ cost: u.cost, order: u.order }));
    function bound(units, shards, workers, setupTime) {
      let cheapest = Infinity;
      let single = 0;
      for (const u of units) {
        const own = setupTime(u.deps);
        cheapest = Math.min(cheapest, own);
        single = Math.max(single, u.cost + own);
      }
      return units.length ? Math.max(lowerBound(toItems(units), shards, workers) + cheapest, single) : 0;
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
          wallMs: setupMs + wallTime(items, bin, workers)
        };
      });
      const largest = units.reduce((best, u) => !best || u.cost > best.cost ? u : best, null);
      let text = "";
      for (const shard of shards) text += `${shard.shard}:${shard.units.map((u) => u.id).join("\n")}
`;
      return {
        strategy,
        algorithm,
        shards,
        totalMs: units.reduce((acc, u) => acc + u.cost, 0),
        makespanMs: Math.max(0, ...shards.map((s) => s.wallMs)),
        lowerBoundMs: bound(units, bins.length, workers, setupTime),
        largest: largest && { id: largest.id, costMs: largest.cost },
        unknownTests: units.reduce((acc, u) => acc + u.unknown, 0),
        sha: sha2562(text)
      };
    }
    var spread = (plan) => plan.shards.reduce((acc, s) => acc + s.wallMs * s.wallMs, 0);
    var byFinish = (a, b) => a.plan.makespanMs - b.plan.makespanMs || spread(a.plan) - spread(b.plan);
    var SETUP_REFINED = 2;
    function familyBins(units, shards, workers, setupTime) {
      const families = /* @__PURE__ */ new Map();
      units.forEach((u, i) => groupPush(families, u.deps.join("\0"), i));
      const list = [...families.values()].map((indices) => {
        const members = indices.map((i) => units[i]);
        return {
          indices,
          setup: setupTime(members.flatMap((u) => u.deps)),
          work: members.reduce((acc, u) => acc + u.cost, 0)
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
          if (list[k].work / counts[k] + list[k].setup > list[best].work / counts[best] + list[best].setup) {
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
    function greedyBins(units, shards, workers, setupTime) {
      const bins = Array.from({ length: shards }, () => []);
      const work = new Array(shards).fill(0);
      const hosted = bins.map(() => /* @__PURE__ */ new Set());
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
    function balance2(units, shards, workers = 1, setup = /* @__PURE__ */ new Map(), phases = /* @__PURE__ */ new Map()) {
      const setupTime = setupTimer(setup, phases, workers);
      const items = toItems(units);
      const result = partition(items, shards, workers);
      const plan = (name, bins) => ({
        bins,
        plan: build("balanced", name, units, bins, workers, setupTime)
      });
      const candidates = [plan(result.algorithm, result.bins)];
      if (units.some((u) => setupTime(u.deps) > 0)) {
        const families = familyBins(units, shards, workers, setupTime);
        if (families) candidates.push(plan("setup-families", families));
        const greedy = greedyBins(units, shards, workers, setupTime);
        candidates.push(
          workers > 1 ? plan("setup-greedy+workers", refineWalls(items, greedy, workers)) : plan("setup-greedy", greedy)
        );
        const withSetup = (bin) => setupTime(bin.flatMap((i) => units[i].deps));
        for (const c of [...candidates].sort(byFinish).slice(0, SETUP_REFINED)) {
          candidates.push(
            plan(`${c.plan.algorithm}+setup`, refineWalls(items, c.bins, workers, withSetup))
          );
        }
      }
      candidates.push(plan("playwright-order", builtinBins(units, shards)));
      return candidates.sort(byFinish)[0].plan;
    }
    function builtin(units, shards, workers = 1, setup = /* @__PURE__ */ new Map(), phases = /* @__PURE__ */ new Map()) {
      return build(
        "builtin",
        "playwright",
        units,
        builtinBins(units, shards),
        workers,
        setupTimer(setup, phases, workers)
      );
    }
    module2.exports = { balance: balance2, builtin };
  }
});

// lib/plan/estimate.js
var require_estimate = __commonJS({
  "lib/plan/estimate.js"(exports2, module2) {
    "use strict";
    function median(values) {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
    }
    var testKey2 = (project, file, titles) => JSON.stringify([project, file, ...titles]);
    var scopeKey = (parts) => JSON.stringify(parts);
    function createEstimator2(tests = {}) {
      const known = /* @__PURE__ */ new Map();
      const byParent = /* @__PURE__ */ new Map();
      const byFile = /* @__PURE__ */ new Map();
      const byProject = /* @__PURE__ */ new Map();
      const all = [];
      const push = (map, key, value) => {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(value);
      };
      for (const key of Object.keys(tests).sort()) {
        const value = median(tests[key].samples.map((sample) => sample[1]));
        known.set(key, value);
        all.push(value);
        const parts = JSON.parse(key);
        const fileScope = scopeKey(parts.slice(0, 2));
        if (parts.length > 3) push(byParent, scopeKey(parts.slice(0, -1)), value);
        push(byFile, fileScope, value);
        push(byProject, parts[0], value);
      }
      const cache = /* @__PURE__ */ new Map();
      const groupMedian = (id, values) => {
        if (!values || !values.length) return void 0;
        if (!cache.has(id)) cache.set(id, median(values));
        return cache.get(id);
      };
      const globalMedian = all.length ? median(all) : 1;
      const first = (...values) => values.find((value) => value !== void 0);
      return {
        knownCount: known.size,
        isKnown: (key) => known.has(key),
        estimate: ({ key, staticSkip = false }) => {
          if (staticSkip) return 0;
          if (known.has(key)) return known.get(key);
          const parts = JSON.parse(key);
          const parent = parts.length > 3 ? scopeKey(parts.slice(0, -1)) : null;
          const fileScope = scopeKey(parts.slice(0, 2));
          return first(
            parent ? groupMedian(`d:${parent}`, byParent.get(parent)) : void 0,
            groupMedian(`f:${fileScope}`, byFile.get(fileScope)),
            groupMedian(`p:${parts[0]}`, byProject.get(parts[0])),
            globalMedian
          );
        }
      };
    }
    module2.exports = { createEstimator: createEstimator2, median, testKey: testKey2 };
  }
});

// lib/plan/units.js
var require_units = __commonJS({
  "lib/plan/units.js"(exports2, module2) {
    "use strict";
    function dependencyProjects2(projects, names) {
      const byName = new Map(projects.map((p) => [p.name, p]));
      const deps = /* @__PURE__ */ new Set();
      const visit = (name, depth) => {
        if (depth > 0) {
          if (deps.has(name)) return;
          deps.add(name);
        }
        const project = byName.get(name);
        for (const dep of project && project.dependencies || []) visit(dep, depth + 1);
        if (project && project.teardown) visit(project.teardown, depth + 1);
      };
      for (const name of new Set(names)) visit(name, 0);
      return deps;
    }
    function setupPhases2(projects, names) {
      const byName = new Map(projects.map((p) => [p.name, p]));
      const setups = dependencyProjects2(projects, names);
      const running = /* @__PURE__ */ new Set([...names, ...setups]);
      const needs = (name, setup) => dependencyProjects2(projects, [name]).has(setup);
      const waitsFor = new Map(
        [...running].map((name) => [
          name,
          (byName.get(name) && byName.get(name).dependencies || []).filter((d) => running.has(d))
        ])
      );
      for (const setup of running) {
        const teardown = byName.get(setup) && byName.get(setup).teardown;
        if (teardown && running.has(teardown)) {
          waitsFor.get(teardown).push(setup, ...[...running].filter((p) => p !== teardown && needs(p, setup)));
        }
      }
      const phases = /* @__PURE__ */ new Map();
      const phaseOf = (name, path2 = /* @__PURE__ */ new Set()) => {
        if (phases.has(name)) return phases.get(name);
        if (path2.has(name)) return 0;
        path2.add(name);
        const phase = Math.max(-1, ...(waitsFor.get(name) || []).map((d) => phaseOf(d, path2))) + 1;
        path2.delete(name);
        phases.set(name, phase);
        return phase;
      };
      return new Map([...setups].map((name) => [name, phaseOf(name)]));
    }
    var unitId = (project, file, repeat) => JSON.stringify([project, file, repeat]);
    function buildUnits2(tests, estimator, depsOf) {
      const units = /* @__PURE__ */ new Map();
      const members = /* @__PURE__ */ new Map();
      tests.forEach((test, index) => {
        const id = unitId(test.project, test.file, test.repeat);
        let unit = units.get(id);
        if (!unit) {
          unit = {
            id,
            project: test.project,
            file: test.file,
            keys: [],
            cost: 0,
            order: units.size,
            active: 0,
            unknown: 0,
            deps: depsOf(test.project)
          };
          units.set(id, unit);
          members.set(id, []);
        }
        unit.keys.push(test.key);
        unit.cost += estimator.estimate(test);
        if (!test.staticSkip) unit.active++;
        if (!test.staticSkip && !estimator.isKnown(test.key)) unit.unknown++;
        members.get(id).push(index);
      });
      return { units: [...units.values()], members };
    }
    function setupCosts2(setupTests, estimator) {
      const costs = /* @__PURE__ */ new Map();
      for (const test of setupTests) {
        costs.set(test.project, (costs.get(test.project) || 0) + estimator.estimate(test));
      }
      return costs;
    }
    module2.exports = { buildUnits: buildUnits2, dependencyProjects: dependencyProjects2, setupCosts: setupCosts2, setupPhases: setupPhases2, unitId };
  }
});

// lib/history.js
var require_history = __commonJS({
  "lib/history.js"(exports2, module2) {
    "use strict";
    var { canonicalJson, sha256: sha2562 } = require_util();
    var { median } = require_estimate();
    var SCHEMA = "playwright-smart-parallelization/history";
    var VERSION = 1;
    var MAX_SAMPLES = 5;
    var MAX_RUNS = 200;
    var EXPIRE_DAYS = 30;
    var DATE = /^\d{4}-\d{2}-\d{2}$/;
    var isRunId = (value) => Number.isSafeInteger(value) && value > 0;
    var isMs = (value) => Number.isSafeInteger(value) && value > 0;
    function emptyHistory(key) {
      return { schema: SCHEMA, version: VERSION, key, source: null, runs: [], tests: {} };
    }
    function fail(source, message) {
      throw new Error(`${source} ${message}`);
    }
    function validateHistory(data, { key = null, source = "the history" } = {}) {
      if (!data || typeof data !== "object" || Array.isArray(data)) fail(source, "is not an object");
      if (data.schema !== SCHEMA) fail(source, `has schema ${JSON.stringify(data.schema)}`);
      if (data.version !== VERSION)
        fail(source, `has unsupported version ${JSON.stringify(data.version)}`);
      if (typeof data.key !== "string" || !data.key) fail(source, "has no key");
      if (key !== null && data.key !== key) {
        fail(source, `belongs to history key ${data.key}, not ${key}`);
      }
      const allowed = ["key", "runs", "schema", "source", "tests", "version"];
      const extra = Object.keys(data).filter((name) => !allowed.includes(name));
      if (extra.length) fail(source, `has unknown fields: ${extra.join(", ")}`);
      if (data.source !== null) {
        const s = data.source;
        const valid = s && typeof s === "object" && isRunId(s.run) && Number.isSafeInteger(s.attempt) && s.attempt > 0 && typeof s.commit === "string" && typeof s.fingerprint === "string" && typeof s.date === "string" && DATE.test(s.date) && Object.keys(s).length === 5;
        if (!valid) fail(source, "has an invalid source");
      }
      if (!Array.isArray(data.runs) || data.runs.length > MAX_RUNS || !data.runs.every((run, i) => isRunId(run) && (i === 0 || data.runs[i - 1] < run))) {
        fail(source, "has an invalid runs list");
      }
      if (!data.tests || typeof data.tests !== "object" || Array.isArray(data.tests)) {
        fail(source, "has no tests object");
      }
      for (const [testKey2, entry] of Object.entries(data.tests)) {
        let parts;
        try {
          parts = JSON.parse(testKey2);
        } catch {
          parts = null;
        }
        const keyOk = Array.isArray(parts) && parts.length >= 3 && parts.every((part) => typeof part === "string");
        const samples = entry && entry.samples;
        const samplesOk = Array.isArray(samples) && samples.length >= 1 && samples.length <= MAX_SAMPLES && samples.every(
          (sample, i) => Array.isArray(sample) && sample.length === 2 && isRunId(sample[0]) && isMs(sample[1]) && (i === 0 || samples[i - 1][0] < sample[0])
        );
        const seenOk = entry && typeof entry.seen === "string" && DATE.test(entry.seen);
        if (!keyOk || !samplesOk || !seenOk || Object.keys(entry).length !== 2) {
          fail(source, `has an invalid entry for ${testKey2}`);
        }
      }
      return data;
    }
    var serializeHistory = (history) => canonicalJson(history);
    function parseHistory2(text, { key = null, source = "the history" } = {}) {
      let data;
      try {
        data = JSON.parse(text);
      } catch (error) {
        throw new Error(`${source} is not valid JSON: ${error.message}`, { cause: error });
      }
      validateHistory(data, { key, source });
      if (serializeHistory(data) !== text) fail(source, "is not in its canonical byte form");
      return data;
    }
    var historySha = (text) => sha2562(text);
    var laterSource = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      if (a.run !== b.run) return a.run > b.run ? a : b;
      return canonicalJson(a) >= canonicalJson(b) ? a : b;
    };
    function unionSamples(...lists) {
      const byRun = /* @__PURE__ */ new Map();
      for (const list of lists) {
        for (const [run, ms] of list) {
          if (!byRun.has(run) || ms < byRun.get(run)) byRun.set(run, ms);
        }
      }
      return [...byRun.entries()].sort((a, b) => a[0] - b[0]).slice(-MAX_SAMPLES).map(([run, ms]) => [run, ms]);
    }
    var unionRuns = (...lists) => [...new Set(lists.flat())].sort((a, b) => a - b).slice(-MAX_RUNS);
    function mergeHistories(a, b) {
      if (a.key !== b.key) throw new Error(`cannot merge histories of keys ${a.key} and ${b.key}`);
      const tests = {};
      for (const testKey2 of /* @__PURE__ */ new Set([...Object.keys(a.tests), ...Object.keys(b.tests)])) {
        const x = a.tests[testKey2];
        const y = b.tests[testKey2];
        tests[testKey2] = {
          samples: unionSamples(x ? x.samples : [], y ? y.samples : []),
          seen: [x && x.seen, y && y.seen].filter(Boolean).sort().pop()
        };
      }
      return {
        schema: SCHEMA,
        version: VERSION,
        key: a.key,
        source: laterSource(a.source, b.source),
        runs: unionRuns(a.runs, b.runs),
        tests
      };
    }
    var daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 864e5);
    function runSamples(records) {
      const byKey = /* @__PURE__ */ new Map();
      for (const record of records) {
        for (const test of record.tests) {
          if (!isMs(test.sample_ms)) continue;
          if (!byKey.has(test.key)) byKey.set(test.key, []);
          byKey.get(test.key).push(test.sample_ms);
        }
      }
      const samples = /* @__PURE__ */ new Map();
      for (const key of [...byKey.keys()].sort()) samples.set(key, median(byKey.get(key)));
      return samples;
    }
    function hasRun(history, runId) {
      return history.runs.length >= MAX_RUNS && runId < history.runs[0];
    }
    function applyRun(history, run) {
      if (hasRun(history, run.id)) return { applied: false, history };
      const tests = {};
      for (const [testKey2, entry] of Object.entries(history.tests)) {
        if (run.samples.has(testKey2) || daysBetween(entry.seen, run.date) <= EXPIRE_DAYS) {
          tests[testKey2] = { samples: entry.samples.map((s) => [s[0], s[1]]), seen: entry.seen };
        }
      }
      for (const [testKey2, ms] of run.samples) {
        const entry = tests[testKey2];
        tests[testKey2] = {
          samples: unionSamples(entry ? entry.samples : [], [[run.id, ms]]),
          seen: entry && entry.seen > run.date ? entry.seen : run.date
        };
      }
      const source = {
        run: run.id,
        attempt: run.attempt,
        commit: run.commit,
        fingerprint: run.fingerprint,
        date: run.date
      };
      const next = {
        schema: SCHEMA,
        version: VERSION,
        key: history.key,
        source: laterSource(history.source, source),
        runs: unionRuns(history.runs, [run.id]),
        tests
      };
      if (serializeHistory(next) === serializeHistory(history)) return { applied: false, history };
      return { applied: true, history: next };
    }
    module2.exports = {
      EXPIRE_DAYS,
      MAX_RUNS,
      MAX_SAMPLES,
      SCHEMA,
      VERSION,
      applyRun,
      emptyHistory,
      hasRun,
      historySha,
      mergeHistories,
      parseHistory: parseHistory2,
      runSamples,
      serializeHistory,
      validateHistory
    };
  }
});

// lib/check.js
var require_check = __commonJS({
  "lib/check.js"(exports2, module2) {
    "use strict";
    var { sha256: sha2562 } = require_util();
    var RECORD_SCHEMA2 = "playwright-smart-parallelization/record";
    var RECORD_VERSION2 = 1;
    var STATUS_SCHEMA = "playwright-smart-parallelization/status";
    var START_SCHEMA = "playwright-smart-parallelization/start";
    var names = (ids) => ids.length > 10 ? `${ids.slice(0, 10).join(", ")} and ${ids.length - 10} more` : ids.join(", ");
    function validateRecord(data, source = "a record") {
      const ok = data && data.schema === RECORD_SCHEMA2 && data.version === RECORD_VERSION2 && data.run && Number.isSafeInteger(data.run.id) && Number.isSafeInteger(data.run.attempt) && data.shard && Number.isSafeInteger(data.shard.current) && Number.isSafeInteger(data.shard.total) && typeof data.mode === "string" && Array.isArray(data.tests) && data.tests.every(
        (t) => t && typeof t.id === "string" && typeof t.key === "string" && Number.isSafeInteger(t.repeat) && typeof t.ran === "boolean" && typeof t.outcome === "string"
      ) && (data.corpus === null || Array.isArray(data.corpus) && data.corpus.every((c) => Array.isArray(c) && typeof c[0] === "string"));
      if (!ok) throw new Error(`${source} is not a run record of this Action`);
      return data;
    }
    function validateStatus(data, source = "a status record") {
      const ok = data && data.schema === STATUS_SCHEMA && data.version === RECORD_VERSION2 && data.mode === "disabled" && data.run && Number.isSafeInteger(data.run.id) && Number.isSafeInteger(data.run.attempt) && typeof data.key === "string" && typeof data.job === "string";
      if (!ok) throw new Error(`${source} is not a status record of this Action`);
      return data;
    }
    function validateStart(data, source = "a start marker") {
      const ok = data && data.schema === START_SCHEMA && data.version === RECORD_VERSION2 && typeof data.token === "string" && data.token !== "" && data.run && Number.isSafeInteger(data.run.id) && Number.isSafeInteger(data.run.attempt) && typeof data.key === "string" && typeof data.job === "string";
      if (!ok) throw new Error(`${source} is not a start marker of this Action`);
      return data;
    }
    var unanswered = (starts, records) => {
      const answered = new Set(records.map((r) => r.start).filter(Boolean));
      const byToken = new Map(starts.map((s) => [s.token, s]));
      return [...byToken.values()].filter((s) => !answered.has(s.token));
    };
    function unrecordedProblems(latest, total, unrecorded) {
      const problems = [];
      const byAttempt = /* @__PURE__ */ new Map();
      for (const start of unrecorded) {
        byAttempt.set(start.run.attempt, (byAttempt.get(start.run.attempt) || 0) + 1);
      }
      const latestAttempt = new Map(latest.map((r) => [r.shard.current, r.run.attempt]));
      for (const [attempt, count] of [...byAttempt].sort((a, b) => a[0] - b[0])) {
        const open = [];
        for (let k = 1; k <= total; k++) {
          if ((latestAttempt.get(k) || 0) < attempt) open.push(k);
        }
        if (!open.length) continue;
        problems.push(
          `${count} shard job(s) of attempt ${attempt} left no record (Playwright stopped before it loaded the reporter, the job was cancelled, or the upload failed), so shard ${open.join(", ")} cannot stand on a record of an earlier attempt; re-run the shard jobs`
        );
      }
      return problems;
    }
    function latestAttempts(records) {
      const byShard = /* @__PURE__ */ new Map();
      const duplicates = [];
      for (const record of records) {
        const shard = record.shard.current;
        const known = byShard.get(shard);
        if (!known || record.run.attempt > known.run.attempt) byShard.set(shard, record);
        else if (record.run.attempt === known.run.attempt) duplicates.push(shard);
      }
      const latest = [...byShard.values()].sort((a, b) => a.shard.current - b.shard.current);
      return { latest, duplicates: [...new Set(duplicates)].sort((a, b) => a - b) };
    }
    var corpusSha2 = (corpus) => sha2562(
      corpus.map((entry) => entry[0]).sort().join("\n")
    );
    function agree(latest, what, valueOf, problems) {
      const by = /* @__PURE__ */ new Map();
      for (const r of latest) {
        const value = String(valueOf(r));
        if (!by.has(value)) by.set(value, []);
        by.get(value).push(r.shard.current);
      }
      if (by.size > 1) {
        const detail = [...by].map(([v, s]) => `${v} (shards ${s.join(", ")})`).join(" and ");
        problems.push(`shards ran with different ${what}: ${detail}`);
      }
    }
    function checkRun(expected, records) {
      const problems = [];
      const plan = expected;
      const { latest, duplicates } = latestAttempts(records);
      if (records.length === 0) problems.push("no run records: no shard wrote one");
      for (const shard of duplicates) {
        problems.push(`shard ${shard} has more than one record of the same attempt`);
      }
      const shards = new Set(latest.map((r) => r.shard.current));
      const missing = [];
      for (let k = 1; k <= plan.total; k++) if (!shards.has(k)) missing.push(k);
      if (missing.length) problems.push(`no record for shard ${missing.join(", ")}`);
      problems.push(...unrecordedProblems(latest, plan.total, plan.unrecorded || []));
      const outside = latest.filter((r) => r.shard.current > plan.total || r.shard.current < 1);
      if (outside.length) {
        problems.push(
          `records for shards outside 1..${plan.total}: ${outside.map((r) => r.shard.current).join(", ")}`
        );
      }
      for (const r of latest) {
        const at = `shard ${r.shard.current}`;
        if (r.shard.total !== plan.total) {
          problems.push(`${at} ran as one of ${r.shard.total} shards, the suite has ${plan.total}`);
        }
        if (r.run.id !== plan.runId)
          problems.push(`${at} is a record of run ${r.run.id}, not ${plan.runId}`);
        if (r.mode === "balanced" && !r.planSha) problems.push(`${at} logged no plan`);
        if (!r.corpus) problems.push(`${at} recorded no corpus, so its selection cannot be proven`);
      }
      agree(latest, "modes", (r) => r.mode, problems);
      agree(latest, "fingerprints", (r) => r.fingerprint, problems);
      agree(
        latest.filter((r) => r.mode === "balanced"),
        "snapshots",
        (r) => r.snapshotSha,
        problems
      );
      const planShas = new Set(latest.filter((r) => r.planSha).map((r) => r.planSha));
      if (planShas.size > 1)
        problems.push(`shards planned differently: plans ${[...planShas].join(", ")}`);
      const corpora = /* @__PURE__ */ new Map();
      for (const r of latest.filter((x) => x.corpus)) {
        const sha = corpusSha2(r.corpus);
        if (!corpora.has(sha)) corpora.set(sha, []);
        corpora.get(sha).push(r.shard.current);
      }
      if (corpora.size > 1) {
        const detail = [...corpora.values()].map((s) => `shards ${s.join(", ")}`).join(" and ");
        problems.push(`shards saw different test sets before the split: ${detail}`);
      }
      const labels = /* @__PURE__ */ new Map();
      for (const r of latest) for (const [id, label2] of r.corpus || []) labels.set(id, label2 || id);
      const label = (id) => labels.get(id) || id;
      const counts = /* @__PURE__ */ new Map();
      for (const r of latest) {
        for (const t of r.tests) if (!t.setup) counts.set(t.id, (counts.get(t.id) || 0) + 1);
      }
      const twice = [...counts].filter(([, n]) => n > 1).map(([id]) => label(id)).sort();
      if (twice.length)
        problems.push(`${twice.length} test(s) ran in more than one shard: ${names(twice)}`);
      if (corpora.size === 1) {
        const corpus = latest.find((r) => r.corpus).corpus.map((entry) => entry[0]);
        const listed = new Set(corpus);
        const absent = corpus.filter((id) => !counts.has(id)).map(label).sort();
        const extra = [...counts.keys()].filter((id) => !listed.has(id)).map(label).sort();
        if (absent.length) problems.push(`${absent.length} test(s) ran in no shard: ${names(absent)}`);
        if (extra.length)
          problems.push(`${extra.length} test(s) ran outside the corpus: ${names(extra)}`);
      }
      const notRun = latest.flatMap((r) => r.tests.filter((t) => !t.setup && !t.ran).map((t) => label(t.id))).sort();
      if (notRun.length) {
        problems.push(
          `${notRun.length} test(s) did not run (interrupted, stopped at max failures, or a setup project failed): ${names(notRun)}`
        );
      }
      const executed = latest.flatMap((r) => r.tests.filter((t) => !t.setup));
      if (executed.length && executed.every((t) => t.outcome === "skipped")) {
        problems.push(`every one of the ${executed.length} tests skipped, so the run proves nothing`);
      }
      const coverageOk = problems.length === 0;
      const failed = latest.filter((r) => r.status !== "passed");
      for (const r of failed) problems.push(`shard ${r.shard.current} ended with status ${r.status}`);
      const passed = failed.length === 0 && missing.length === 0 && latest.length > 0;
      return { ok: coverageOk && passed, coverageOk, passed, problems, records: latest };
    }
    module2.exports = {
      RECORD_SCHEMA: RECORD_SCHEMA2,
      RECORD_VERSION: RECORD_VERSION2,
      START_SCHEMA,
      STATUS_SCHEMA,
      checkRun,
      corpusSha: corpusSha2,
      latestAttempts,
      unanswered,
      validateRecord,
      validateStart,
      validateStatus
    };
  }
});

// lib/identity.js
var require_identity = __commonJS({
  "lib/identity.js"(exports2, module2) {
    "use strict";
    var { sha256: sha2562 } = require_util();
    var MIN_PLAYWRIGHT = "1.63.0";
    var CACHE_PATH = ".psp/history";
    var HISTORY_FILE = "history.json";
    var PIN_PATH = ".psp/pin";
    var PIN_FILE = "pin.json";
    function historyKey({ workingDirectory, workers, runnerLabel, historyKey: extra }) {
      const identity = JSON.stringify({
        v: 2,
        workingDirectory,
        workers: workers || null,
        runnerLabel,
        historyKey: extra || ""
      });
      return sha2562(identity).slice(0, 24);
    }
    var fingerprint2 = (key, playwright) => sha2562(JSON.stringify({ key, playwright })).slice(0, 24);
    var cachePrefix = (key) => `psp-history-v2-${key}-`;
    var cacheKey = (key, epoch, seq) => `${cachePrefix(key)}${epoch}-${seq}`;
    function cacheSlot(key, matched) {
      if (!matched || !matched.startsWith(cachePrefix(key))) return null;
      const found = /^([1-9]\d*)-([1-9]\d*)$/.exec(matched.slice(cachePrefix(key).length));
      return found ? { epoch: Number(found[1]), seq: Number(found[2]) } : null;
    }
    var pinKey = (key, job, runId) => `psp-pin-v2-${key}-${job || "job"}-${runId}`;
    function recordName(record) {
      const corpus = record.corpusSha ? record.corpusSha.slice(0, 12) : "none";
      return `psp-record-${record.job || "job"}-${record.key.slice(0, 12)}-${corpus}-${record.shard.current}of${record.shard.total}-attempt-${record.run.attempt}`;
    }
    var startName = (key, job, token, attempt, tryIndex = 1) => `psp-start-${job || "job"}-${key.slice(0, 12)}-${token}-${tryIndex}-attempt-${attempt}`;
    module2.exports = {
      CACHE_PATH,
      HISTORY_FILE,
      MIN_PLAYWRIGHT,
      PIN_FILE,
      PIN_PATH,
      cacheKey,
      cachePrefix,
      cacheSlot,
      fingerprint: fingerprint2,
      historyKey,
      pinKey,
      recordName,
      startName
    };
  }
});

// lib/invocation.js
var require_invocation = __commonJS({
  "lib/invocation.js"(exports2, module2) {
    "use strict";
    var LONG = {
      "add-reporter": "required",
      browser: "required",
      config: "required",
      debug: "optional",
      "global-timeout": "required",
      grep: "required",
      "grep-invert": "required",
      "last-failed-file": "required",
      "max-failures": "required",
      output: "required",
      "only-changed": "optional",
      project: "variadic",
      "repeat-each": "required",
      reporter: "required",
      retries: "required",
      "run-agents": "required",
      shard: "required",
      "shard-weights": "required",
      shuffle: "optional",
      "test-list": "required",
      "test-list-invert": "required",
      timeout: "required",
      trace: "required",
      tsconfig: "required",
      "ui-host": "required",
      "ui-port": "required",
      "update-snapshots": "optional",
      "update-source-method": "required",
      workers: "required"
    };
    var SHORT = { c: "required", g: "required", G: "required", j: "required", u: "optional" };
    var isOption = (token) => token.length > 1 && token.startsWith("-");
    function parseInvocation2(argv) {
      const args = argv.slice(2);
      const at = args.findIndex((token) => !isOption(token));
      if (at === -1 || args[at] !== "test") {
        throw new Error(
          `cannot find the playwright test command in the command line ${JSON.stringify(argv.slice(1))}, so --no-deps and --last-failed cannot be read; run the reporter through $PSP_ARGS in a playwright test command`
        );
      }
      const found = { noDeps: false, lastFailed: false };
      const tokens = args.slice(at + 1);
      const skipValue = (kind, i2) => {
        if (kind === "required") return i2 + 1;
        if (kind === "optional") return i2 < tokens.length && !isOption(tokens[i2]) ? i2 + 1 : i2;
        let next = i2;
        while (next < tokens.length && !isOption(tokens[next])) next++;
        return next;
      };
      let i = 0;
      while (i < tokens.length) {
        const token = tokens[i++];
        if (token === "--") break;
        if (!isOption(token)) continue;
        if (token.startsWith("--")) {
          const eq = token.indexOf("=");
          const name = token.slice(2, eq === -1 ? void 0 : eq);
          if (name === "no-deps") found.noDeps = true;
          else if (name === "last-failed") found.lastFailed = true;
          const kind = LONG[name];
          if (kind && eq === -1) i = skipValue(kind, i);
          else if (kind === "variadic") i = skipValue(kind, i);
          continue;
        }
        for (let c = 1; c < token.length; c++) {
          const kind = SHORT[token[c]];
          if (!kind) continue;
          if (c + 1 < token.length) break;
          i = skipValue(kind, i);
        }
      }
      return found;
    }
    module2.exports = { parseInvocation: parseInvocation2 };
  }
});

// reporter/reporter.js
var fs = require("node:fs");
var path = require("node:path");
var { balance } = require_balance();
var { createEstimator, testKey } = require_estimate();
var { buildUnits, dependencyProjects, setupCosts, setupPhases } = require_units();
var { parseHistory } = require_history();
var { RECORD_SCHEMA, RECORD_VERSION, corpusSha } = require_check();
var { fingerprint } = require_identity();
var { parseInvocation } = require_invocation();
var { formatMs, sha256, short, writeAtomic } = require_util();
var PREFIX = "[playwright-smart-parallelization]";
var log = (message) => process.stdout.write(`${PREFIX} ${message}
`);
function optionsFromEnv(env = process.env) {
  const mode = env.PSP_MODE;
  if (mode !== "balanced" && mode !== "native") {
    throw new Error(
      `${PREFIX} PSP_MODE must be balanced or native, got ${JSON.stringify(mode)}: this reporter is added by $PSP_ARGS and reads its options from the environment the Action exports`
    );
  }
  const int = (name, fallback) => {
    const value = env[name] === void 0 || env[name] === "" ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${PREFIX} ${name} must be a positive integer, got ${env[name]}`);
    }
    return value;
  };
  return {
    mode,
    workers: int("PSP_WORKERS", 1),
    snapshot: env.PSP_SNAPSHOT || null,
    snapshotSha: env.PSP_SNAPSHOT_SHA || null,
    key: env.PSP_KEY || "",
    record: env.PSP_RECORD || null,
    runId: int("PSP_RUN_ID", 1),
    attempt: int("PSP_RUN_ATTEMPT", 1),
    commit: env.PSP_COMMIT || "",
    runner: env.PSP_RUNNER_NAME || "",
    reason: env.PSP_REASON || null,
    job: env.PSP_JOB || "",
    pinned: env.PSP_PINNED === "true",
    historyKey: env.PSP_HISTORY_KEY || "",
    start: env.PSP_START || null
  };
}
var toPosix = (p) => p.split(path.sep).join("/");
function fileSuiteOf(test) {
  let suite = test.parent;
  while (suite && suite.type !== "file") suite = suite.parent;
  return suite;
}
var projectsOf = (config, { noDeps }) => config.projects.map((p) => ({
  name: p.name,
  dependencies: noDeps ? [] : p.dependencies || [],
  teardown: noDeps ? null : p.teardown || null
}));
function assertNamedProjects(projects) {
  const byName = /* @__PURE__ */ new Map();
  projects.forEach((project, index) => {
    const name = project.name || "";
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(index + 1);
  });
  for (const [name, indexes] of byName) {
    if (indexes.length < 2) continue;
    throw new Error(
      name ? `${PREFIX} projects ${indexes.join(" and ")} of the config are both named ${JSON.stringify(name)}; every project needs a unique name, which keys its tests in the timing history` : `${PREFIX} projects ${indexes.join(" and ")} of the config have no name; give them unique names, which key their tests in the timing history`
    );
  }
}
function describeTest(test, rootDir) {
  const project = test.parent.project().name;
  const fileSuite = fileSuiteOf(test);
  const file = toPosix(
    path.relative(
      rootDir,
      fileSuite && fileSuite.location && fileSuite.location.file || test.location.file
    )
  );
  const titles = test.titlePath().slice(3);
  const repeat = test.repeatEachIndex;
  return {
    id: test.id,
    key: testKey(project, file, titles),
    project,
    file,
    repeat,
    label: `${project} \u203A ${file} \u203A ${titles.join(" \u203A ")}${repeat ? ` #${repeat}` : ""}`,
    staticSkip: test.expectedStatus === "skipped"
  };
}
function readSnapshot(options) {
  if (!options.snapshot || !options.snapshotSha) {
    throw new Error("balanced mode needs PSP_SNAPSHOT and PSP_SNAPSHOT_SHA");
  }
  let text;
  try {
    text = fs.readFileSync(options.snapshot, "utf8");
  } catch (error) {
    throw new Error(`cannot read the snapshot ${options.snapshot}: ${error.message}`, {
      cause: error
    });
  }
  const sha = sha256(text);
  if (sha !== options.snapshotSha) {
    throw new Error(
      `the snapshot has sha ${short(sha)}, the pin holds ${short(options.snapshotSha)}`
    );
  }
  const history = parseHistory(text, { key: options.key, source: "the snapshot" });
  if (Object.keys(history.tests).length === 0) throw new Error("the snapshot has no entries");
  return { history, sha };
}
var SmartParallelizationReporter = class {
  constructor(options = {}) {
    this.options = { argv: process.argv, ...optionsFromEnv(), ...options };
    this.preprocessed = false;
    this.config = null;
    this.tests = [];
    this.setupProjects = /* @__PURE__ */ new Set();
    this.firstStart = Infinity;
    this.lastEnd = -Infinity;
    this.record = {
      schema: RECORD_SCHEMA,
      version: RECORD_VERSION,
      run: { id: this.options.runId, attempt: this.options.attempt },
      commit: this.options.commit,
      runner: this.options.runner,
      job: this.options.job,
      start: this.options.start,
      pinned: this.options.pinned,
      historyKey: this.options.historyKey,
      shard: { current: 1, total: 1 },
      mode: this.options.mode,
      reason: this.options.reason,
      key: this.options.key,
      fingerprint: null,
      playwright: null,
      workers: this.options.workers,
      planSha: null,
      snapshotSha: null,
      predictedMs: null,
      projects: null,
      phases: null,
      corpus: null,
      corpusSha: null
    };
  }
  printsToStdio() {
    return false;
  }
  async preprocess({ config, suite, testRun }) {
    const { options } = this;
    const shard = config.shard ? { current: config.shard.current, total: config.shard.total } : { current: 1, total: 1 };
    const label = `shard ${shard.current}/${shard.total}`;
    this.config = config;
    this.record.shard = shard;
    this.record.playwright = config.version;
    this.record.fingerprint = fingerprint(options.key, config.version);
    let invocation;
    try {
      invocation = parseInvocation(options.argv);
    } catch (error) {
      throw new Error(`${PREFIX} ${label}: ${error.message}`, { cause: error });
    }
    if (invocation.lastFailed) {
      throw new Error(
        `${PREFIX} ${label}: --last-failed is not supported. Playwright applies it after the split, so no shard can prove which tests the run selected; run that command with the Action's enabled: false, which leaves PSP_ARGS empty and the run plain Playwright`
      );
    }
    const projects = projectsOf(config, invocation);
    assertNamedProjects(projects);
    const names = suite.suites.map((s) => s.title);
    const readonly = dependencyProjects(projects, names);
    this.setupProjects = readonly;
    const phases = setupPhases(projects, names);
    this.record.projects = Object.fromEntries(
      projects.filter((p) => names.includes(p.name) && !readonly.has(p.name)).map((p) => [p.name, [...dependencyProjects(projects, [p.name])].sort()])
    );
    this.record.phases = Object.fromEntries([...phases].sort());
    const tests = [];
    const setupTests = [];
    const testsOf = /* @__PURE__ */ new Map();
    for (const projectSuite of suite.suites) {
      for (const test of projectSuite.allTests()) {
        const entry = describeTest(test, config.rootDir);
        if (readonly.has(entry.project)) setupTests.push(entry);
        else {
          testsOf.set(test, tests.length);
          tests.push(entry);
        }
      }
    }
    this.record.corpus = tests.map((t) => [t.id, t.label]);
    this.record.corpusSha = corpusSha(this.record.corpus);
    this.preprocessed = true;
    if (!config.shard) {
      this.record.mode = "native";
      this.record.reason = "the command has no --shard";
      log(`no --shard in the command, so this run is not balanced; ${tests.length} tests recorded`);
      return;
    }
    if (options.mode === "native") {
      log(
        `${label}: native sharding${options.reason ? ` (${options.reason})` : ""}, ${tests.length} tests in the selection`
      );
      return;
    }
    let snapshot;
    try {
      snapshot = readSnapshot(options);
    } catch (error) {
      throw new Error(
        `${PREFIX} ${label}: ${error.message}; balanced mode is strict, so this shard stops before any test and every shard keeps one plan`,
        { cause: error }
      );
    }
    const estimator = createEstimator(snapshot.history.tests);
    const projectDeps = new Map(Object.entries(this.record.projects));
    const { units, members } = buildUnits(
      tests,
      estimator,
      (project) => projectDeps.get(project) || []
    );
    const plan = balance(
      units,
      shard.total,
      options.workers,
      setupCosts(setupTests, estimator),
      phases
    );
    const mine = plan.shards[shard.current - 1];
    const keep = /* @__PURE__ */ new Set();
    for (const unit of mine.units) for (const index of members.get(unit.id)) keep.add(index);
    for (const projectSuite of suite.suites) {
      if (readonly.has(projectSuite.title)) continue;
      for (const fileSuite of [...projectSuite.suites]) {
        const inFile = fileSuite.allTests();
        if (inFile.every((test) => !keep.has(testsOf.get(test)))) testRun.exclude(fileSuite);
        else for (const test of inFile) if (!keep.has(testsOf.get(test))) testRun.exclude(test);
      }
    }
    testRun.skipSharding();
    this.record.planSha = plan.sha;
    this.record.snapshotSha = snapshot.sha;
    this.record.predictedMs = plan.shards.map((s) => s.wallMs);
    const walls = plan.shards.map((s) => s.wallMs);
    const known = tests.length - plan.unknownTests;
    log(
      `${label}: balanced, ${mine.files} files, ${mine.tests} tests, ~${formatMs(mine.wallMs)} (all shards ${formatMs(Math.min(...walls))}-${formatMs(Math.max(...walls))}), ${known}/${tests.length} tests known, ${options.workers} worker(s), snapshot ${short(snapshot.sha)}, plan ${short(plan.sha)}`
    );
  }
  onBegin(config, suite) {
    this.config = this.config || config;
    this.record.playwright = this.record.playwright || config.version;
    this.record.fingerprint = this.record.fingerprint || fingerprint(this.options.key, config.version);
    if (!this.preprocessed) {
      if (config.shard) {
        this.record.shard = { current: config.shard.current, total: config.shard.total };
      }
      log(`Playwright ${config.version} did not call preprocess, so this shard was not planned`);
    }
    this.tests = suite.allTests();
  }
  onTestEnd(_test, result) {
    const start = result.startTime.getTime();
    this.firstStart = Math.min(this.firstStart, start);
    this.lastEnd = Math.max(this.lastEnd, start + result.duration);
  }
  async onEnd(result) {
    if (!this.options.record || !this.config) return;
    const rootDir = this.config.rootDir;
    const tests = this.tests.map((test) => {
      const entry = describeTest(test, rootDir);
      const outcome = test.outcome();
      let sampleMs = null;
      if (!entry.staticSkip && (outcome === "expected" || outcome === "flaky")) {
        const good = test.results.filter((r) => r.status === test.expectedStatus).pop();
        if (good && good.duration > 0) sampleMs = Math.round(good.duration);
      }
      const ran = entry.staticSkip || test.results.length > 0 && test.results.every((r) => r.status !== "interrupted");
      return {
        id: entry.id,
        key: entry.key,
        repeat: entry.repeat,
        setup: this.setupProjects.has(entry.project),
        outcome,
        ran,
        sample_ms: sampleMs
      };
    });
    const record = {
      ...this.record,
      status: result.status,
      startedAt: result.startTime ? new Date(result.startTime).toISOString() : null,
      wallMs: Math.round(result.duration),
      testsMs: this.lastEnd > this.firstStart ? Math.round(this.lastEnd - this.firstStart) : 0,
      tests
    };
    writeAtomic(path.resolve(this.options.record), `${JSON.stringify(record)}
`);
  }
};
module.exports = SmartParallelizationReporter;
module.exports.assertNamedProjects = assertNamedProjects;
module.exports.optionsFromEnv = optionsFromEnv;
