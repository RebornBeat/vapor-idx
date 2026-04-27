# Design Indexer Skill

## Purpose

Use this skill to index HTML/SVG/CSS design elements into vapor-idx, enabling
structural queries over layout, colour, position, and containment — then
reconstruct as CSS, SVG, or a design report. No Figma API, no ML needed.

## When to trigger

- "Analyze this HTML layout and describe the structure"
- "Find all elements with a blue background"
- "Convert this SVG into a clean CSS layout"
- "List all elements that overlap in this design"
- "Find the largest element in this layout"
- "Reconstruct this design as a flexbox CSS layout"
- Any task involving understanding or transforming design/layout data

## Environment

Python computer-use. Install if needed:
```bash
pip install vapor-idx
```

## Step-by-step instructions

### Step 1 — Declare the design element schema

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions

vapor = create_vapor({
    "types": {
        "Element": {
            "fields": {
                "tag":       {"type": "string", "index": "exact"},
                "elem_id":   {"type": "string", "index": "exact"},
                "classes":   {"type": "string", "index": "keyword"},
                "x":         {"type": "number", "index": "range"},
                "y":         {"type": "number", "index": "range"},
                "width":     {"type": "number", "index": "range"},
                "height":    {"type": "number", "index": "range"},
                "area":      {"type": "number", "index": "range"},
                "fill":      {"type": "string", "index": "exact"},
                "stroke":    {"type": "string", "index": "exact"},
                "opacity":   {"type": "number", "index": "range"},
                "z_index":   {"type": "number", "index": "range"},
                "font_size": {"type": "number", "index": "range"},
                "text":      {"type": "string", "index": "keyword"},
                "depth":     {"type": "number", "index": "range"},
            },
            "relationships": {
                "CONTAINS": {
                    "targetTypes": ["Element"],
                    "directed":    True,
                    "cardinality": "one-to-many",
                },
                "ADJACENT_TO": {
                    "targetTypes": ["Element"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
                "OVERLAPS_WITH": {
                    "targetTypes": ["Element"],
                    "directed":    False,
                    "cardinality": "many-to-many",
                },
            },
        },
    },
})
```

### Step 2 — Index from SVG

```python
import xml.etree.ElementTree as ET

def index_svg(vapor, svg_text: str) -> dict[str, str]:
    """Index SVG elements. Returns {element_id: vapor_id}."""
    SVG_NS = "http://www.w3.org/2000/svg"
    root   = ET.fromstring(svg_text)
    id_map: dict[str, str] = {}

    def parse_length(val: str, default: float = 0.0) -> float:
        if not val:
            return default
        val = val.strip().rstrip("px%emrem")
        try:
            return float(val)
        except ValueError:
            return default

    def index_el(el, parent_vid: str | None, depth: int, z: int):
        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
        if tag in ("defs", "style", "script", "metadata"):
            return

        data = {
            "tag":       tag,
            "elem_id":   el.get("id", ""),
            "classes":   el.get("class", ""),
            "x":         parse_length(el.get("x", el.get("cx", "0"))),
            "y":         parse_length(el.get("y", el.get("cy", "0"))),
            "width":     parse_length(el.get("width",  el.get("r", "0"))),
            "height":    parse_length(el.get("height", el.get("r", "0"))),
            "area":      0.0,
            "fill":      el.get("fill",    el.get("style", "")).split("fill:")[1].split(";")[0].strip() if "fill:" in el.get("style","") else el.get("fill", "none"),
            "stroke":    el.get("stroke", "none"),
            "opacity":   float(el.get("opacity", "1.0")),
            "z_index":   z,
            "font_size": parse_length(el.get("font-size", "0")),
            "text":      "".join(el.itertext()).strip()[:200],
            "depth":     depth,
        }
        data["area"] = data["width"] * data["height"]

        vid = vapor.store("Element", data)
        eid = el.get("id", f"{tag}_{depth}_{z}")
        id_map[eid] = vid

        if parent_vid:
            vapor.relate(parent_vid, "CONTAINS", vid)

        for i, child in enumerate(el):
            index_el(child, vid, depth + 1, z + i + 1)

    for i, child in enumerate(root):
        index_el(child, None, 0, i)

    return id_map

id_map = index_svg(vapor, open("design.svg").read())
print(f"Indexed {vapor.stats().total_records} elements")
```

### Step 3 — Index from HTML (using Python's html.parser)

```python
from html.parser import HTMLParser

class HTMLIndexer(HTMLParser):
    def __init__(self, vapor):
        super().__init__()
        self.vapor     = vapor
        self.stack:    list[str]  = []  # stack of vapor IDs
        self.id_map:   dict[str, str] = {}
        self.z_counter = 0

    def handle_starttag(self, tag, attrs):
        attr_dict = dict(attrs)
        self.z_counter += 1
        data = {
            "tag":       tag,
            "elem_id":   attr_dict.get("id", ""),
            "classes":   attr_dict.get("class", ""),
            "x":         0.0, "y": 0.0, "width": 0.0, "height": 0.0,
            "area":      0.0,
            "fill":      attr_dict.get("bgcolor", ""),
            "stroke":    "",
            "opacity":   1.0,
            "z_index":   self.z_counter,
            "font_size": 0.0,
            "text":      "",
            "depth":     len(self.stack),
        }
        vid = self.vapor.store("Element", data)
        if self.stack:
            self.vapor.relate(self.stack[-1], "CONTAINS", vid)
        eid = attr_dict.get("id", f"{tag}_{self.z_counter}")
        self.id_map[eid] = vid
        self.stack.append(vid)

    def handle_endtag(self, tag):
        if self.stack:
            self.stack.pop()

def index_html(vapor, html_text: str) -> dict[str, str]:
    indexer = HTMLIndexer(vapor)
    indexer.feed(html_text)
    return indexer.id_map
```

### Step 4 — Query the design

```python
# Find all large elements (area > 10000 px²)
large = vapor.query(QueryOptions(
    type="Element",
    where=FieldFilter(field="area", op="gt", value=10000),
    order_by=("area", "desc"),
))
for rec in large.records[:5]:
    print(f"{rec.data['tag']}#{rec.data['elem_id']}: {rec.data['area']:.0f}px²")

# Find elements with blue fill
blue = vapor.query(QueryOptions(
    type="Element",
    where=FieldFilter(field="fill", op="eq", value="#0000ff"),
))

# Find text-containing elements
text_els = vapor.query(QueryOptions(
    type="Element",
    keywords="button submit login",
))

# Find elements at a specific depth level
root_els = vapor.query(QueryOptions(
    type="Element",
    where=FieldFilter(field="depth", op="eq", value=0),
))

# Find semi-transparent elements
transparent = vapor.query(QueryOptions(
    type="Element",
    where=FieldFilter(field="opacity", op="lt", value=1.0),
))
```

### Step 5 — Detect overlapping elements

```python
def detect_overlaps(vapor) -> int:
    """Find pairs of elements that overlap spatially and link them."""
    all_els = vapor.query(QueryOptions(type="Element"))
    recs = all_els.records
    overlap_count = 0
    for i in range(len(recs)):
        for j in range(i + 1, len(recs)):
            a, b = recs[i].data, recs[j].data
            ax1, ay1 = a["x"], a["y"]
            ax2, ay2 = ax1 + a["width"], ay1 + a["height"]
            bx1, by1 = b["x"], b["y"]
            bx2, by2 = bx1 + b["width"], by1 + b["height"]
            if ax1 < bx2 and ax2 > bx1 and ay1 < by2 and ay2 > by1:
                vapor.relate(recs[i].id, "OVERLAPS_WITH", recs[j].id)
                overlap_count += 1
    return overlap_count

overlaps = detect_overlaps(vapor)
print(f"Found {overlaps} overlapping element pairs")
```

### Step 6 — Reconstruct as CSS

```python
def reconstruct_css(vapor) -> str:
    lines = ["/* Reconstructed by vapor-idx */", ".canvas { position: relative; }"]
    all_els = vapor.query(QueryOptions(type="Element", order_by=("z_index","asc")))
    for rec in all_els.records:
        d    = rec.data
        eid  = d.get("elem_id") or f"el_{rec.id[:8]}"
        fill = d.get("fill", "transparent")
        if not fill or fill == "none":
            fill = "transparent"
        lines.append(f"""
#{eid} {{
  position: absolute;
  left:    {d.get('x', 0):.1f}px;
  top:     {d.get('y', 0):.1f}px;
  width:   {d.get('width', 0):.1f}px;
  height:  {d.get('height', 0):.1f}px;
  background-color: {fill};
  opacity: {d.get('opacity', 1.0)};
  z-index: {int(d.get('z_index', 0))};
}}""")
    return "\n".join(lines)

css = reconstruct_css(vapor)
open("layout.css", "w").write(css)
print("Saved layout.css")
```

### Step 7 — Reconstruct as SVG

```python
def reconstruct_svg(vapor, view_w: float = 1200, view_h: float = 800) -> str:
    lines = [f'<svg viewBox="0 0 {view_w} {view_h}" xmlns="http://www.w3.org/2000/svg">']
    all_els = vapor.query(QueryOptions(type="Element", order_by=("z_index","asc")))
    for rec in all_els.records:
        d = rec.data
        if d.get("width", 0) == 0 or d.get("height", 0) == 0:
            continue
        fill   = d.get("fill", "none")   or "none"
        stroke = d.get("stroke", "none") or "none"
        opacity = d.get("opacity", 1.0)
        eid    = d.get("elem_id", "")
        id_attr = f' id="{eid}"' if eid else ""
        lines.append(
            f'  <rect{id_attr} x="{d["x"]:.1f}" y="{d["y"]:.1f}" '
            f'width="{d["width"]:.1f}" height="{d["height"]:.1f}" '
            f'fill="{fill}" stroke="{stroke}" opacity="{opacity}"/>'
        )
    lines.append("</svg>")
    return "\n".join(lines)

svg = reconstruct_svg(vapor)
open("layout.svg", "w").write(svg)
print("Saved layout.svg")
```

### Step 8 — Destroy when done

```python
vapor.destroy()
```

## Output

Report on the design structure: total element count, depth distribution, colour
palette, largest elements. Save any reconstruction files and provide their
filenames.
