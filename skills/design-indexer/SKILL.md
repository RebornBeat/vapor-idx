---
name: Design Indexer
description: Index HTML and SVG design elements into vapor-idx using built-in Python parsers only (xml.etree.ElementTree for SVG, html.parser for HTML). No external libraries. Parse CSS inline styles directly. Build full containment hierarchy, detect overlaps spatially, compute layout metrics. Reconstruct as raw CSS or SVG text. 5x validation pass on spatial consistency.
version: 2.0.0
tools:
  - computer_use
---

# Design Indexer Skill

## Purpose

Index design elements from HTML/SVG source text using only Python's built-in
`xml.etree.ElementTree` and `html.parser`. No external libraries, no Figma API.
Parse CSS inline styles directly as text. Build relationship graphs between
elements. Validate spatial layout with 5x consistency pass.

## When to trigger

- "Analyze this HTML/SVG layout and describe the structure"
- "Find all elements with a blue background / large area / deep nesting"
- "Convert this SVG to CSS absolute-positioning layout"
- "Detect overlapping elements"
- "What is the deepest nesting level?"
- "Find all clickable elements (buttons, links, inputs)"
- "Reconstruct this design as clean semantic HTML with inline styles"

## Environment

```bash
pip install vapor-idx
```

Only built-in Python used: `xml.etree.ElementTree`, `html.parser`, `re`, `json`.

---

## Step 1 — Raw CSS inline style parser (no library)

```python
import re

def parse_inline_style(style_str: str) -> dict:
    """
    Parse a CSS inline style string into a dict.
    Handles: 'color: red; background-color: #fff; font-size: 14px'
    Pure Python — no cssutils, no tinycss.
    """
    result = {}
    if not style_str: return result
    for declaration in style_str.split(';'):
        declaration = declaration.strip()
        if ':' not in declaration: continue
        prop, _, val = declaration.partition(':')
        result[prop.strip().lower()] = val.strip()
    return result


def css_colour_to_rgb(value: str) -> tuple[float, float, float]:
    """
    Convert CSS colour string to (r,g,b) floats 0-255.
    Handles: #rgb, #rrggbb, rgb(...), named colours.
    Pure Python.
    """
    value = value.strip().lower()

    named = {
        'red':(255,0,0),'green':(0,128,0),'blue':(0,0,255),
        'white':(255,255,255),'black':(0,0,0),'none':(0,0,0),
        'transparent':(0,0,0),'grey':(128,128,128),'gray':(128,128,128),
        'yellow':(255,255,0),'orange':(255,165,0),'purple':(128,0,128),
        'pink':(255,192,203),'brown':(139,69,19),'navy':(0,0,128),
        'teal':(0,128,128),'lime':(0,255,0),'cyan':(0,255,255),
        'magenta':(255,0,255),'silver':(192,192,192),'gold':(255,215,0),
    }
    if value in named: return named[value]

    if value.startswith('#'):
        h = value[1:]
        if len(h) == 3:
            h = h[0]*2 + h[1]*2 + h[2]*2
        if len(h) == 6:
            return (int(h[0:2],16), int(h[2:4],16), int(h[4:6],16))

    m = re.match(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)', value)
    if m:
        return (float(m.group(1)), float(m.group(2)), float(m.group(3)))

    return (0.0, 0.0, 0.0)


def parse_length_value(value: str, parent_size: float = 0.0) -> float:
    """
    Parse CSS length to float pixels.
    Handles: px, em (≈16px), rem (≈16px), %, vw/vh (≈1080/1920 assumed).
    """
    if not value or value == 'auto': return 0.0
    value = value.strip()
    try:
        if value.endswith('px'):   return float(value[:-2])
        if value.endswith('em'):   return float(value[:-2]) * 16.0
        if value.endswith('rem'):  return float(value[:-3]) * 16.0
        if value.endswith('%'):    return float(value[:-1]) / 100.0 * parent_size
        if value.endswith('vw'):   return float(value[:-2]) * 19.2
        if value.endswith('vh'):   return float(value[:-2]) * 10.8
        return float(value)
    except:
        return 0.0
```

---

## Step 2 — Schema

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions

vapor = create_vapor({
    "types": {
        "Element": {
            "fields": {
                "tag":          {"type": "string", "index": "exact"},
                "elem_id":      {"type": "string", "index": "exact"},
                "classes":      {"type": "string", "index": "keyword"},
                "x":            {"type": "number", "index": "range"},
                "y":            {"type": "number", "index": "range"},
                "width":        {"type": "number", "index": "range"},
                "height":       {"type": "number", "index": "range"},
                "area":         {"type": "number", "index": "range"},
                "depth":        {"type": "number", "index": "range"},
                "z_index":      {"type": "number", "index": "range"},
                "fill_r":       {"type": "number", "index": "range"},
                "fill_g":       {"type": "number", "index": "range"},
                "fill_b":       {"type": "number", "index": "range"},
                "fill_hex":     {"type": "string", "index": "exact"},
                "stroke_hex":   {"type": "string", "index": "exact"},
                "opacity":      {"type": "number", "index": "range"},
                "font_size":    {"type": "number", "index": "range"},
                "font_weight":  {"type": "string", "index": "exact"},
                "text":         {"type": "string", "index": "keyword"},
                "role":         {"type": "string", "index": "exact"},
                "is_clickable": {"type": "boolean","index": "exact"},
                "is_text_node": {"type": "boolean","index": "exact"},
                "display":      {"type": "string", "index": "exact"},
                "position":     {"type": "string", "index": "exact"},
                "flex_child":   {"type": "boolean","index": "exact"},
                "grid_child":   {"type": "boolean","index": "exact"},
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
                "FLOWS_BEFORE": {
                    "targetTypes": ["Element"],
                    "directed":    True,
                    "cardinality": "many-to-many",
                },
                "VISUALLY_ABOVE": {
                    "targetTypes": ["Element"],
                    "directed":    True,
                    "cardinality": "many-to-many",
                },
            },
        },
    },
})
```

---

## Step 3 — Raw SVG parser (xml.etree only)

```python
import xml.etree.ElementTree as ET

CLICKABLE_TAGS = {"a", "button", "input", "select", "textarea", "label",
                  "summary", "details", "area"}
TEXT_TAGS      = {"p","h1","h2","h3","h4","h5","h6","span","em","strong",
                  "li","td","th","caption","figcaption","article","section"}

def index_svg(vapor, svg_text: str) -> dict:
    """
    Parse SVG using xml.etree.ElementTree (built-in).
    Extracts x, y, width, height, fill, stroke, opacity for every element.
    Parses inline style with css_colour_to_rgb / parse_length_value.
    """
    root   = ET.fromstring(svg_text)
    id_map: dict[str, str] = {}
    z_counter = [0]

    def resolve_fill(el) -> tuple[str, float, float, float]:
        style = parse_inline_style(el.get("style",""))
        fill  = style.get("fill") or el.get("fill","") or "none"
        if fill == "none" or not fill: return ("none", 0.0, 0.0, 0.0)
        r,g,b = css_colour_to_rgb(fill)
        # Normalise hex representation
        hex_val = f"#{int(r):02x}{int(g):02x}{int(b):02x}"
        return (hex_val, float(r), float(g), float(b))

    def resolve_stroke(el) -> str:
        style = parse_inline_style(el.get("style",""))
        stroke = style.get("stroke") or el.get("stroke","") or "none"
        if stroke == "none" or not stroke: return "none"
        r,g,b = css_colour_to_rgb(stroke)
        return f"#{int(r):02x}{int(g):02x}{int(b):02x}"

    def get_attr_float(el, *attrs, default=0.0) -> float:
        for a in attrs:
            v = el.get(a)
            if v:
                try: return float(v.rstrip("px %"))
                except: pass
        return default

    def index_el(el, parent_vid, depth, flow_order):
        ns  = el.tag.split("}")[1] if "}" in el.tag else el.tag
        tag = ns.lower()
        if tag in ("defs","style","script","metadata","mask","clippath"):
            return flow_order

        z_counter[0] += 1
        style     = parse_inline_style(el.get("style",""))
        fill_hex, fill_r, fill_g, fill_b = resolve_fill(el)
        stroke_hex = resolve_stroke(el)

        # Geometry — SVG uses x/y for rect, cx/cy for circle, x1/y1 for line
        x = get_attr_float(el,"x","x1","cx")
        y = get_attr_float(el,"y","y1","cy")
        w = get_attr_float(el,"width","r") * (2 if el.get("r") else 1)
        h = get_attr_float(el,"height","r") * (2 if el.get("r") else 1)

        # CSS override
        if "left" in style:   x = parse_length_value(style["left"])
        if "top"  in style:   y = parse_length_value(style["top"])
        if "width" in style:  w = parse_length_value(style["width"])
        if "height" in style: h = parse_length_value(style["height"])

        opacity = float(el.get("opacity", style.get("opacity","1.0")) or "1.0")
        font_sz = parse_length_value(el.get("font-size", style.get("font-size","0")))
        font_wt = style.get("font-weight","normal")
        display = style.get("display","block")
        position= style.get("position","static")
        z_idx   = float(style.get("z-index","0") or "0")
        text_content = "".join(el.itertext()).strip()[:200]

        role = el.get("role","")
        is_clickable = tag in CLICKABLE_TAGS or role in ("button","link","menuitem")
        is_text_node = tag in TEXT_TAGS or bool(text_content)

        vid = vapor.store("Element", {
            "tag":          tag,
            "elem_id":      el.get("id",""),
            "classes":      el.get("class",""),
            "x": x, "y": y, "width": w, "height": h,
            "area":         w * h,
            "depth":        float(depth),
            "z_index":      z_idx or float(z_counter[0]),
            "fill_r":       fill_r, "fill_g": fill_g, "fill_b": fill_b,
            "fill_hex":     fill_hex,
            "stroke_hex":   stroke_hex,
            "opacity":      opacity,
            "font_size":    font_sz,
            "font_weight":  font_wt,
            "text":         text_content,
            "role":         role,
            "is_clickable": is_clickable,
            "is_text_node": is_text_node,
            "display":      display,
            "position":     position,
            "flex_child":   False,
            "grid_child":   False,
        })

        eid = el.get("id") or f"{tag}_{depth}_{z_counter[0]}"
        id_map[eid] = vid

        if parent_vid:
            vapor.relate(parent_vid, "CONTAINS", vid)
        if flow_order:
            vapor.relate(flow_order, "FLOWS_BEFORE", vid)

        prev_child = None
        for child in el:
            prev_child = index_el(child, vid, depth+1, prev_child)
        return vid

    prev = None
    for child in root:
        prev = index_el(child, None, 0, prev)

    print(f"Indexed {vapor.stats().total_records} SVG elements.")
    return id_map
```

---

## Step 4 — Raw HTML parser (html.parser only)

```python
from html.parser import HTMLParser

VOID_ELEMENTS = {"area","base","br","col","embed","hr","img","input",
                 "link","meta","param","source","track","wbr"}

class HTMLIndexer(HTMLParser):
    """
    Index HTML elements into vapor using only Python's built-in html.parser.
    Parses inline styles with parse_inline_style.
    Builds containment hierarchy via stack.
    """
    def __init__(self, vapor):
        super().__init__()
        self.vapor      = vapor
        self.stack:     list[str] = []   # vapor IDs
        self.flow_prev: list[str|None] = [None]  # flow predecessor per depth
        self.id_map:    dict[str,str] = {}
        self.z_counter  = 0
        self.depth      = 0

    def handle_starttag(self, tag, attrs):
        attrs     = dict(attrs)
        self.z_counter += 1
        style     = parse_inline_style(attrs.get("style",""))

        x  = parse_length_value(style.get("left","0"))
        y  = parse_length_value(style.get("top","0"))
        w  = parse_length_value(style.get("width","0"))
        h  = parse_length_value(style.get("height","0"))

        bg    = style.get("background-color") or style.get("background","")
        fill_r, fill_g, fill_b = css_colour_to_rgb(bg) if bg else (0,0,0)
        fill_hex = (f"#{int(fill_r):02x}{int(fill_g):02x}{int(fill_b):02x}"
                    if bg else "none")

        stroke   = style.get("border-color","none")
        font_sz  = parse_length_value(style.get("font-size","0"))
        font_wt  = style.get("font-weight","normal")
        opacity  = float(style.get("opacity","1.0") or "1.0")
        display  = style.get("display","block")
        position = style.get("position","static")
        z_idx    = float(style.get("z-index","0") or "0")
        role     = attrs.get("role","")
        is_click = tag in CLICKABLE_TAGS or role in ("button","link","menuitem")
        is_text  = tag in TEXT_TAGS

        vid = self.vapor.store("Element", {
            "tag":          tag,
            "elem_id":      attrs.get("id",""),
            "classes":      attrs.get("class",""),
            "x": x, "y": y, "width": w, "height": h,
            "area":         w * h,
            "depth":        float(self.depth),
            "z_index":      z_idx or float(self.z_counter),
            "fill_r":       float(fill_r), "fill_g": float(fill_g), "fill_b": float(fill_b),
            "fill_hex":     fill_hex,
            "stroke_hex":   stroke or "none",
            "opacity":      opacity,
            "font_size":    font_sz,
            "font_weight":  font_wt,
            "text":         "",
            "role":         role,
            "is_clickable": is_click,
            "is_text_node": is_text,
            "display":      display,
            "position":     position,
            "flex_child":   display == "flex",
            "grid_child":   display == "grid",
        })

        eid = attrs.get("id") or f"{tag}_{self.z_counter}"
        self.id_map[eid] = vid

        if self.stack:
            self.vapor.relate(self.stack[-1], "CONTAINS", vid)

        # Document flow order
        if self.flow_prev and self.flow_prev[-1]:
            self.vapor.relate(self.flow_prev[-1], "FLOWS_BEFORE", vid)
        if self.flow_prev:
            self.flow_prev[-1] = vid

        if tag not in VOID_ELEMENTS:
            self.stack.append(vid)
            self.flow_prev.append(None)
            self.depth += 1

    def handle_data(self, data):
        text = data.strip()
        if text and self.stack:
            rec = self.vapor.get(self.stack[-1])
            if rec:
                existing = rec.data.get("text","")
                self.vapor.update(self.stack[-1], {
                    "text": (existing + " " + text)[:200].strip(),
                    "is_text_node": True,
                })

    def handle_endtag(self, tag):
        if tag not in VOID_ELEMENTS and self.stack:
            self.stack.pop()
            if self.flow_prev:
                self.flow_prev.pop()
            self.depth = max(0, self.depth - 1)


def index_html(vapor, html_text: str) -> dict:
    """Index HTML into vapor using only html.parser (built-in)."""
    indexer = HTMLIndexer(vapor)
    indexer.feed(html_text)
    print(f"Indexed {vapor.stats().total_records} HTML elements.")
    return indexer.id_map
```

---

## Step 5 — Build spatial relationships + 5x layout validation

```python
def build_spatial_relationships(vapor) -> None:
    """
    Compute ADJACENT_TO, OVERLAPS_WITH, and VISUALLY_ABOVE relationships
    between all indexed elements.
    """
    all_els = vapor.query(QueryOptions(type="Element"))
    recs    = all_els.records

    for i in range(len(recs)):
        for j in range(i+1, len(recs)):
            a = recs[i].data
            b = recs[j].data

            ax1,ay1 = a["x"],       a["y"]
            ax2,ay2 = a["x"]+a["width"], a["y"]+a["height"]
            bx1,by1 = b["x"],       b["y"]
            bx2,by2 = b["x"]+b["width"], b["y"]+b["height"]

            overlap = not (ax2 < bx1 or bx2 < ax1 or ay2 < by1 or by2 < ay1)
            adjacency_gap = 10  # pixels

            horiz_adj = (abs(ax2-bx1) < adjacency_gap or abs(bx2-ax1) < adjacency_gap)
            vert_adj  = (abs(ay2-by1) < adjacency_gap or abs(by2-ay1) < adjacency_gap)

            if overlap and not (recs[i].id == recs[j].id):
                vapor.relate(recs[i].id, "OVERLAPS_WITH", recs[j].id)
                # Higher z-index is visually above
                if a.get("z_index",0) > b.get("z_index",0):
                    vapor.relate(recs[i].id, "VISUALLY_ABOVE", recs[j].id)
                elif b.get("z_index",0) > a.get("z_index",0):
                    vapor.relate(recs[j].id, "VISUALLY_ABOVE", recs[i].id)
            elif (horiz_adj or vert_adj) and not overlap:
                vapor.relate(recs[i].id, "ADJACENT_TO", recs[j].id)

    print(f"Spatial relationships built for {len(recs)} elements.")


def validate_layout_5x(vapor) -> dict:
    """
    5-pass validation of layout consistency.
    Each pass checks:
    - Containment: child bounding boxes should fit within parent
    - Overlap: overlapping elements at same z-index = potential layout bug
    - Flow: FLOWS_BEFORE order matches visual top→bottom, left→right
    Returns validation report.
    """
    issues: list[dict] = []

    for pass_num in range(5):
        pass_issues = []

        # Check containment violations
        all_contains = vapor.query(QueryOptions(type="Element"))
        for rec in all_contains.records:
            parent_rels = vapor.getRelationships(rec.id, "CONTAINS", "outgoing")
            for pr in parent_rels:
                child = vapor.get(pr.target_id)
                if not child: continue
                p = rec.data; c = child.data
                if (p["width"] > 0 and p["height"] > 0 and
                    (c["x"] < p["x"] or c["y"] < p["y"] or
                     c["x"]+c["width"] > p["x"]+p["width"] or
                     c["y"]+c["height"] > p["y"]+p["height"])):
                    pass_issues.append({
                        "type": "containment_violation",
                        "pass": pass_num+1,
                        "parent": p.get("tag","?") + "#" + p.get("elem_id",""),
                        "child":  c.get("tag","?") + "#" + c.get("elem_id",""),
                        "detail": f"child ({c['x']:.0f},{c['y']:.0f} {c['width']:.0f}×{c['height']:.0f}) exceeds parent ({p['x']:.0f},{p['y']:.0f} {p['width']:.0f}×{p['height']:.0f})"
                    })

        # Check same-z overlaps
        overlap_recs = vapor.query(QueryOptions(type="Element"))
        seen_overlaps = set()
        for rec in overlap_recs.records:
            ovl_rels = vapor.getRelationships(rec.id, "OVERLAPS_WITH", "both")
            for or_ in ovl_rels:
                pair = frozenset({rec.id, or_.target_id if or_.source_id==rec.id else or_.source_id})
                if pair in seen_overlaps: continue
                seen_overlaps.add(pair)
                other = vapor.get(or_.target_id if or_.source_id==rec.id else or_.source_id)
                if other and abs(rec.data.get("z_index",0) - other.data.get("z_index",0)) < 0.1:
                    pass_issues.append({
                        "type": "same_z_overlap",
                        "pass": pass_num+1,
                        "elem_a": rec.data.get("tag","?")+"#"+rec.data.get("elem_id",""),
                        "elem_b": other.data.get("tag","?")+"#"+other.data.get("elem_id",""),
                    })

        issues.extend(pass_issues)
        print(f"  Layout validation pass {pass_num+1}/5: {len(pass_issues)} issues.")

    # Summarise
    from collections import Counter
    type_counts = Counter(i["type"] for i in issues)
    return {"total_issues": len(issues), "by_type": dict(type_counts),
            "issues": issues[:20]}  # first 20
```

---

## Step 6 — Queries

```python
# Elements with blue fill (exact-indexed hex)
blue = vapor.query(QueryOptions(type="Element",
    where=FieldFilter(field="fill_hex", op="eq", value="#0000ff")))

# Large elements
large = vapor.query(QueryOptions(type="Element",
    where=FieldFilter(field="area", op="gt", value=10000),
    order_by=("area","desc"), limit=10))

# All clickable elements (exact-indexed boolean)
clickable = vapor.query(QueryOptions(type="Element",
    where=FieldFilter(field="is_clickable", op="eq", value=True)))
print(f"Clickable elements: {clickable.total}")

# Deep nesting (depth > 5) — range field, gte+lte for exact depth
depth5 = vapor.query(QueryOptions(type="Element",
    where=FieldFilter(field="depth", op="gt", value=5)))

# Root elements (depth = 0 — use gte+lte)
roots = vapor.query(QueryOptions(type="Element", where=[
    FieldFilter(field="depth", op="gte", value=0.0),
    FieldFilter(field="depth", op="lte", value=0.0),
]))

# Text elements with specific keywords
buttons = vapor.query(QueryOptions(type="Element",
    keywords="button submit login sign"))

# Semi-transparent
transparent = vapor.query(QueryOptions(type="Element",
    where=FieldFilter(field="opacity", op="lt", value=1.0)))

# Overlapping elements
overlapping_ids = set()
all_els = vapor.query(QueryOptions(type="Element"))
for rec in all_els.records:
    ovl = vapor.getRelationships(rec.id, "OVERLAPS_WITH", "both")
    if ovl: overlapping_ids.add(rec.id)
print(f"Elements in overlap relationships: {len(overlapping_ids)}")

# Traverse containment tree from root
root_rec = roots.records[0] if roots.records else None
if root_rec:
    subtree = vapor.traverse(TraversalOptions(
        from_id=root_rec.id, relationship="CONTAINS",
        direction="outgoing", depth=6))
    print(f"Elements in subtree of first root: {len(subtree.records)}")
```

---

## Step 7 — Reconstruct as raw CSS

```python
def reconstruct_css(vapor) -> str:
    """Emit raw CSS absolute-positioning layout from the element index."""
    lines = [
        "/* Reconstructed by vapor-idx — no library */",
        ".canvas { position: relative; width: 100%; height: 100%; }",
    ]
    all_els = vapor.query(QueryOptions(type="Element",
                           order_by=("z_index","asc")))
    for rec in all_els.records:
        d    = rec.data
        eid  = d.get("elem_id") or f"el_{rec.id[:8]}"
        fill = d.get("fill_hex","transparent") or "transparent"
        if fill == "none": fill = "transparent"
        stroke = d.get("stroke_hex","")
        border = f"border: 1px solid {stroke};" if stroke and stroke!="none" else ""
        fw     = f"font-weight: {d.get('font_weight','normal')};"
        fs     = (f"font-size: {d.get('font_size',0):.1f}px;" if d.get("font_size",0)>0 else "")
        op     = d.get("opacity",1.0)
        lines.append(
            f"\n#{eid} {{\n"
            f"  position: absolute;\n"
            f"  left:    {d.get('x',0):.1f}px;\n"
            f"  top:     {d.get('y',0):.1f}px;\n"
            f"  width:   {d.get('width',0):.1f}px;\n"
            f"  height:  {d.get('height',0):.1f}px;\n"
            f"  background-color: {fill};\n"
            f"  {border}\n"
            f"  opacity: {op};\n"
            f"  z-index: {int(d.get('z_index',0))};\n"
            f"  {fw} {fs}\n"
            f"}}"
        )
    return "\n".join(lines)

with open("layout.css","w") as f:
    f.write(reconstruct_css(vapor))
print("Saved layout.css")
```

---

## Step 8 — Reconstruct as clean SVG

```python
def reconstruct_svg(vapor, view_w: float = 1200, view_h: float = 800) -> str:
    """Emit raw SVG from the element index — no SVG library."""
    lines = [f'<svg viewBox="0 0 {view_w} {view_h}" xmlns="http://www.w3.org/2000/svg">']
    all_els = vapor.query(QueryOptions(type="Element",
                           order_by=("z_index","asc")))
    for rec in all_els.records:
        d = rec.data
        if not d.get("width") or not d.get("height"): continue
        fill   = d.get("fill_hex","none") or "none"
        stroke = d.get("stroke_hex","none") or "none"
        op     = d.get("opacity",1.0)
        eid    = d.get("elem_id","")
        id_attr= f' id="{eid}"' if eid else ""
        text   = d.get("text","")
        lines.append(
            f'  <rect{id_attr} x="{d["x"]:.1f}" y="{d["y"]:.1f}" '
            f'width="{d["width"]:.1f}" height="{d["height"]:.1f}" '
            f'fill="{fill}" stroke="{stroke}" opacity="{op}" />'
        )
        if text:
            cx = d["x"] + d["width"]/2
            cy = d["y"] + d["height"]/2 + 5
            lines.append(
                f'  <text x="{cx:.1f}" y="{cy:.1f}" text-anchor="middle" '
                f'font-size="{max(10,int(d.get("font_size",12)))}" fill="#333">'
                f'{text[:40]}</text>'
            )
    lines.append("</svg>")
    return "\n".join(lines)

with open("layout.svg","w") as f:
    f.write(reconstruct_svg(vapor))
print("Saved layout.svg")
```

---

## Step 9 — Full pipeline

```python
# SVG source
svg_text  = open("design.svg").read()
id_map    = index_svg(vapor, svg_text)

# or HTML source
# html_text = open("page.html").read()
# id_map    = index_html(vapor, html_text)

build_spatial_relationships(vapor)
validation = validate_layout_5x(vapor)
print(f"\nLayout issues found: {validation['total_issues']}")
for issue_type, count in validation["by_type"].items():
    print(f"  {count}× {issue_type}")
```

## Step 10 — Destroy

```python
vapor.destroy()
```

## Output

Report: total element count, depth distribution, colour palette (by fill_hex),
clickable element count, overlap/containment violations from validation pass.
Save CSS and SVG files with paths.
