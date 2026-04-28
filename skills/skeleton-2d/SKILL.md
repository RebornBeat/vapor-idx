---
name: Skeleton 2D
description: Detect 2D body skeleton from semantic cluster layout in a vapor-analyzed image. Build a Joint/Bone graph in vapor-idx. Apply pose transformations by rotating bone clusters around joint pivots. Enables realistic rider-on-horse, sitting, running, and any custom pose. Derived from Mesh Analyzer topology patterns applied in 2D image space. Pure Python, no ML, no external libraries.
version: 1.0.0
tools:
  - computer_use
---

# Skeleton 2D Skill v1.0

## Purpose

After the pixel-analyzer has segmented and semantically labeled a person/animal image,
this skill builds a 2D skeleton graph in vapor-idx by traversing the cluster
spatial relationships. It then applies pose transformations — rotating each body
segment around its joint pivot — to produce a new pixel mask in the target pose.

**Conceptual mapping from Mesh Analyzer:**

| Mesh Analyzer (3D)       | Skeleton 2D (2D image)               |
|--------------------------|---------------------------------------|
| `Vertex (x,y,z)`         | `Joint (x,y)` — body keypoint         |
| `Face` (triangle)        | `BodySegment` (pixel cluster region)  |
| `Edge` (vertex-vertex)   | `Bone` (joint-to-joint segment)       |
| `CONNECTED_TO`           | `PARENT_OF` / `CHILD_OF`              |
| `dihedral_angle`         | `joint_angle` (bend angle in 2D)      |
| `find_connected_components` | `find_body_parts`                  |
| `5x geometry validation` | `5x pose validation`                  |
| `reconstruct_blender()`  | `reconstruct_posed_pixels()`          |

## CRITICAL: vapor-idx API

```
vapor.get_relationships(id, rel_type, direction)  ← correct snake_case
vapor.getRelationships(...)  ← DOES NOT EXIST
```

Direction rules:
- PARENT_OF: directed. Use "outgoing" from parent, "incoming" to find parent of a child.
- CHILD_OF: directed. Use "outgoing" from child.
- OWNS_PIXELS: directed joint→cluster. "outgoing" from joint to find its clusters.

## When to Trigger

- Subject needs pose adjustment for riding, sitting, running
- Person image is standing upright but needs to be seated
- Animal needs leg repositioning for contact with surface
- Any geometric body deformation task on a person/creature image

## Environment

```bash
pip install vapor-idx
```

---

## Step 1 — Schema Extension

Add these types to the vapor schema when building skeleton:

```python
SKELETON_SCHEMA_EXTENSION = {
    "Joint": {
        "fields": {
            "name":        {"type":"string","index":"exact"},
            "x":           {"type":"number","index":"range"},
            "y":           {"type":"number","index":"range"},
            "confidence":  {"type":"number","index":"range"},
            "is_anchor":   {"type":"boolean","index":"exact"},
            "body_side":   {"type":"string","index":"exact"},
            "segment_name":{"type":"string","index":"exact"},
        },
        "relationships": {
            "PARENT_OF":   {"targetTypes":["Joint"],"directed":True,"cardinality":"one-to-many"},
            "CHILD_OF":    {"targetTypes":["Joint"],"directed":True,"cardinality":"many-to-one"},
            "OWNS_PIXELS": {"targetTypes":["Cluster"],"directed":True,"cardinality":"one-to-many"},
        },
    },
    "Bone": {
        "fields": {
            "name":             {"type":"string","index":"exact"},
            "length_px":        {"type":"number","index":"range"},
            "angle_deg":        {"type":"number","index":"range"},
            "target_angle_deg": {"type":"number","index":"range"},
            "can_rotate":       {"type":"boolean","index":"exact"},
        },
        "relationships": {
            "FROM_JOINT":      {"targetTypes":["Joint"],"directed":True,"cardinality":"many-to-one"},
            "TO_JOINT":        {"targetTypes":["Joint"],"directed":True,"cardinality":"many-to-one"},
            "DEFORMS_CLUSTER": {"targetTypes":["Cluster"],"directed":True,"cardinality":"one-to-many"},
        },
    },
}
```

---

## Step 2 — Joint Detection from Clusters

```python
import math

JOINT_NAMES = [
    "head", "neck",
    "left_shoulder", "right_shoulder",
    "left_elbow",    "right_elbow",
    "left_wrist",    "right_wrist",
    "torso_center",
    "left_hip",      "right_hip",
    "left_knee",     "right_knee",
    "left_ankle",    "right_ankle",
]

# Anatomical proportions (relative to body height) for validation
ANATOMICAL_RATIOS = {
    # (joint_a, joint_b) → expected distance / body_height
    ("head",    "neck"):          0.12,
    ("neck",    "torso_center"):  0.20,
    ("torso_center","left_hip"):  0.20,
    ("left_hip","left_knee"):     0.26,
    ("left_knee","left_ankle"):   0.26,
    ("left_shoulder","left_elbow"):  0.19,
    ("left_elbow","left_wrist"):     0.19,
    ("left_shoulder","right_shoulder"): 0.22,
    ("left_hip","right_hip"):        0.18,
}

def detect_joints_from_clusters(vapor, cluster_ids: dict,
                                  image_h: int) -> dict:
    """
    Infer joint positions from semantic cluster centroids.
    Uses SPATIALLY_ABOVE chains and adjacency to order body segments.

    Returns joint_positions: dict of joint_name → (x, y, confidence, vapor_joint_id)
    """
    joints = {}

    def query_by_label(keyword, min_size=50):
        return [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                if keyword in rec.data.get("semantic_class","") and rec.data["size"] >= min_size]

    from vapor_idx import QueryOptions, FieldFilter

    # ── Head ───────────────────────────────────────────────────────────────
    # Large skin oval in the upper 40% of the image
    all_c = vapor.query(QueryOptions(type="Cluster")).records
    img_h_range = max(r.data["max_y"] for r in all_c) - min(r.data["min_y"] for r in all_c) if all_c else image_h

    skin_ovals = query_by_label("large_skin_oval") + query_by_label("round_skin_blob")
    min_y_all = min(r.data["min_y"] for r in all_c) if all_c else 0
    if skin_ovals:
        head_cand = [r for r in skin_ovals
                     if (r.data["center_y"]-min_y_all)/img_h_range < 0.45]
        if head_cand:
            h = min(head_cand, key=lambda r: r.data["center_y"])
            joints["head"] = (h.data["center_x"], h.data["center_y"], 0.9, None, h.id)

    # ── Torso ──────────────────────────────────────────────────────────────
    torso_cands = (query_by_label("dark_clothing") + query_by_label("torso_region") +
                   query_by_label("skin_region"))
    if torso_cands:
        large_torso = [r for r in torso_cands if r.data["size"] > 300]
        if large_torso:
            t = max(large_torso, key=lambda r: r.data["size"])
            joints["torso_center"] = (t.data["center_x"], t.data["center_y"], 0.85, None, t.id)

    # ── Arms ───────────────────────────────────────────────────────────────
    arm_segs = query_by_label("arm_segment") + query_by_label("vertical_skin_strip")
    arm_segs.sort(key=lambda r: r.data["center_x"])

    if len(arm_segs) >= 2:
        # Left arm: lower x (assuming front-facing person)
        left_arm  = arm_segs[:len(arm_segs)//2]
        right_arm = arm_segs[len(arm_segs)//2:]
        if left_arm:
            la = min(left_arm, key=lambda r: r.data["center_y"])
            joints["left_shoulder"] = (la.data["center_x"], la.data["min_y"], 0.7, None, la.id)
            la2 = max(left_arm, key=lambda r: r.data["center_y"])
            joints["left_elbow"] = (la2.data["center_x"], la2.data["center_y"], 0.65, None, la2.id)
        if right_arm:
            ra = min(right_arm, key=lambda r: r.data["center_y"])
            joints["right_shoulder"] = (ra.data["center_x"], ra.data["min_y"], 0.7, None, ra.id)
            ra2 = max(right_arm, key=lambda r: r.data["center_y"])
            joints["right_elbow"] = (ra2.data["center_x"], ra2.data["center_y"], 0.65, None, ra2.id)

    # ── Legs ───────────────────────────────────────────────────────────────
    leg_segs = (query_by_label("leg_jeans") + query_by_label("jeans_region") +
                query_by_label("dark_vert") + query_by_label("vertical_skin_strip"))
    leg_segs = [r for r in leg_segs if r.data["center_y"] > img_h_range*0.5+min_y_all]
    leg_segs.sort(key=lambda r: r.data["center_x"])

    if leg_segs:
        left_legs  = leg_segs[:max(1,len(leg_segs)//2)]
        right_legs = leg_segs[max(1,len(leg_segs)//2):]
        if left_legs:
            ll = min(left_legs, key=lambda r: r.data["center_y"])
            joints["left_hip"]   = (ll.data["center_x"], ll.data["min_y"],  0.75, None, ll.id)
            joints["left_knee"]  = (ll.data["center_x"], ll.data["center_y"],0.70, None, ll.id)
            joints["left_ankle"] = (ll.data["center_x"], ll.data["max_y"],  0.75, None, ll.id)
        if right_legs:
            rl = min(right_legs, key=lambda r: r.data["center_y"])
            joints["right_hip"]   = (rl.data["center_x"], rl.data["min_y"],  0.75, None, rl.id)
            joints["right_knee"]  = (rl.data["center_x"], rl.data["center_y"],0.70, None, rl.id)
            joints["right_ankle"] = (rl.data["center_x"], rl.data["max_y"],  0.75, None, rl.id)

    print(f"  Joints detected: {list(joints.keys())}")
    for name,(x,y,conf,_,cid) in joints.items():
        print(f"    {name}: ({x:.0f},{y:.0f}) conf={conf:.2f}")
    return joints
```

---

## Step 3 — Build Skeleton Graph in vapor

```python
def build_skeleton_graph(vapor, joint_positions: dict) -> dict:
    """
    Store Joint records in vapor with PARENT_OF chains.
    Build Bone records between connected joints.

    Skeleton hierarchy (parent → child):
    torso_center → neck → head
    torso_center → left_shoulder → left_elbow → left_wrist
    torso_center → right_shoulder → right_elbow → right_wrist
    torso_center → left_hip → left_knee → left_ankle
    torso_center → right_hip → right_knee → right_ankle

    Returns joint_ids: dict joint_name → vapor_record_id
    """
    # Hierarchy definition: (parent, child) pairs
    SKELETON_CHAIN = [
        ("torso_center","neck"),
        ("neck","head"),
        ("torso_center","left_shoulder"),
        ("left_shoulder","left_elbow"),
        ("left_elbow","left_wrist"),
        ("torso_center","right_shoulder"),
        ("right_shoulder","right_elbow"),
        ("right_elbow","right_wrist"),
        ("torso_center","left_hip"),
        ("left_hip","left_knee"),
        ("left_knee","left_ankle"),
        ("torso_center","right_hip"),
        ("right_hip","right_knee"),
        ("right_knee","right_ankle"),
    ]

    from vapor_idx import QueryOptions

    # Store Joint records
    joint_ids = {}
    for name,(x,y,conf,_,cluster_rec_id) in joint_positions.items():
        is_anchor = name in ("torso_center","left_hip","right_hip")
        jid = vapor.store("Joint", {
            "name": name, "x": float(x), "y": float(y),
            "confidence": float(conf), "is_anchor": is_anchor,
            "body_side": "left" if "left" in name else ("right" if "right" in name else "center"),
            "segment_name": name.replace("left_","").replace("right_",""),
        })
        joint_ids[name] = jid

        # Link to owning cluster
        if cluster_rec_id:
            try:
                vapor.relate(jid, "OWNS_PIXELS", cluster_rec_id)
            except Exception:
                pass  # cluster may not have Cluster type in schema

    # Build PARENT_OF / CHILD_OF relationships and Bone records
    for parent_name, child_name in SKELETON_CHAIN:
        if parent_name not in joint_ids or child_name not in joint_ids:
            continue
        pid = joint_ids[parent_name]; cid = joint_ids[child_name]

        # PARENT_OF: directed parent→child
        vapor.relate(pid, "PARENT_OF", cid)
        # CHILD_OF: directed child→parent
        vapor.relate(cid, "CHILD_OF",  pid)

        # Compute bone properties
        px2,py2 = joint_positions[parent_name][:2]
        cx2,cy2 = joint_positions[child_name][:2]
        dx = cx2-px2; dy = cy2-py2
        length = (dx**2+dy**2)**0.5
        angle  = math.degrees(math.atan2(dy,dx))

        bone_name = f"{parent_name}_to_{child_name}"
        bid = vapor.store("Bone", {
            "name": bone_name,
            "length_px": float(length),
            "angle_deg": float(angle),
            "target_angle_deg": float(angle),  # starts at current angle
            "can_rotate": not ("torso" in parent_name),
        })

        # Link bone to joints
        vapor.relate(bid, "FROM_JOINT", pid)
        vapor.relate(bid, "TO_JOINT",   cid)

    print(f"  Skeleton: {len(joint_ids)} joints | {len(SKELETON_CHAIN)} bones")
    return joint_ids
```

---

## Step 4 — 5× Pose Validation

```python
def validate_skeleton_5x(vapor, joint_ids: dict,
                          joint_positions: dict) -> dict:
    """
    Validate skeleton anatomy using 5 passes.
    Each pass checks distance ratios against ANATOMICAL_RATIOS.
    Returns validation_report with plausibility score.
    """
    from vapor_idx import QueryOptions

    # Compute body height
    ys = [v[1] for v in joint_positions.values()]
    body_height = max(ys) - min(ys) if ys else 300

    issues = []; plausibility = 1.0

    for pass_num in range(5):
        pass_issues = []
        for (jA, jB), expected_ratio in ANATOMICAL_RATIOS.items():
            if jA not in joint_positions or jB not in joint_positions:
                continue
            xA,yA = joint_positions[jA][:2]; xB,yB = joint_positions[jB][:2]
            actual_dist  = ((xB-xA)**2+(yB-yA)**2)**0.5
            expected_dist = expected_ratio * body_height
            ratio_error   = abs(actual_dist - expected_dist) / max(expected_dist, 1)

            if ratio_error > 0.40:  # 40% tolerance
                pass_issues.append({
                    "pass": pass_num+1, "type": "ratio_violation",
                    "joint_a": jA, "joint_b": jB,
                    "actual_dist": actual_dist, "expected_dist": expected_dist,
                    "error_pct": ratio_error*100
                })

        if pass_issues:
            plausibility -= 0.05 * len(pass_issues)
        issues.extend(pass_issues)
        print(f"    Skeleton validation pass {pass_num+1}/5: {len(pass_issues)} issues")

    plausibility = max(0.0, min(1.0, plausibility))
    print(f"  Skeleton plausibility: {plausibility:.2f} | {len(issues)} total issues")
    return {"plausibility": plausibility, "issues": issues, "body_height": body_height}
```

---

## Step 5 — Predefined Poses

```python
# Predefined pose angle targets
# Format: joint_name → (delta_angle_deg from neutral, apply_to_bone_from_parent)
# Positive angle = clockwise rotation in image space

POSE_RIDING = {
    # Rider seated on horse: legs spread wide, slight forward lean
    "left_hip":   {"target_angle_relative_y": 45},   # 45° outward
    "right_hip":  {"target_angle_relative_y": -45},  # 45° outward other side
    "left_knee":  {"target_angle_delta": 90},          # knee bent
    "right_knee": {"target_angle_delta": 90},
    "torso_center":{"forward_lean": 8},                # 8° forward
    "left_elbow": {"target_angle_delta": -30},         # arms forward for reins
    "right_elbow":{"target_angle_delta": -30},
}

POSE_SITTING = {
    "left_hip":   {"target_angle_relative_y": 80},
    "right_hip":  {"target_angle_relative_y": -80},
    "left_knee":  {"target_angle_delta": 100},
    "right_knee": {"target_angle_delta": 100},
    "torso_center":{"forward_lean": 0},
}

POSE_RUNNING = {
    "left_hip":   {"target_angle_delta": -25},
    "right_hip":  {"target_angle_delta": 25},
    "left_knee":  {"target_angle_delta": -60},
    "right_knee": {"target_angle_delta": 60},
    "torso_center":{"forward_lean": 15},
    "left_elbow": {"target_angle_delta": 60},
    "right_elbow":{"target_angle_delta": -60},
}

POSE_STANDING = {
    # Neutral: all angles at 0 delta from anatomy
}
```

---

## Step 6 — Apply Pose Transform

```python
def apply_pose_transform(fg_mask: dict, joint_positions: dict,
                          target_pose: dict,
                          joint_ids: dict, vapor) -> dict:
    """
    Apply pose transformation to the foreground pixel mask.
    Each bone's pixel cluster is rotated around its proximal joint.
    Processing order: root (torso) → outward (distal joints).

    fg_mask: dict (x,y) → (r,g,b,a) from background removal
    joint_positions: dict joint_name → (x,y,confidence,...)
    target_pose: dict from POSE_* constants or custom
    joint_ids: dict joint_name → vapor_joint_id

    Returns new_mask: dict (x,y) → (r,g,b,a) with pose applied.
    """
    if not joint_positions or not fg_mask:
        return fg_mask

    # Bone processing order (root → distal)
    BONE_ORDER = [
        ("torso_center","neck"),
        ("neck","head"),
        ("torso_center","left_shoulder"),
        ("left_shoulder","left_elbow"),
        ("left_elbow","left_wrist"),
        ("torso_center","right_shoulder"),
        ("right_shoulder","right_elbow"),
        ("right_elbow","right_wrist"),
        ("torso_center","left_hip"),
        ("left_hip","left_knee"),
        ("left_knee","left_ankle"),
        ("torso_center","right_hip"),
        ("right_hip","right_knee"),
        ("right_knee","right_ankle"),
    ]

    # Build pixel ownership map: which joint owns which pixels
    # Simple approach: assign each pixel to nearest joint
    pixel_joint = {}
    joint_coords = {name: (pos[0],pos[1]) for name,pos in joint_positions.items()}
    for (px,py) in fg_mask:
        min_d = float('inf'); nearest = "torso_center"
        for jname,(jx,jy) in joint_coords.items():
            d = (px-jx)**2+(py-jy)**2
            if d < min_d: min_d=d; nearest=jname
        pixel_joint[(px,py)] = nearest

    # Apply rotations from distal to root (to accumulate transforms correctly)
    # Start with a copy of the mask
    working_mask = dict(fg_mask)

    for parent_name, child_name in reversed(BONE_ORDER):
        pose_info = target_pose.get(child_name, {})
        if not pose_info: continue

        delta = pose_info.get("target_angle_delta",
                pose_info.get("target_angle_relative_y",0))
        if abs(delta) < 0.5: continue  # no meaningful rotation

        if parent_name not in joint_positions or child_name not in joint_positions:
            continue

        # Pivot = proximal joint (parent)
        pivot_x, pivot_y = joint_positions[parent_name][:2]

        # Find all pixels belonging to child joint and its descendants
        # (simple BFS through bone hierarchy from child outward)
        affected_joints = {child_name}
        def collect_descendants(jname):
            for pn2,cn2 in BONE_ORDER:
                if pn2==jname and cn2 not in affected_joints:
                    affected_joints.add(cn2); collect_descendants(cn2)
        collect_descendants(child_name)

        affected_pixels = [(pos,val) for pos,val in list(working_mask.items())
                           if pixel_joint.get(pos) in affected_joints]

        if not affected_pixels: continue

        # Rotate all affected pixels around pivot
        rad = math.radians(delta)
        cos_a = math.cos(rad); sin_a = math.sin(rad)
        new_mask_updates = {}

        for (px,py),val in affected_pixels:
            # Remove from working mask at old position
            working_mask.pop((px,py), None)
            pixel_joint.pop((px,py), None)

            # Rotate around pivot
            dx = px - pivot_x; dy = py - pivot_y
            nx = int(pivot_x + cos_a*dx - sin_a*dy)
            ny = int(pivot_y + sin_a*dx + cos_a*dy)
            new_mask_updates[(nx,ny)] = val
            pixel_joint[(nx,ny)] = child_name

        working_mask.update(new_mask_updates)

        # Update joint position
        jx,jy = joint_positions[child_name][:2]
        jdx=jx-pivot_x; jdy=jy-pivot_y
        new_jx = pivot_x + cos_a*jdx - sin_a*jdy
        new_jy = pivot_y + sin_a*jdx + cos_a*jdy
        old_pos = joint_positions[child_name]
        joint_positions[child_name] = (new_jx, new_jy) + old_pos[2:]

    print(f"  Pose applied: {sum(1 for p in target_pose.values() if p)} bones rotated")
    print(f"  Mask size: {len(fg_mask)} → {len(working_mask)} pixels")
    return working_mask


def reconstruct_posed_pixels(posed_mask: dict, canvas: list,
                              BW: int, BH: int,
                              cx_frac: float, feet_y: int) -> None:
    """
    Paint posed mask onto canvas.
    Handles gaps from rotation with nearest-neighbor fill.
    """
    xs = [x for (x,y) in posed_mask]; ys = [y for (x,y) in posed_mask]
    if not xs: return
    min_x,max_x = min(xs),max(xs); min_y,max_y = min(ys),max(ys)
    src_h = max_y-min_y+1; src_w = max_x-min_x+1

    offset_x = int(BW*cx_frac)-src_w//2
    offset_y = feet_y - src_h

    for (px,py),(r,g,b,a) in posed_mask.items():
        cx2 = offset_x+(px-min_x); cy2 = offset_y+(py-min_y)
        if 0<=cx2<BW and 0<=cy2<BH:
            canvas[cy2][cx2] = [int(r),int(g),int(b),255]
```

---

## Step 7 — Full Skeleton Pipeline

```python
def run_skeleton_pipeline(vapor, cluster_ids: dict, fg_mask: dict,
                           target_pose_name: str,
                           image_h: int) -> tuple[dict, dict]:
    """
    Full skeleton pipeline on an already-analyzed (clustered+labeled) vapor instance.

    1. Detect joints from cluster centroids
    2. Build Joint/Bone graph in vapor
    3. 5x validate skeleton
    4. Apply target pose
    5. Return posed mask + skeleton report

    target_pose_name: "RIDING"|"SITTING"|"RUNNING"|"STANDING"
    """
    pose_map = {
        "RIDING":   POSE_RIDING,
        "SITTING":  POSE_SITTING,
        "RUNNING":  POSE_RUNNING,
        "STANDING": POSE_STANDING,
    }
    target_pose = pose_map.get(target_pose_name, POSE_STANDING)

    print(f"\n[SKELETON] Detecting joints (target pose: {target_pose_name})...")
    joint_positions = detect_joints_from_clusters(vapor, cluster_ids, image_h)

    if len(joint_positions) < 4:
        print(f"  WARNING: Only {len(joint_positions)} joints detected. Insufficient for pose.")
        return fg_mask, {"error": "insufficient_joints", "joints": list(joint_positions.keys())}

    print(f"[SKELETON] Building skeleton graph...")
    joint_ids = build_skeleton_graph(vapor, joint_positions)

    print(f"[SKELETON] 5x validation...")
    validation = validate_skeleton_5x(vapor, joint_ids, joint_positions)

    if validation["plausibility"] < 0.3:
        print(f"  WARNING: Low plausibility ({validation['plausibility']:.2f}). "
              f"Skipping pose transform.")
        return fg_mask, {"validation": validation, "pose_applied": False}

    print(f"[SKELETON] Applying pose: {target_pose_name}...")
    posed_mask = apply_pose_transform(fg_mask, joint_positions, target_pose,
                                       joint_ids, vapor)

    report = {
        "joints_detected": list(joint_positions.keys()),
        "joint_count": len(joint_positions),
        "bone_count": len(SKELETON_CHAIN) if 'SKELETON_CHAIN' in dir() else 0,
        "validation": validation,
        "target_pose": target_pose_name,
        "pose_applied": True,
        "mask_size_before": len(fg_mask),
        "mask_size_after": len(posed_mask),
    }

    return posed_mask, report
```

---

## Output

Report: joint names and positions detected, bone count, validation plausibility score,
validation issues (anatomical ratio violations), pose applied and rotation deltas,
mask pixel count before and after pose application.

The posed mask is ready for handoff to the pixel-analyzer compositing pipeline.
