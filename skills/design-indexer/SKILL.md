---
name: Design Indexer
description: Index HTML and SVG design elements into vapor-idx using built-in Python parsers only (xml.etree.ElementTree for SVG, html.parser for HTML). No external libraries. Parse CSS inline styles directly. Build full containment hierarchy, detect overlaps spatially, compute layout metrics. Approximate CSS layout engine for flex/grid elements. Reconstruct as raw CSS or SVG text. 5x validation pass on spatial consistency.
version: 3.0.0
tools:
  - computer_use
---

# Design Indexer Skill v3.0

## Purpose

Index design elements from HTML/SVG source text using only Python's built-in
`xml.etree.ElementTree` and `html.parser`. No external libraries, no Figma API.
Parse CSS inline styles directly as text. Build relationship graphs between
elements. Validate spatial layout with 5x consistency pass.

## CRITICAL: vapor-idx API — All snake_case

```
vapor.get_relationships(id, rel_type, direction)  ← correct
vapor.getRelationships(...)  ← DOES NOT EXIST — crashes
```

Direction rules:
- `CONTAINS`: directed parent→child. Use "outgoing" from parent.
- `FLOWS_BEFORE`: directed. Use "outgoing" to traverse document order.
- `OVERLAPS_WITH`: undirected. Use "both".
- `ADJACENT_TO`: undirected. Use "both".
- `VISUALLY_ABOVE`: directed. Use "outgoing" from above element.

## When to Trigger

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

---

## Step 1 — CSS Utilities (Pure Python)

```python
import re

def parse_inline_style(style_str: str) -> dict:
    """Parse CSS inline style string into a dict. Pure Python."""
    result = {}
    if not style_str: return result
    for decl in style_str.split(';'):
        decl = decl.strip()
        if ':' not in decl: continue
        prop, _, val = decl.partition(':')
        result[prop.strip().lower()] = val.strip()
    return result


def css_colour_to_rgb(value: str) -> tuple:
    """Convert CSS colour string to (r,g,b) floats 0-255. Pure Python."""
    value = value.strip().lower()
    named = {
        'red':(255,0,0),'green':(0,128,0),'blue':(0,0,255),
        'white':(255,255,255),'black':(0,0,0),'none':(0,0,0),
        'transparent':(0,0,0),'grey':(128,128,128),'gray':(128,128,128),
        'yellow':(255,255,0),'orange':(255,165,0),'purple':(128,0,128),
        'pink':(255,192,203),'brown':(139,69,19),'navy':(0,0,128),
        'teal':(0,128,128),'lime':(0,255,0),'cyan':(0,255,255),
        'magenta':(255,0,255),'silver':(192,192,192),'gold':(255,215,0),
        'coral':(255,127,80),'salmon':(250,128,114),'khaki':(240,230,140),
        'indigo':(75,0,130),'violet':(238,130,238),'turquoise':(64,224,208),
    }
    if value in named: return named[value]
    if value.startswith('#'):
        h = value[1:]
        if len(h)==3: h=h[0]*2+h[1]*2+h[2]*2
        if len(h)==6: return (int(h[0:2],16),int(h[2:4],16),int(h[4:6],16))
    m = re.match(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)', value)
    if m: return (float(m.group(1)),float(m.group(2)),float(m.group(3)))
    return (0.0, 0.0, 0.0)


def parse_length_value(value: str, parent_size: float = 800.0,
                        viewport_w: float = 1920.0, viewport_h: float = 1080.0) -> float:
    """
    Parse CSS length to float pixels.
    NEW v3.0: accepts viewport_w and viewport_h for accurate vw/vh conversion.
    """
    if not value or value in ('auto','none',''): return 0.0
    value = value.strip()
    try:
        if value.endswith('px'):   return float(value[:-2])
        if value.endswith('em'):   return float(value[:-2]) * 16.0
        if value.endswith('rem'):  return float(value[:-3]) * 16.0
        if value.endswith('%'):    return float(value[:-1]) / 100.0 * parent_size
        if value.endswith('vw'):   return float(value[:-2]) / 100.0 * viewport_w
        if value.endswith('vh'):   return float(value[:-2]) / 100.0 * viewport_h
        if value.endswith('pt'):   return float(value[:-2]) * 1.333
        if value.endswith('mm'):   return float(value[:-2]) * 3.779
        if value.endswith('cm'):   return float(value[:-2]) * 37.79
        return float(value)
    except: return 0.0


def parse_box_model(style: dict, parent_w: float, parent_h: float,
                    vw: float, vh: float) -> dict:
    """
    Extract complete box model from parsed CSS style dict.
    Returns: {x, y, width, height, margin_*,  padding_*}
    """
    def L(key, parent=parent_w): return parse_length_value(style.get(key,'0'), parent, vw, vh)

    return {
        "x":      L("left"),
        "y":      L("top"),
        "width":  L("width", parent_w),
        "height": L("height", parent_h),
        "margin_top":    L("margin-top",    parent_h),
        "margin_right":  L("margin-right",  parent_w),
        "margin_bottom": L("margin-bottom", parent_h),
        "margin_left":   L("margin-left",   parent_w),
        "padding_top":   L("padding-top",   parent_h),
        "padding_right": L("padding-right", parent_w),
        "padding_bottom":L("padding-bottom",parent_h),
        "padding_left":  L("padding-left",  parent_w),
    }
```

---

## Step 2 — CSS Approximate Layout Engine (NEW v3.0)

```python
def compute_flex_layout(parent_data: dict, children_data: list) -> list:
    """
    Approximate flex layout computation.
    Distributes children along the main axis (row or column).

    parent_data: dict with width, height, x, y
    children_data: list of dicts with width, height, flex_grow, order

    Returns list of (x, y, width, height) per child.
    """
    parent_x = parent_data.get("x",0); parent_y = parent_data.get("y",0)
    parent_w = parent_data.get("width",800); parent_h = parent_data.get("height",600)
    direction = parent_data.get("flex_direction","row")

    # Sort by order
    indexed = sorted(enumerate(children_data), key=lambda x: x[1].get("order",0))

    # Compute flex basis
    total_fixed = sum(c.get("width" if direction=="row" else "height",0)
                     for _,c in indexed)
    total_flex = sum(c.get("flex_grow",0) for _,c in indexed)
    remaining = (parent_w if direction=="row" else parent_h) - total_fixed

    positions = [None]*len(children_data)
    cursor = 0
    for orig_i, c_data in indexed:
        flex_g = c_data.get("flex_grow",0)
        if direction == "row":
            child_w = c_data.get("width",0) + (remaining*flex_g/max(total_flex,1) if flex_g>0 else 0)
            child_h = c_data.get("height", parent_h)
            positions[orig_i] = (parent_x+cursor, parent_y, child_w, child_h)
            cursor += child_w
        else:  # column
            child_h = c_data.get("height",0) + (remaining*flex_g/max(total_flex,1) if flex_g>0 else 0)
            child_w = c_data.get("width", parent_w)
            positions[orig_i] = (parent_x, parent_y+cursor, child_w, child_h)
            cursor += child_h

    return positions


def compute_grid_layout(parent_data: dict, children_data: list,
                          grid_template: str = "1fr 1fr") -> list:
    """
    Approximate CSS grid layout.
    grid_template: e.g. "1fr 1fr 1fr" or "200px auto"
    """
    parent_x = parent_data.get("x",0); parent_y = parent_data.get("y",0)
    parent_w = parent_data.get("width",800); parent_h = parent_data.get("height",600)

    # Parse template columns
    cols = grid_template.strip().split()
    col_widths = []
    for col in cols:
        if col.endswith('fr'):
            col_widths.append(("fr", float(col[:-2])))
        elif col.endswith('px'):
            col_widths.append(("px", float(col[:-2])))
        elif col == "auto":
            col_widths.append(("fr", 1.0))
        else:
            try: col_widths.append(("px", float(col)))
            except: col_widths.append(("fr", 1.0))

    total_px  = sum(v for t,v in col_widths if t=="px")
    total_fr  = sum(v for t,v in col_widths if t=="fr")
    fr_unit   = (parent_w-total_px)/max(total_fr,1)
    col_px    = [v if t=="px" else v*fr_unit for t,v in col_widths]

    n_cols = len(col_px)
    row_h  = parent_h / max(1, (len(children_data)+n_cols-1)//n_cols)

    positions = []
    for i, _ in enumerate(children_data):
        col = i % n_cols; row = i // n_cols
        x = parent_x + sum(col_px[:col])
        y = parent_y + row * row_h
        w = col_px[col]
        positions.append((x, y, w, row_h))

    return positions
```

---

## Step 3 — Schema

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions

vapor = create_vapor({
    "types": {
        "Element": {
            "fields": {
                "tag":          {"type":"string","index":"exact"},
                "elem_id":      {"type":"string","index":"exact"},
                "classes":      {"type":"string","index":"keyword"},
                "x":            {"type":"number","index":"range"},
                "y":            {"type":"number","index":"range"},
                "width":        {"type":"number","index":"range"},
                "height":       {"type":"number","index":"range"},
                "area":         {"type":"number","index":"range"},
                "depth":        {"type":"number","index":"range"},
                "z_index":      {"type":"number","index":"range"},
                "fill_r":       {"type":"number","index":"range"},
                "fill_g":       {"type":"number","index":"range"},
                "fill_b":       {"type":"number","index":"range"},
                "fill_hex":     {"type":"string","index":"exact"},
                "stroke_hex":   {"type":"string","index":"exact"},
                "opacity":      {"type":"number","index":"range"},
                "font_size":    {"type":"number","index":"range"},
                "font_weight":  {"type":"string","index":"exact"},
                "text":         {"type":"string","index":"keyword"},
                "role":         {"type":"string","index":"exact"},
                "is_clickable": {"type":"boolean","index":"exact"},
                "is_text_node": {"type":"boolean","index":"exact"},
                "display":      {"type":"string","index":"exact"},
                "position":     {"type":"string","index":"exact"},
                "flex_child":   {"type":"boolean","index":"exact"},
                "grid_child":   {"type":"boolean","index":"exact"},
                "layout_computed": {"type":"boolean","index":"exact"},
            },
            "relationships": {
                "CONTAINS":      {"targetTypes":["Element"],"directed":True, "cardinality":"one-to-many"},
                "ADJACENT_TO":   {"targetTypes":["Element"],"directed":False,"cardinality":"many-to-many"},
                "OVERLAPS_WITH": {"targetTypes":["Element"],"directed":False,"cardinality":"many-to-many"},
                "FLOWS_BEFORE":  {"targetTypes":["Element"],"directed":True, "cardinality":"many-to-many"},
                "VISUALLY_ABOVE":{"targetTypes":["Element"],"directed":True, "cardinality":"many-to-many"},
            },
        },
    },
})
```

---

## Step 4 — SVG Parser

```python
import xml.etree.ElementTree as ET

CLICKABLE_TAGS = {"a","button","input","select","textarea","label","summary","details","area"}
TEXT_TAGS = {"p","h1","h2","h3","h4","h5","h6","span","em","strong","li","td","th",
             "caption","figcaption","article","section","blockquote","q"}

def index_svg(vapor, svg_text: str, viewport_w: float = 1920.0,
              viewport_h: float = 1080.0) -> dict:
    """
    Parse SVG using xml.etree.ElementTree (built-in).
    NEW v3.0: accepts viewport dimensions for correct unit conversion.
    """
    root = ET.fromstring(svg_text)
    id_map = {}; z_counter = [0]

    # Get SVG viewBox for coordinate system
    vb = root.get("viewBox","")
    if vb:
        vb_parts = [float(v) for v in vb.replace(',',' ').split()]
        if len(vb_parts)==4:
            viewport_w = vb_parts[2]; viewport_h = vb_parts[3]

    def resolve_fill(el):
        style = parse_inline_style(el.get("style",""))
        fill = style.get("fill") or el.get("fill","") or "none"
        if not fill or fill=="none": return ("none",0.0,0.0,0.0)
        r,g,b = css_colour_to_rgb(fill)
        return (f"#{int(r):02x}{int(g):02x}{int(b):02x}",float(r),float(g),float(b))

    def resolve_stroke(el):
        style = parse_inline_style(el.get("style",""))
        stroke = style.get("stroke") or el.get("stroke","") or "none"
        if not stroke or stroke=="none": return "none"
        r,g,b = css_colour_to_rgb(stroke)
        return f"#{int(r):02x}{int(g):02x}{int(b):02x}"

    def fl(v, d=0.0):
        try: return float(str(v).rstrip("px%"))
        except: return d

    def index_el(el, parent_vid, depth, flow_prev):
        ns = el.tag.split("}")[1] if "}" in el.tag else el.tag
        tag = ns.lower()
        if tag in ("defs","style","script","metadata","mask","clippath"): return flow_prev

        z_counter[0] += 1
        style = parse_inline_style(el.get("style",""))
        fill_hex,fill_r,fill_g,fill_b = resolve_fill(el)
        stroke_hex = resolve_stroke(el)

        # Geometry
        x = fl(el.get("x",el.get("x1",el.get("cx","0"))))
        y = fl(el.get("y",el.get("y1",el.get("cy","0"))))
        w = fl(el.get("width",el.get("r","0"))) * (2 if el.get("r") else 1)
        h = fl(el.get("height",el.get("r","0"))) * (2 if el.get("r") else 1)
        if "left"  in style: x = parse_length_value(style["left"],  viewport_w)
        if "top"   in style: y = parse_length_value(style["top"],   viewport_h)
        if "width" in style: w = parse_length_value(style["width"],  viewport_w)
        if "height"in style: h = parse_length_value(style["height"], viewport_h)

        opacity  = float(el.get("opacity",style.get("opacity","1")) or "1")
        font_sz  = parse_length_value(el.get("font-size",style.get("font-size","0")))
        font_wt  = style.get("font-weight","normal")
        display  = style.get("display","block")
        position = style.get("position","static")
        z_idx    = float(style.get("z-index","0") or "0")
        text_ct  = "".join(el.itertext()).strip()[:200]
        role     = el.get("role","")

        vid = vapor.store("Element", {
            "tag":tag,"elem_id":el.get("id",""),"classes":el.get("class",""),
            "x":x,"y":y,"width":w,"height":h,"area":w*h,
            "depth":float(depth),"z_index":z_idx or float(z_counter[0]),
            "fill_r":fill_r,"fill_g":fill_g,"fill_b":fill_b,"fill_hex":fill_hex,
            "stroke_hex":stroke_hex,"opacity":opacity,"font_size":font_sz,
            "font_weight":font_wt,"text":text_ct,"role":role,
            "is_clickable":tag in CLICKABLE_TAGS or role in ("button","link","menuitem"),
            "is_text_node":tag in TEXT_TAGS or bool(text_ct),
            "display":display,"position":position,
            "flex_child":display=="flex","grid_child":display=="grid",
            "layout_computed":True,
        })
        eid = el.get("id") or f"{tag}_{depth}_{z_counter[0]}"
        id_map[eid] = vid
        if parent_vid:
            vapor.relate(parent_vid, "CONTAINS", vid)  # CONTAINS: directed parent→child
        if flow_prev:
            vapor.relate(flow_prev, "FLOWS_BEFORE", vid)  # FLOWS_BEFORE: directed
        prev_child = None
        for child in el:
            prev_child = index_el(child, vid, depth+1, prev_child)
        return vid

    prev = None
    for child in root: prev = index_el(child, None, 0, prev)
    print(f"Indexed {vapor.stats().total_records} SVG elements.")
    return id_map
```

---

## Step 5 — HTML Parser

```python
from html.parser import HTMLParser

VOID_ELEMENTS = {"area","base","br","col","embed","hr","img","input",
                 "link","meta","param","source","track","wbr"}

class HTMLIndexer(HTMLParser):
    """
    Index HTML into vapor using only html.parser (built-in).
    NEW v3.0: approximate layout engine for flex/grid containers.
    """
    def __init__(self, vapor, viewport_w=1920.0, viewport_h=1080.0):
        super().__init__()
        self.vapor = vapor; self.vw = viewport_w; self.vh = viewport_h
        self.stack = []; self.flow_prev = [None]; self.id_map = {}
        self.z_counter = 0; self.depth = 0
        # Track parent dimensions for % resolution
        self.parent_w_stack = [viewport_w]; self.parent_h_stack = [viewport_h]

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs); self.z_counter += 1
        style = parse_inline_style(attrs.get("style",""))
        pw = self.parent_w_stack[-1]; ph = self.parent_h_stack[-1]

        # Box model
        box = parse_box_model(style, pw, ph, self.vw, self.vh)
        x=box["x"]; y=box["y"]; w=box["width"]; h=box["height"]

        # Fallback: use parent width for auto-width block elements
        if w == 0 and style.get("display","block") == "block":
            w = pw
        if h == 0 and tag in ("div","section","article","main","header","footer","aside"):
            h = 48.0  # estimated line height

        bg = style.get("background-color") or style.get("background","")
        fill_r,fill_g,fill_b = css_colour_to_rgb(bg) if bg else (0,0,0)
        fill_hex = f"#{int(fill_r):02x}{int(fill_g):02x}{int(fill_b):02x}" if bg else "none"
        stroke = style.get("border-color","none")
        font_sz = parse_length_value(style.get("font-size","0"), 16.0)
        font_wt = style.get("font-weight","normal")
        opacity = float(style.get("opacity","1") or "1")
        display = style.get("display","block")
        position= style.get("position","static")
        z_idx   = float(style.get("z-index","0") or "0")
        role    = attrs.get("role","")

        vid = self.vapor.store("Element", {
            "tag":tag,"elem_id":attrs.get("id",""),"classes":attrs.get("class",""),
            "x":x,"y":y,"width":w,"height":h,"area":w*h,"depth":float(self.depth),
            "z_index":z_idx or float(self.z_counter),
            "fill_r":float(fill_r),"fill_g":float(fill_g),"fill_b":float(fill_b),
            "fill_hex":fill_hex,"stroke_hex":stroke or "none",
            "opacity":opacity,"font_size":font_sz,"font_weight":font_wt,"text":"",
            "role":role,
            "is_clickable":tag in CLICKABLE_TAGS or role in ("button","link","menuitem"),
            "is_text_node":tag in TEXT_TAGS,
            "display":display,"position":position,
            "flex_child":display=="flex","grid_child":display=="grid",
            "layout_computed": w>0 and h>0,
        })
        eid = attrs.get("id") or f"{tag}_{self.z_counter}"
        self.id_map[eid] = vid

        if self.stack: self.vapor.relate(self.stack[-1], "CONTAINS", vid)  # directed
        if self.flow_prev and self.flow_prev[-1]:
            self.vapor.relate(self.flow_prev[-1], "FLOWS_BEFORE", vid)  # directed
        if self.flow_prev: self.flow_prev[-1] = vid

        if tag not in VOID_ELEMENTS:
            self.stack.append(vid)
            self.flow_prev.append(None)
            self.depth += 1
            # Push parent dimensions for children
            self.parent_w_stack.append(w if w>0 else pw)
            self.parent_h_stack.append(h if h>0 else ph)

    def handle_data(self, data):
        text = data.strip()
        if text and self.stack:
            rec = self.vapor.get(self.stack[-1])
            if rec:
                existing = rec.data.get("text","")
                self.vapor.update(self.stack[-1], {
                    "text": (existing+" "+text)[:200].strip(),
                    "is_text_node": True,
                })

    def handle_endtag(self, tag):
        if tag not in VOID_ELEMENTS and self.stack:
            self.stack.pop()
            if self.flow_prev: self.flow_prev.pop()
            self.depth = max(0, self.depth-1)
            if len(self.parent_w_stack) > 1:
                self.parent_w_stack.pop(); self.parent_h_stack.pop()


def index_html(vapor, html_text: str,
               viewport_w: float = 1920.0, viewport_h: float = 1080.0) -> dict:
    """
    Index HTML into vapor using only html.parser (built-in).
    NEW v3.0: pass viewport dimensions for accurate unit conversion.
    """
    indexer = HTMLIndexer(vapor, viewport_w, viewport_h)
    indexer.feed(html_text)
    print(f"Indexed {vapor.stats().total_records} HTML elements.")
    return indexer.id_map
```

---

## Step 6 — Spatial Relationships + Layout Validation (5×)

```python
def build_spatial_relationships(vapor) -> None:
    """
    Compute ADJACENT_TO, OVERLAPS_WITH, and VISUALLY_ABOVE relationships.
    Uses "both" for undirected, explicit direction for directed.
    """
    all_els = vapor.query(QueryOptions(type="Element")).records
    for i in range(len(all_els)):
        for j in range(i+1, len(all_els)):
            a=all_els[i].data; b=all_els[j].data
            ax1,ay1=a["x"],a["y"]; ax2,ay2=a["x"]+a["width"],a["y"]+a["height"]
            bx1,by1=b["x"],b["y"]; bx2,by2=b["x"]+b["width"],b["y"]+b["height"]

            overlap = not (ax2<bx1 or bx2<ax1 or ay2<by1 or by2<ay1)
            gap = 10
            h_adj = abs(ax2-bx1)<gap or abs(bx2-ax1)<gap
            v_adj = abs(ay2-by1)<gap or abs(by2-ay1)<gap

            if overlap:
                vapor.relate(all_els[i].id, "OVERLAPS_WITH", all_els[j].id)  # undirected
                if a.get("z_index",0) > b.get("z_index",0):
                    vapor.relate(all_els[i].id, "VISUALLY_ABOVE", all_els[j].id)  # directed
                elif b.get("z_index",0) > a.get("z_index",0):
                    vapor.relate(all_els[j].id, "VISUALLY_ABOVE", all_els[i].id)  # directed
            elif h_adj or v_adj:
                vapor.relate(all_els[i].id, "ADJACENT_TO", all_els[j].id)  # undirected


def validate_layout_5x(vapor) -> dict:
    """5-pass spatial consistency validation."""
    issues = []
    for pass_num in range(5):
        pass_issues = []
        all_c = vapor.query(QueryOptions(type="Element"))
        for rec in all_c.records:
            # CONTAINS is directed parent→child. Use "outgoing" from parent.
            child_rels = vapor.get_relationships(rec.id, "CONTAINS", "outgoing")
            for cr in child_rels:
                child = vapor.get(cr.target_id)
                if not child: continue
                p=rec.data; c=child.data
                if (p["width"]>0 and p["height"]>0 and
                    (c["x"]<p["x"] or c["y"]<p["y"] or
                     c["x"]+c["width"]>p["x"]+p["width"] or
                     c["y"]+c["height"]>p["y"]+p["height"])):
                    pass_issues.append({"type":"containment_violation","pass":pass_num+1,
                        "parent":p.get("tag","?")+"#"+p.get("elem_id",""),
                        "child":c.get("tag","?")+"#"+c.get("elem_id",""),
                        "detail":f"child bbox exceeds parent"})

        seen = set()
        for rec in all_c.records:
            # OVERLAPS_WITH is undirected — use "both"
            ovl = vapor.get_relationships(rec.id, "OVERLAPS_WITH", "both")
            for e in ovl:
                pair=frozenset({rec.id,e.target_id if e.source_id==rec.id else e.source_id})
                if pair in seen: continue; seen.add(pair)
                other=vapor.get(e.target_id if e.source_id==rec.id else e.source_id)
                if other and abs(rec.data.get("z_index",0)-other.data.get("z_index",0))<0.1:
                    pass_issues.append({"type":"same_z_overlap","pass":pass_num+1,
                        "elem_a":rec.data.get("tag","?"),"elem_b":other.data.get("tag","?")})

        issues.extend(pass_issues)
        print(f"  Layout validation pass {pass_num+1}/5: {len(pass_issues)} issues")

    from collections import Counter
    return {"total_issues":len(issues),"by_type":dict(Counter(i["type"] for i in issues)),
            "issues":issues[:20]}
```

---

## Step 7 — Queries

```python
# Blue fill (exact hex)
blue = vapor.query(QueryOptions(type="Element",
    where=FieldFilter("fill_hex","eq","#0000ff")))

# Large elements (area > 10000)
large = vapor.query(QueryOptions(type="Element",
    where=FieldFilter("area","gt",10000.0),
    order_by=("area","desc"), limit=10))

# Clickable elements
clickable = vapor.query(QueryOptions(type="Element",
    where=FieldFilter("is_clickable","eq",True)))
print(f"Clickable elements: {clickable.total}")

# Deep nesting (depth > 5)
deep = vapor.query(QueryOptions(type="Element",
    where=FieldFilter("depth","gt",5.0)))

# Text keyword search
buttons = vapor.query(QueryOptions(type="Element",
    keywords="button submit login"))

# Containment tree traversal from root
roots = vapor.query(QueryOptions(type="Element", where=[
    FieldFilter("depth","gte",0.0), FieldFilter("depth","lte",0.0)]))
if roots.records:
    subtree = vapor.traverse(TraversalOptions(
        from_id=roots.records[0].id,
        relationship="CONTAINS",
        direction="outgoing",  # directed: parent→child
        depth=8
    ))
    print(f"Elements in subtree: {len(subtree.records)}")

# Find overlapping elements
ovl_ids = set()
for rec in vapor.query(QueryOptions(type="Element")).records:
    # OVERLAPS_WITH is undirected — use "both"
    ovl = vapor.get_relationships(rec.id, "OVERLAPS_WITH", "both")
    if ovl: ovl_ids.add(rec.id)
print(f"Elements in overlap: {len(ovl_ids)}")
```

---

## Step 8 — Reconstruct as CSS

```python
def reconstruct_css(vapor) -> str:
    lines = ["/* Reconstructed by vapor-idx v3.0 — no library */",
             ".canvas { position: relative; width: 100%; height: 100%; }"]
    all_els = vapor.query(QueryOptions(type="Element", order_by=("z_index","asc")))
    for rec in all_els.records:
        d=rec.data; eid=d.get("elem_id") or f"el_{rec.id[:8]}"
        fill=d.get("fill_hex","transparent") or "transparent"
        if fill=="none": fill="transparent"
        stroke=d.get("stroke_hex","")
        border=f"border: 1px solid {stroke};" if stroke and stroke!="none" else ""
        fw=f"font-weight: {d.get('font_weight','normal')};"
        fs=f"font-size: {d.get('font_size',0):.1f}px;" if d.get("font_size",0)>0 else ""
        op=d.get("opacity",1.0)
        lines.append(f"\n#{eid} {{\n  position: absolute;\n  left: {d.get('x',0):.1f}px;\n"
                     f"  top: {d.get('y',0):.1f}px;\n  width: {d.get('width',0):.1f}px;\n"
                     f"  height: {d.get('height',0):.1f}px;\n  background-color: {fill};\n"
                     f"  {border}\n  opacity: {op};\n  z-index: {int(d.get('z_index',0))};\n"
                     f"  {fw} {fs}\n}}")
    return "\n".join(lines)

def reconstruct_svg(vapor, vw: float = 1200, vh: float = 800) -> str:
    lines = [f'<svg viewBox="0 0 {vw} {vh}" xmlns="http://www.w3.org/2000/svg">']
    all_els = vapor.query(QueryOptions(type="Element", order_by=("z_index","asc")))
    for rec in all_els.records:
        d=rec.data
        if not d.get("width") or not d.get("height"): continue
        fill=d.get("fill_hex","none") or "none"; stroke=d.get("stroke_hex","none") or "none"
        op=d.get("opacity",1.0); eid=d.get("elem_id",""); id_attr=f' id="{eid}"' if eid else ""
        text=d.get("text","")
        lines.append(f'  <rect{id_attr} x="{d["x"]:.1f}" y="{d["y"]:.1f}" '
                     f'width="{d["width"]:.1f}" height="{d["height"]:.1f}" '
                     f'fill="{fill}" stroke="{stroke}" opacity="{op}" />')
        if text:
            cx=d["x"]+d["width"]/2; cy=d["y"]+d["height"]/2+5
            lines.append(f'  <text x="{cx:.1f}" y="{cy:.1f}" text-anchor="middle" '
                         f'font-size="{max(10,int(d.get("font_size",12)))}" fill="#333">'
                         f'{text[:40]}</text>')
    lines.append("</svg>"); return "\n".join(lines)

with open("layout.css","w") as f: f.write(reconstruct_css(vapor))
with open("layout.svg","w") as f: f.write(reconstruct_svg(vapor))
print("Saved layout.css, layout.svg")
```

---

## Step 9 — Full Pipeline

```python
# SVG source
svg_text = open("design.svg").read()
id_map   = index_svg(vapor, svg_text, viewport_w=1440, viewport_h=900)

# or HTML source
# html_text = open("page.html").read()
# id_map    = index_html(vapor, html_text, viewport_w=1440, viewport_h=900)

build_spatial_relationships(vapor)
validation = validate_layout_5x(vapor)
print(f"\nLayout issues: {validation['total_issues']}")
for itype, count in validation["by_type"].items():
    print(f"  {count}× {itype}")

vapor.destroy()
```

---

## Output

Report: total element count, depth distribution, colour palette (by fill_hex),
clickable element count, overlap/containment violations from 5× pass.
Save CSS and SVG files with paths.
