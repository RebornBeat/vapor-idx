// pixel_test.mjs
import { createVapor } from "./dist/index.js";

const vapor = createVapor({
  types: {
    Pixel: {
      fields: {
        x: { type: "number", index: "range" },
        y: { type: "number", index: "range" },
        r: { type: "number", index: "range" },
        g: { type: "number", index: "range" },
        b: { type: "number", index: "range" },
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

// Index a tiny 3x3 image
const pixels = [];
for (let y = 0; y < 3; y++) {
  for (let x = 0; x < 3; x++) {
    const r = x * 80,
      g = y * 80,
      b = 100;
    const id = vapor.store("Pixel", {
      x,
      y,
      r,
      g,
      b,
      brightness: (r + g + b) / 3,
    });
    pixels.push(id);
  }
}

// Build adjacency
for (let y = 0; y < 3; y++) {
  for (let x = 0; x < 3; x++) {
    const id = pixels[y * 3 + x];
    if (x + 1 < 3) vapor.relate(id, "ADJACENT_TO", pixels[y * 3 + x + 1]);
    if (y + 1 < 3) vapor.relate(id, "ADJACENT_TO", pixels[(y + 1) * 3 + x]);
  }
}

// Negative range query — CRITICAL TEST
const dark = vapor.query({
  type: "Pixel",
  where: { field: "brightness", op: "lt", value: 120 },
});
console.assert(dark.total > 0, "Should find dark pixels");

// Spatial query
const leftCol = vapor.query({
  type: "Pixel",
  where: { field: "x", op: "eq", value: 0 },
});
console.assert(leftCol.total === 3, "Left column should have 3 pixels");

// Traversal
const neighbours = vapor.traverse({
  from: pixels[4],
  relationship: "ADJACENT_TO",
  direction: "both",
  depth: 1,
});
console.assert(
  neighbours.records.length === 4,
  "Centre pixel should have 4 neighbours",
);

vapor.destroy();
console.log("Pixel indexing test PASSED");
