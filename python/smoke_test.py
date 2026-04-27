#!/usr/bin/env python3
"""
vapor-idx Python smoke test.
Run from the python/ directory (where vapor_idx/ package is visible):
    cd python && python ../smoke_test.py
All 10 tests must pass.
"""

import sys

try:
    from vapor_idx import (
        create_vapor, QueryOptions, FieldFilter,
        TraversalOptions, PathOptions,
        VaporError, VaporSchemaError, VaporDestroyedError,
    )
except ModuleNotFoundError as e:
    print(f"IMPORT ERROR: {e}")
    print("Run from python/ directory: cd python && python ../smoke_test.py")
    print("Or install first: cd python && pip install -e .")
    sys.exit(1)


def test_basic_store_and_get():
    vapor = create_vapor({"types": {"Task": {"fields": {
        "title":    {"type": "string",  "index": "keyword"},
        "priority": {"type": "number",  "index": "range"},
        "status":   {"type": "string",  "index": "exact"},
    }, "relationships": {"BLOCKS": {"targetTypes": ["Task"], "directed": True, "cardinality": "many-to-many"}}}}})
    id1 = vapor.store("Task", {"title": "Write tests",    "priority": 1, "status": "open"})
    id2 = vapor.store("Task", {"title": "Deploy package", "priority": 2, "status": "open"})
    assert id1 != id2 and id1.startswith("vpr_")
    rec = vapor.get(id1)
    assert rec is not None and rec.data["title"] == "Write tests"
    vapor.destroy()
    print("  PASS  basic store and get")


def test_query_exact():
    vapor = create_vapor({"types": {"Item": {"fields": {
        "status":   {"type": "string", "index": "exact"},
        "priority": {"type": "number", "index": "range"},
    }, "relationships": {}}}})
    vapor.store("Item", {"status": "open",   "priority": 1})
    vapor.store("Item", {"status": "open",   "priority": 2})
    vapor.store("Item", {"status": "closed", "priority": 3})
    r = vapor.query(QueryOptions(type="Item", where=FieldFilter(field="status", op="eq", value="open")))
    assert r.total == 2, f"Expected 2, got {r.total}"
    vapor.destroy()
    print("  PASS  query exact")


def test_query_range():
    vapor = create_vapor({"types": {"Point": {"fields": {
        "x": {"type": "number", "index": "range"},
        "y": {"type": "number", "index": "range"},
    }, "relationships": {}}}})
    vapor.store("Point", {"x": -10.0, "y": -5.0})
    vapor.store("Point", {"x":  -1.0, "y":  0.0})
    vapor.store("Point", {"x":   0.0, "y":  3.0})
    vapor.store("Point", {"x":   5.0, "y": 10.0})
    neg = vapor.query(QueryOptions(type="Point", where=FieldFilter(field="x", op="lt", value=0.0)))
    assert neg.total == 2, f"Expected 2 negative-x, got {neg.total}"
    gt  = vapor.query(QueryOptions(type="Point", where=FieldFilter(field="x", op="gt", value=-2.0)))
    assert gt.total == 3, f"Expected 3 with x>-2, got {gt.total}"
    lte = vapor.query(QueryOptions(type="Point", where=FieldFilter(field="x", op="lte", value=0.0)))
    assert lte.total == 3, f"Expected 3 with x<=0, got {lte.total}"
    vapor.destroy()
    print("  PASS  query range (including negatives)")


def test_query_keyword():
    vapor = create_vapor({"types": {"Doc": {"fields": {"body": {"type": "string", "index": "keyword"}}, "relationships": {}}}})
    vapor.store("Doc", {"body": "Extracts function signatures from AST nodes"})
    vapor.store("Doc", {"body": "Parses CSS and emits HTML layout"})
    r = vapor.query(QueryOptions(type="Doc", keywords="function ast"))
    assert r.total == 1, f"Expected 1, got {r.total}"
    vapor.destroy()
    print("  PASS  query keyword")


def test_query_prefix():
    vapor = create_vapor({"types": {"File": {"fields": {"path": {"type": "string", "index": "prefix"}}, "relationships": {}}}})
    vapor.store("File", {"path": "src/parser.ts"})
    vapor.store("File", {"path": "src/indexes/exact.ts"})
    vapor.store("File", {"path": "tests/smoke.ts"})
    r = vapor.query(QueryOptions(type="File", where=FieldFilter(field="path", op="startsWith", value="src/")))
    assert r.total == 2, f"Expected 2, got {r.total}"
    vapor.destroy()
    print("  PASS  query prefix")


def test_relationships_and_traversal():
    vapor = create_vapor({"types": {"Task": {"fields": {
        "title":    {"type": "string", "index": "keyword"},
        "priority": {"type": "number", "index": "range"},
    }, "relationships": {"BLOCKS": {"targetTypes": ["Task"], "directed": True, "cardinality": "many-to-many"}}}}})
    id1 = vapor.store("Task", {"title": "A", "priority": 1})
    id2 = vapor.store("Task", {"title": "B", "priority": 2})
    id3 = vapor.store("Task", {"title": "C", "priority": 3})
    e1 = vapor.relate(id2, "BLOCKS", id1)
    vapor.relate(id3, "BLOCKS", id2)
    assert e1.startswith("vpe_")
    result = vapor.traverse(TraversalOptions(from_id=id3, relationship="BLOCKS", direction="outgoing", depth=2))
    ids = {r.id for r in result.records}
    assert id2 in ids and id1 in ids
    path = vapor.find_path(PathOptions(from_id=id3, to_id=id1, relationship="BLOCKS", max_depth=5))
    assert path is not None and path[0] == id3 and path[-1] == id1
    vapor.destroy()
    print("  PASS  relationships and traversal")


def test_update_and_delete():
    vapor = create_vapor({"types": {"Item": {"fields": {
        "value": {"type": "number", "index": "range"},
        "label": {"type": "string", "index": "exact"},
    }, "relationships": {}}}})
    rid = vapor.store("Item", {"value": 10, "label": "alpha"})
    vapor.update(rid, {"value": 99})
    rec = vapor.get(rid)
    assert rec.data["value"] == 99 and rec.data["label"] == "alpha"
    high = vapor.query(QueryOptions(type="Item", where=FieldFilter(field="value", op="gt", value=50)))
    assert high.total == 1
    vapor.delete(rid)
    assert vapor.get(rid) is None and vapor.stats().total_records == 0
    vapor.destroy()
    print("  PASS  update and delete")


def test_snapshot_restore():
    vapor = create_vapor({"types": {"Node": {"fields": {"val": {"type": "number", "index": "range"}},
    "relationships": {"LINKS": {"targetTypes": ["Node"], "directed": True, "cardinality": "many-to-many"}}}}})
    a = vapor.store("Node", {"val": 1})
    b = vapor.store("Node", {"val": 2})
    vapor.relate(a, "LINKS", b)
    snap = vapor.snapshot()
    vapor.store("Node", {"val": 99})
    assert vapor.stats().total_records == 3
    fork = vapor.restore(snap)
    assert fork.stats().total_records == 2 and vapor.stats().total_records == 3
    vapor.destroy(); fork.destroy()
    print("  PASS  snapshot and restore")


def test_destroy_raises():
    vapor = create_vapor({"types": {"X": {"fields": {"n": {"type": "number", "index": "range"}}, "relationships": {}}}})
    vapor.destroy()
    try:
        vapor.store("X", {"n": 1})
        assert False, "Should have raised"
    except VaporDestroyedError:
        pass
    print("  PASS  destroy raises VaporDestroyedError")


def test_pixel_indexing():
    """range-indexed x/y: use gte+lte pair for point-equality, not op=eq."""
    vapor = create_vapor({"types": {"Pixel": {"fields": {
        "x":          {"type": "number", "index": "range"},
        "y":          {"type": "number", "index": "range"},
        "brightness": {"type": "number", "index": "range"},
    }, "relationships": {"ADJACENT_TO": {"targetTypes": ["Pixel"], "directed": False, "cardinality": "many-to-many"}}}}})
    grid: dict[tuple, str] = {}
    for y in range(4):
        for x in range(4):
            pid = vapor.store("Pixel", {"x": float(x), "y": float(y), "brightness": (x + y) * 25.0})
            grid[(x, y)] = pid
    for y in range(4):
        for x in range(4):
            if x + 1 < 4: vapor.relate(grid[(x,y)], "ADJACENT_TO", grid[(x+1,y)])
            if y + 1 < 4: vapor.relate(grid[(x,y)], "ADJACENT_TO", grid[(x,y+1)])
    # x=0 column: use gte+lte (x is range-indexed, not exact-indexed)
    left = vapor.query(QueryOptions(type="Pixel", where=[
        FieldFilter(field="x", op="gte", value=0.0),
        FieldFilter(field="x", op="lte", value=0.0),
    ]))
    assert left.total == 4, f"Expected 4, got {left.total}"
    dark = vapor.query(QueryOptions(type="Pixel", where=FieldFilter(field="brightness", op="lt", value=50.0)))
    assert dark.total > 0
    neighbours = vapor.traverse(TraversalOptions(from_id=grid[(1,1)], relationship="ADJACENT_TO", direction="both", depth=1))
    assert len(neighbours.records) == 4, f"Expected 4 neighbours, got {len(neighbours.records)}"
    vapor.destroy()
    print("  PASS  pixel indexing (spatial queries + adjacency)")


if __name__ == "__main__":
    print("vapor-idx Python smoke test")
    print("=" * 40)
    tests = [
        test_basic_store_and_get, test_query_exact, test_query_range,
        test_query_keyword, test_query_prefix, test_relationships_and_traversal,
        test_update_and_delete, test_snapshot_restore, test_destroy_raises,
        test_pixel_indexing,
    ]
    passed = failed = 0
    for t in tests:
        try:
            t(); passed += 1
        except Exception as e:
            print(f"  FAIL  {t.__name__}: {e}"); failed += 1
    print("=" * 40)
    if failed == 0:
        print(f"ALL {passed} TESTS PASSED")
        sys.exit(0)
    else:
        print(f"{passed} passed, {failed} FAILED"); sys.exit(1)
