// negative_test.mjs
import { createVapor } from "./dist/index.js";

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

const negative_x = vapor.query({
  type: "Point",
  where: { field: "x", op: "lt", value: 0 },
});
console.assert(
  negative_x.total === 2,
  `Expected 2 negative-x points, got ${negative_x.total}`,
);

const gt_neg2 = vapor.query({
  type: "Point",
  where: { field: "x", op: "gt", value: -2 },
});
console.assert(
  gt_neg2.total === 3,
  `Expected 3 points with x > -2, got ${gt_neg2.total}`,
);

vapor.destroy();
console.log("Negative range test PASSED");
