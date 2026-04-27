// vapor-idx TypeScript smoke test
// After build: cd typescript && node smoke.mjs
// (smoke.mjs imports from ./dist/index.js)

import { createVapor } from "./dist/index.js";

let passed = 0,
  failed = 0;
const assert = (c, m) => {
  if (!c) throw new Error(m);
};

function run(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}

run("basic store and get", () => {
  const vapor = createVapor({
    types: {
      Task: {
        fields: {
          title: { type: "string", index: "keyword" },
          priority: { type: "number", index: "range" },
          status: { type: "string", index: "exact" },
        },
        relationships: {
          BLOCKS: {
            targetTypes: ["Task"],
            directed: true,
            cardinality: "many-to-many",
          },
        },
      },
    },
  });
  const id1 = vapor.store("Task", {
    title: "Write tests",
    priority: 1,
    status: "open",
  });
  const id2 = vapor.store("Task", {
    title: "Deploy package",
    priority: 2,
    status: "open",
  });
  assert(id1 !== id2 && id1.startsWith("vpr_"), "ID format");
  assert(vapor.get(id1)?.data.title === "Write tests", "data match");
  vapor.destroy();
});

run("query exact", () => {
  const vapor = createVapor({
    types: {
      Item: {
        fields: {
          status: { type: "string", index: "exact" },
          priority: { type: "number", index: "range" },
        },
        relationships: {},
      },
    },
  });
  vapor.store("Item", { status: "open", priority: 1 });
  vapor.store("Item", { status: "open", priority: 2 });
  vapor.store("Item", { status: "closed", priority: 3 });
  const r = vapor.query({
    type: "Item",
    where: { field: "status", op: "eq", value: "open" },
  });
  assert(r.total === 2, `Expected 2, got ${r.total}`);
  vapor.destroy();
});

run("query range including negatives", () => {
  const vapor = createVapor({
    types: {
      Point: {
        fields: {
          x: { type: "number", index: "range" },
          y: { type: "number", index: "range" },
        },
        relationships: {},
      },
    },
  });
  vapor.store("Point", { x: -10, y: -5 });
  vapor.store("Point", { x: -1, y: 0 });
  vapor.store("Point", { x: 0, y: 3 });
  vapor.store("Point", { x: 5, y: 10 });
  const neg = vapor.query({
    type: "Point",
    where: { field: "x", op: "lt", value: 0 },
  });
  assert(neg.total === 2, `Expected 2 negative-x, got ${neg.total}`);
  const gt = vapor.query({
    type: "Point",
    where: { field: "x", op: "gt", value: -2 },
  });
  assert(gt.total === 3, `Expected 3 with x>-2, got ${gt.total}`);
  const lte = vapor.query({
    type: "Point",
    where: { field: "x", op: "lte", value: 0 },
  });
  assert(lte.total === 3, `Expected 3 with x<=0, got ${lte.total}`);
  vapor.destroy();
});

run("query keyword", () => {
  const vapor = createVapor({
    types: {
      Doc: {
        fields: { body: { type: "string", index: "keyword" } },
        relationships: {},
      },
    },
  });
  vapor.store("Doc", { body: "Extracts function signatures from AST nodes" });
  vapor.store("Doc", { body: "Parses CSS and emits HTML layout" });
  const r = vapor.query({ type: "Doc", keywords: "function ast" });
  assert(r.total === 1, `Expected 1, got ${r.total}`);
  vapor.destroy();
});

run("query prefix", () => {
  const vapor = createVapor({
    types: {
      File: {
        fields: { path: { type: "string", index: "prefix" } },
        relationships: {},
      },
    },
  });
  vapor.store("File", { path: "src/parser.ts" });
  vapor.store("File", { path: "src/indexes/exact.ts" });
  vapor.store("File", { path: "tests/smoke.ts" });
  const r = vapor.query({
    type: "File",
    where: { field: "path", op: "startsWith", value: "src/" },
  });
  assert(r.total === 2, `Expected 2, got ${r.total}`);
  vapor.destroy();
});

run("relationships and traversal", () => {
  const vapor = createVapor({
    types: {
      Task: {
        fields: {
          title: { type: "string", index: "keyword" },
          priority: { type: "number", index: "range" },
        },
        relationships: {
          BLOCKS: {
            targetTypes: ["Task"],
            directed: true,
            cardinality: "many-to-many",
          },
        },
      },
    },
  });
  const id1 = vapor.store("Task", { title: "A", priority: 1 });
  const id2 = vapor.store("Task", { title: "B", priority: 2 });
  const id3 = vapor.store("Task", { title: "C", priority: 3 });
  vapor.relate(id2, "BLOCKS", id1);
  vapor.relate(id3, "BLOCKS", id2);
  const result = vapor.traverse({
    from: id3,
    relationship: "BLOCKS",
    direction: "outgoing",
    depth: 2,
  });
  const ids = new Set(result.records.map((r) => r.id));
  assert(ids.has(id2) && ids.has(id1), "traversal should reach id1 and id2");
  const path = vapor.findPath({ from: id3, to: id1, maxDepth: 5 });
  assert(
    path !== null && path[0] === id3 && path[path.length - 1] === id1,
    "path endpoints",
  );
  vapor.destroy();
});

run("update and delete", () => {
  const vapor = createVapor({
    types: {
      Item: {
        fields: {
          value: { type: "number", index: "range" },
          label: { type: "string", index: "exact" },
        },
        relationships: {},
      },
    },
  });
  const rid = vapor.store("Item", { value: 10, label: "alpha" });
  vapor.update(rid, { value: 99 });
  assert(
    vapor.get(rid)?.data.value === 99 && vapor.get(rid)?.data.label === "alpha",
    "update",
  );
  vapor.delete(rid);
  assert(vapor.get(rid) === null && vapor.stats().totalRecords === 0, "delete");
  vapor.destroy();
});

run("snapshot and restore", () => {
  const vapor = createVapor({
    types: {
      Node: {
        fields: { val: { type: "number", index: "range" } },
        relationships: {
          LINKS: {
            targetTypes: ["Node"],
            directed: true,
            cardinality: "many-to-many",
          },
        },
      },
    },
  });
  const a = vapor.store("Node", { val: 1 });
  const b = vapor.store("Node", { val: 2 });
  vapor.relate(a, "LINKS", b);
  const snap = vapor.snapshot();
  vapor.store("Node", { val: 99 });
  const fork = vapor.restore(snap);
  assert(
    fork.stats().totalRecords === 2 && vapor.stats().totalRecords === 3,
    "snapshot isolation",
  );
  vapor.destroy();
  fork.destroy();
});

run("pixel indexing", () => {
  const vapor = createVapor({
    types: {
      Pixel: {
        fields: {
          x: { type: "number", index: "range" },
          y: { type: "number", index: "range" },
          brightness: { type: "number", index: "range" },
        },
        relationships: {
          ADJACENT_TO: {
            targetTypes: ["Pixel"],
            directed: false,
            cardinality: "many-to-many",
          },
        },
      },
    },
  });
  const grid = new Map();
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      grid.set(
        `${x},${y}`,
        vapor.store("Pixel", { x, y, brightness: (x + y) * 25 }),
      );
    }
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const id = grid.get(`${x},${y}`);
      if (x + 1 < 4) vapor.relate(id, "ADJACENT_TO", grid.get(`${x + 1},${y}`));
      if (y + 1 < 4) vapor.relate(id, "ADJACENT_TO", grid.get(`${x},${y + 1}`));
    }
  // x is range-indexed — use gte+lte for point-equality, not op:'eq'
  const leftCol = vapor.query({
    type: "Pixel",
    where: [
      { field: "x", op: "gte", value: 0 },
      { field: "x", op: "lte", value: 0 },
    ],
  });
  assert(leftCol.total === 4, `Left column: expected 4, got ${leftCol.total}`);
  const n = vapor.traverse({
    from: grid.get("1,1"),
    relationship: "ADJACENT_TO",
    direction: "both",
    depth: 1,
  });
  assert(
    n.records.length === 4,
    `Centre neighbours: expected 4, got ${n.records.length}`,
  );
  vapor.destroy();
});

console.log("\nvapor-idx TypeScript smoke test");
console.log("=".repeat(40));
if (failed === 0) {
  console.log(`ALL ${passed} TESTS PASSED`);
  process.exit(0);
} else {
  console.log(`${passed} passed, ${failed} FAILED`);
  process.exit(1);
}
