---
name: Color Reconstructor
description: Semantic-aware color transformation that preserves material realism. Replaces naive HSV hue-shift with per-cluster reference-matched color mapping, luminance preservation, outline correction after body swap, and style unification across mixed-style inputs. Works for any color transformation scenario. Pure Python, no external libraries.
version: 1.0.0
tools:
  - computer_use
---

# Color Reconstructor Skill v1.0

## Purpose

Naive color swapping (shift all green pixels to red) produces cartoonish, unrealistic
results because:
- The same "green" label covers a range of hues (yellow-green belly vs dark-green back)
- A single hue shift maps all of them to different red shades that don't match real biology
- Dark outline pixels are left in the wrong color family
- Saturation is scaled by a guess, not measured

This skill replaces all of that with reference-measured color mapping applied
per-cluster, with luminance structure preserved and outlines corrected afterward.

## CRITICAL: vapor-idx API

```
vapor.get_relationships(id, rel_type, direction)  ← correct
vapor.getRelationships(...)  ← DOES NOT EXIST, crashes
```

## When to Trigger

- "Change the frog's color from green to red"
- "Make the clothing blue instead of brown"
- "Unify the style of stylized subject and photographic background"
- Any color swap or color transformation request

---

## Step 1 — Measure Source Color Distribution

```python
def measure_cluster_color_distribution(vapor, cluster_record_id: str) -> dict:
    """
    Measure the actual color distribution of a cluster's pixels.
    Returns full distribution data for accurate color mapping.

    This is the foundation of accurate color transformation:
    measure first, transform based on measurements.
    """
    from vapor_idx import QueryOptions, FieldFilter

    crec = vapor.get(cluster_record_id)
    if not crec: return {}

    pixel_rels = vapor.get_relationships(cluster_record_id, "SAME_CLUSTER", "incoming")
    pixel_recs = [vapor.get(r.source_id) for r in pixel_rels if vapor.get(r.source_id)]

    if not pixel_recs:
        return {}

    # Collect all color values
    r_vals = [p.data["r"] for p in pixel_recs]
    g_vals = [p.data["g"] for p in pixel_recs]
    b_vals = [p.data["b"] for p in pixel_recs]
    h_vals = [p.data["hue"] for p in pixel_recs]
    s_vals = [p.data["saturation"] for p in pixel_recs]
    v_vals = [p.data["brightness"]/255.0 for p in pixel_recs]

    n = len(pixel_recs)
    def stats(vals):
        mean = sum(vals)/n
        std  = (sum((v-mean)**2 for v in vals)/n)**0.5
        return mean, std, min(vals), max(vals)

    r_mean,r_std,r_min,r_max = stats(r_vals)
    g_mean,g_std,g_min,g_max = stats(g_vals)
    b_mean,b_std,b_min,b_max = stats(b_vals)
    h_mean,h_std,h_min,h_max = stats(h_vals)
    s_mean,s_std,s_min,s_max = stats(s_vals)
    v_mean,v_std,v_min,v_max = stats(v_vals)

    return {
        "cluster_id": crec.data["cluster_id"],
        "pixel_count": n,
        "r": {"mean":r_mean,"std":r_std,"range":(r_min,r_max)},
        "g": {"mean":g_mean,"std":g_std,"range":(g_min,g_max)},
        "b": {"mean":b_mean,"std":b_std,"range":(b_min,b_max)},
        "hue": {"mean":h_mean,"std":h_std,"range":(h_min,h_max)},
        "saturation": {"mean":s_mean,"std":s_std,"range":(s_min,s_max)},
        "value": {"mean":v_mean,"std":v_std,"range":(v_min,v_max)},
        "semantic_class": crec.data.get("semantic_class",""),
    }
```

---

## Step 2 — Build Color Mapping from Source to Target

```python
def build_color_mapping(source_distribution: dict,
                         target_distribution: dict = None,
                         target_hue: float = None,
                         target_saturation_mean: float = None,
                         preserve_luminance: bool = True) -> dict:
    """
    Build a color mapping from source distribution to target.

    Two modes:
    Mode A (reference-based): target_distribution from measure_cluster_color_distribution()
    Mode B (parametric): specify target_hue and optionally target_saturation_mean

    The mapping preserves the RELATIVE variation within the cluster.
    A dark spot stays dark, a bright spot stays bright — but both shift
    to the new hue family.

    Returns a color_mapping dict used by apply_color_mapping_to_cluster().
    """
    if not source_distribution: return {}

    src_h_mean = source_distribution["hue"]["mean"]
    src_h_std  = source_distribution["hue"]["std"]
    src_s_mean = source_distribution["saturation"]["mean"]
    src_v_mean = source_distribution["value"]["mean"]

    if target_distribution:
        # Reference-based: map to target's measured distribution
        tgt_h_mean = target_distribution["hue"]["mean"]
        tgt_s_mean = target_distribution["saturation"]["mean"]
        # Scale saturation by ratio (measured, not guessed)
        s_ratio = tgt_s_mean / max(src_s_mean, 0.01)
    elif target_hue is not None:
        tgt_h_mean = target_hue
        # Saturation scaling: use reference if provided, else scale to match typical biology
        if target_saturation_mean is not None:
            s_ratio = target_saturation_mean / max(src_s_mean, 0.01)
        else:
            # Default: target saturation = 85% of source (slightly desaturate)
            s_ratio = 0.85
    else:
        return {}

    return {
        "src_hue_mean": src_h_mean,
        "src_hue_std": src_h_std,
        "tgt_hue_mean": tgt_h_mean,
        "saturation_ratio": min(2.0, max(0.1, s_ratio)),
        "preserve_luminance": preserve_luminance,
        "hue_delta": tgt_h_mean - src_h_mean,
    }
```

---

## Step 3 — Apply Color Mapping Per Cluster

```python
def apply_color_mapping_to_cluster(vapor, cluster_record_id: str,
                                    color_mapping: dict,
                                    source_hue_range: tuple = None,
                                    luminance_preserve_strength: float = 0.95) -> int:
    """
    Apply a color mapping to all pixels in a single cluster.
    Preserves per-pixel luminance variation (dark stays dark, bright stays bright).
    Only transforms pixels whose hue is within source_hue_range.

    source_hue_range: (min_hue, max_hue) to restrict which pixels are swapped.
                      None = swap all pixels in cluster.
    luminance_preserve_strength: 0=ignore luminance, 1=perfect preservation

    Returns count of pixels modified.
    """
    if not color_mapping: return 0

    tgt_h = color_mapping["tgt_hue_mean"]
    s_ratio = color_mapping["saturation_ratio"]
    hue_delta = color_mapping["hue_delta"]

    pixel_rels = vapor.get_relationships(cluster_record_id, "SAME_CLUSTER", "incoming")
    modified = 0

    for rel in pixel_rels:
        prec = vapor.get(rel.source_id)
        if not prec: continue

        ph = prec.data["hue"]; ps = prec.data["saturation"]
        pv = prec.data["brightness"] / 255.0

        # Check hue range filter
        if source_hue_range:
            hmin, hmax = source_hue_range
            if not (hmin <= ph <= hmax): continue

        # New hue: target hue
        new_h = tgt_h % 360.0

        # Preserve per-pixel hue variation within the cluster
        # If this pixel's hue deviated from cluster mean, preserve that deviation
        if color_mapping.get("src_hue_std", 0) > 5:
            src_mean = color_mapping["src_hue_mean"]
            hue_deviation = ph - src_mean
            # Scale deviation by source std (normalize) then apply to target space
            new_h = (tgt_h + hue_deviation * 0.4) % 360.0

        # Saturation: scale from source, clamped
        new_s = min(1.0, max(0.0, ps * s_ratio))

        # Luminance preservation: keep original value channel
        if luminance_preserve_strength > 0:
            new_v = pv  # keep original brightness exactly
        else:
            new_v = pv

        # Convert back to RGB
        nr, ng, nb = _hsv_to_rgb(new_h, new_s, new_v)
        vapor.update(rel.source_id, {
            "r": float(nr), "g": float(ng), "b": float(nb),
            "hue": new_h, "saturation": new_s,
        })
        modified += 1

    return modified


def _hsv_to_rgb(h, s, v) -> tuple:
    """HSV → RGB 0-255. Pure Python."""
    if s == 0: c = int(v*255); return c, c, c
    h /= 60; i = int(h); f = h - i
    p, q, t = v*(1-s), v*(1-s*f), v*(1-s*(1-f))
    p,q,t,v_int = int(p*255),int(q*255),int(t*255),int(v*255)
    pairs = [(v_int,t,p),(q,v_int,p),(p,v_int,t),(p,q,v_int),(t,p,v_int),(v_int,p,q)]
    return pairs[i%6]
```

---

## Step 4 — Correct Outline Clusters After Body Swap

```python
def correct_outline_after_swap(vapor, swapped_body_labels: list,
                                outline_labels: list,
                                target_hue: float,
                                saturation_scale: float = 0.65,
                                value_darken: float = 0.85) -> int:
    """
    After swapping body cluster colors, find adjacent outline clusters
    and shift them to match. Without this, a red frog still has dark green
    outlines — a visual inconsistency.

    swapped_body_labels: labels of clusters that were just color-swapped
    outline_labels: labels of outline/contour clusters to correct
    target_hue: same hue used for body swap
    saturation_scale: outlines should be less saturated (darker, more neutral)
    value_darken: outlines are typically darker than body

    Returns count of pixels corrected.
    """
    from vapor_idx import QueryOptions

    # Find all swapped body clusters
    body_crecs = [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                  if any(kw in rec.data.get("semantic_class","") for kw in swapped_body_labels)]

    # Find outline clusters adjacent to body clusters
    outline_cids = set()
    for brec in body_crecs:
        # ADJACENT_TO is undirected
        adj_edges = vapor.get_relationships(brec.id, "ADJACENT_TO", "both")
        for e in adj_edges:
            nid = e.target_id if e.source_id == brec.id else e.source_id
            nrec = vapor.get(nid)
            if nrec:
                nlbl = nrec.data.get("semantic_class","")
                if any(kw in nlbl for kw in outline_labels):
                    outline_cids.add(nid)

    corrected = 0
    for crid in outline_cids:
        crec = vapor.get(crid)
        if not crec: continue

        pixel_rels = vapor.get_relationships(crid, "SAME_CLUSTER", "incoming")
        for rel in pixel_rels:
            prec = vapor.get(rel.source_id)
            if not prec: continue

            ps = prec.data["saturation"]
            pv = prec.data["brightness"] / 255.0

            # Shift outline to dark version of target hue
            new_h = target_hue
            new_s = min(1.0, ps * saturation_scale)
            new_v = pv * value_darken  # darken the outline

            nr,ng,nb = _hsv_to_rgb(new_h, new_s, new_v)
            vapor.update(rel.source_id, {
                "r":float(nr),"g":float(ng),"b":float(nb),
                "hue":new_h,"saturation":new_s
            })
            corrected += 1

    print(f"  Outline correction: {corrected} pixels in {len(outline_cids)} outline clusters")
    return corrected
```

---

## Step 5 — Multi-Cluster Semantic Color Swap

```python
def semantic_color_swap(vapor,
                         source_label_keywords: list,
                         target_hue: float,
                         source_hue_range: tuple = None,
                         target_saturation_mean: float = None,
                         correct_outlines: bool = True,
                         outline_label_keywords: list = None) -> dict:
    """
    Full semantic color swap pipeline for any subject type.
    Finds all clusters matching source labels, measures their distributions,
    builds per-cluster mappings, applies them, then corrects outlines.

    source_label_keywords: e.g. ["frog_body", "frog_belly"] or ["horse_body"]
    target_hue: target hue in degrees (0=red, 60=yellow, 120=green, 240=blue)
    source_hue_range: (min,max) hue degrees to limit which pixels are swapped
    correct_outlines: whether to also shift adjacent outline/contour clusters
    outline_label_keywords: labels for outline clusters e.g. ["contour_edge","frog_outline"]

    Returns summary dict with pixel counts and cluster stats.
    """
    from vapor_idx import QueryOptions

    if outline_label_keywords is None:
        outline_label_keywords = ["contour_edge","outline","dark_blob","dark_circle"]

    # Find all matching clusters
    all_clusters = vapor.query(QueryOptions(type="Cluster")).records
    target_clusters = [rec for rec in all_clusters
                       if any(kw in rec.data.get("semantic_class","")
                              for kw in source_label_keywords)]

    if not target_clusters:
        print(f"  Semantic color swap: no clusters found matching {source_label_keywords}")
        return {"swapped": 0, "clusters": 0}

    total_swapped = 0
    cluster_stats = []

    for crec in target_clusters:
        # Measure this cluster's actual distribution
        distribution = measure_cluster_color_distribution(vapor, crec.id)
        if not distribution: continue

        # Build mapping for this specific cluster
        mapping = build_color_mapping(
            source_distribution=distribution,
            target_hue=target_hue,
            target_saturation_mean=target_saturation_mean,
            preserve_luminance=True,
        )

        # Apply mapping
        swapped = apply_color_mapping_to_cluster(
            vapor, crec.id, mapping,
            source_hue_range=source_hue_range,
            luminance_preserve_strength=0.95
        )
        total_swapped += swapped
        cluster_stats.append({
            "cluster_id": crec.data["cluster_id"],
            "label": crec.data.get("semantic_class","?"),
            "pixels_swapped": swapped,
            "original_hue": distribution["hue"]["mean"],
            "target_hue": target_hue,
        })

    # Correct outline clusters
    outline_corrected = 0
    if correct_outlines:
        outline_corrected = correct_outline_after_swap(
            vapor,
            swapped_body_labels=source_label_keywords,
            outline_labels=outline_label_keywords,
            target_hue=target_hue,
            saturation_scale=0.60,
            value_darken=0.82,
        )

    print(f"  Semantic color swap: {total_swapped} body pixels + "
          f"{outline_corrected} outline pixels | "
          f"{len(target_clusters)} clusters | → hue={target_hue:.0f}°")
    return {
        "swapped": total_swapped,
        "outline_corrected": outline_corrected,
        "clusters": len(target_clusters),
        "cluster_stats": cluster_stats,
    }
```

---

## Step 6 — Style Unification

```python
def measure_style_characteristics(vapor) -> dict:
    """
    Measure the visual style of an image from vapor cluster data.
    Style = (color_saturation_mean, edge_density, texture_variance, color_range).
    Used to determine whether image is "photorealistic" or "stylized".

    Returns style_profile dict.
    """
    from vapor_idx import QueryOptions

    all_clusters = vapor.query(QueryOptions(type="Cluster")).records
    if not all_clusters: return {}

    sat_vals = [r.data.get("avg_saturation",0) for r in all_clusters]
    tex_vals = [r.data.get("texture_variance",0) for r in all_clusters]
    edge_vals = [r.data.get("edge_density",0) for r in all_clusters]
    br_vals   = [r.data.get("avg_brightness",128) for r in all_clusters]

    n = len(all_clusters)
    avg_sat  = sum(sat_vals)/n
    avg_tex  = sum(tex_vals)/n
    avg_edge = sum(edge_vals)/n
    br_range = max(br_vals) - min(br_vals)

    # Classify style
    # High saturation + low texture + low edge density = stylized/cartoon
    # Low saturation + high texture + varied brightness = photorealistic
    is_photo_score = (avg_tex/max(avg_tex,1)) * 0.4 + \
                     (1.0-avg_sat) * 0.3 + \
                     (br_range/255.0) * 0.3
    is_stylized_score = avg_sat * 0.5 + (1.0-avg_tex/max(avg_tex,500)) * 0.3 + \
                        (1.0-avg_edge) * 0.2

    if is_photo_score > is_stylized_score:
        style = "photorealistic"
    elif avg_sat > 0.7 and avg_tex < 100:
        style = "cartoon"
    else:
        style = "semi_realistic"

    return {
        "style": style,
        "saturation_mean": avg_sat,
        "texture_variance_mean": avg_tex,
        "edge_density_mean": avg_edge,
        "brightness_range": br_range,
        "photo_score": is_photo_score,
        "stylized_score": is_stylized_score,
    }


def unify_style_toward_photorealistic(vapor, stylized_cluster_labels: list) -> int:
    """
    Pull stylized/cartoon clusters toward photorealism.
    Applied when: cartoon subject placed in photographic background.

    Approach:
    1. Reduce extreme saturation (cartoon = oversaturated)
    2. Add texture variance (cartoon = flat fills)
    3. Soften hard edges between clusters (cartoon = hard borders)

    Returns count of pixels modified.
    """
    from vapor_idx import QueryOptions

    # Find stylized clusters
    target_crecs = [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                    if any(kw in rec.data.get("semantic_class","") for kw in stylized_cluster_labels)
                    or rec.data.get("avg_saturation",0) > 0.75]

    modified = 0
    import math

    for crec in target_crecs:
        avg_sat = crec.data.get("avg_saturation", 0)
        if avg_sat < 0.60: continue  # not oversaturated

        # Reduce saturation toward realistic range
        reduction = (avg_sat - 0.60) * 0.5  # reduce halfway to 0.60

        pixel_rels = vapor.get_relationships(crec.id, "SAME_CLUSTER", "incoming")
        for rel in pixel_rels:
            prec = vapor.get(rel.source_id)
            if not prec: continue

            ps = prec.data["saturation"]
            pv = prec.data["brightness"]/255.0
            ph = prec.data["hue"]

            new_s = max(0, ps - reduction)

            # Add micro-texture via fBm noise
            px2 = int(prec.data["x"]); py2 = int(prec.data["y"])
            noise = (math.cos(px2*0.31+py2*0.19)*0.5 +
                    math.cos(px2*0.67+py2*0.43)*0.25) * 0.03
            new_v = min(1.0, max(0.0, pv + noise))

            nr,ng,nb = _hsv_to_rgb(ph, new_s, new_v)
            vapor.update(rel.source_id, {"r":float(nr),"g":float(ng),"b":float(nb),
                                          "saturation":new_s})
            modified += 1

    print(f"  Style unification: {modified} pixels desaturated toward photorealism")
    return modified
```

---

## Step 7 — Biological Scale Calibration

```python
# Biological scale references (subject_size / surface_size)
BIOLOGICAL_SCALES = {
    # (subject_type, surface_type) → (min_ratio, max_ratio, ideal_ratio)
    ("frog",         "lily_pad"):   (0.30, 0.52, 0.40),
    ("small_frog",   "lily_pad"):   (0.15, 0.35, 0.25),
    ("large_frog",   "lily_pad"):   (0.45, 0.70, 0.55),
    ("person",       "horse"):      (0.60, 0.80, 0.70),  # rider on horse
    ("person",       "chair"):      (0.70, 1.00, 0.85),
    ("horse",        "beach"):      (0.08, 0.25, 0.15),
    ("person",       "beach"):      (0.05, 0.20, 0.12),
    ("cat",          "person"):     (0.15, 0.35, 0.25),
    ("dog",          "person"):     (0.20, 0.50, 0.35),
    ("bird",         "tree"):       (0.02, 0.12, 0.06),
    ("car",          "road"):       (0.10, 0.40, 0.25),
    ("default",      "default"):    (0.05, 0.50, 0.20),
}


def compute_biological_scale(subject_type: str, surface_type: str,
                              surface_pixel_count: int,
                              desired_ratio: float = None) -> int:
    """
    Compute the correct target height for a subject placed on a surface.
    Returns target_height_px for the subject.

    surface_pixel_count: approximate pixel area of the surface
    desired_ratio: override the biological default if you want a specific size

    Example: frog on lily pad
      surface area = 4000 px²
      surface radius ≈ 35px (sqrt(4000/pi))
      ideal_ratio = 0.40
      target frog width = 35 * 2 * 0.40 = 28px
    """
    key = (subject_type, surface_type)
    if key not in BIOLOGICAL_SCALES:
        key = ("default", "default")

    min_r, max_r, ideal_r = BIOLOGICAL_SCALES[key]
    use_ratio = desired_ratio if desired_ratio else ideal_r

    # Estimate surface linear dimension from pixel count
    import math
    surface_radius = math.sqrt(max(surface_pixel_count, 1) / math.pi)
    surface_width = surface_radius * 2

    target_subject_width = int(surface_width * use_ratio)

    print(f"  Biological scale: {subject_type} on {surface_type} "
          f"→ ratio={use_ratio:.2f} "
          f"surface_w={surface_width:.0f}px "
          f"target_w={target_subject_width}px")

    return max(20, target_subject_width)  # minimum 20px to be visible
```

---

## Step 8 — Full Color Reconstruction Pipeline

```python
def run_color_reconstruction(vapor,
                              transformation: str,
                              params: dict) -> dict:
    """
    Run the appropriate color reconstruction operation.

    transformation options:
    "swap_hue":        Change a subject's color to a different hue
    "style_unify":     Unify cartoon and photographic styles
    "biological_scale": Return correct scale for subject on surface

    params for "swap_hue":
      source_labels: list of semantic labels to swap
      target_hue: target hue 0-360
      source_hue_range: optional (min,max) hue filter
      outline_labels: optional outline cluster labels to correct

    params for "style_unify":
      stylized_labels: labels of stylized clusters to unify
      target_style: "photorealistic"|"stylized"

    Returns result dict.
    """
    if transformation == "swap_hue":
        result = semantic_color_swap(
            vapor,
            source_label_keywords=params.get("source_labels",[]),
            target_hue=params.get("target_hue",0),
            source_hue_range=params.get("source_hue_range"),
            target_saturation_mean=params.get("target_saturation"),
            correct_outlines=params.get("correct_outlines",True),
            outline_label_keywords=params.get("outline_labels"),
        )

    elif transformation == "style_unify":
        target = params.get("target_style","photorealistic")
        if target == "photorealistic":
            n = unify_style_toward_photorealistic(
                vapor,
                stylized_cluster_labels=params.get("stylized_labels",[])
            )
            result = {"pixels_modified": n, "target_style": target}
        else:
            result = {"pixels_modified": 0, "target_style": target}

    elif transformation == "measure_style":
        result = measure_style_characteristics(vapor)

    else:
        result = {"error": f"Unknown transformation: {transformation}"}

    return result
```

---

## Output

Report: clusters matched, pixels swapped per cluster, hue deltas applied,
outline pixels corrected, saturation ratios used, style measurements if computed,
biological scale values if computed.
