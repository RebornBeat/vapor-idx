---
name: Material Engine
description: Reconstruct realistic surface materials at cluster level using spatially-correlated texture synthesis, PBR material application, wet surface effects, ground reflections, footprint displacement, and biological scale calibration. All operations at cluster or sub-cluster level — no full-image filters. Works for any subject type in any environment. Pure Python, no external libraries.
version: 1.0.0
tools:
  - computer_use
---

# Material Engine Skill v1.0

## Purpose

After a subject is semantically analyzed and placed in an environment, this skill
reconstructs the surface materials to achieve photorealism. It replaces flat/
uniform cluster regions with physically plausible textures derived from reference
data, applies PBR material properties, and generates ground-plane interactions.

**The core rule:** Never replace a cluster's pixel data with a single flat color.
Always synthesize texture using spatially-correlated noise so the material looks
photographed, not painted.

## CRITICAL: vapor-idx API

```
vapor.get_relationships(id, rel_type, direction)  ← correct
vapor.getRelationships(...)  ← DOES NOT EXIST
```

## When to Trigger

- Subject's colors look flat/plastic after compositing
- Surface interaction needed (footprints, displacement, reflections)
- Texture mismatch between subject and environment
- Material-specific effects: wetness, metallic sheen, organic translucency
- After lighting-engine has been applied

---

## Step 1 — Spatially-Correlated Texture Synthesis

```python
import math

def synthesize_texture_fbm(width: int, height: int,
                            base_color: tuple,
                            texture_variance: float,
                            roughness_class: str = "matte",
                            grain_scale: float = 1.0,
                            seed_x: int = 0, seed_y: int = 0) -> list:
    """
    Synthesize a texture tile using fractional Brownian motion.
    Uses layered cosine waves at multiple frequencies — no hash noise.
    Produces spatially-correlated variation that looks like real surface grain.

    base_color: (r, g, b) dominant color
    texture_variance: how much variation (from extract_material_properties)
    roughness_class: 'mirror'|'glossy'|'satin'|'matte'|'rough'
    grain_scale: 1.0=normal grain, 0.5=fine, 2.0=coarse

    Returns pixels[y][x] = (r,g,b)
    """
    # Variance amplitude by roughness class
    amplitude_map = {
        "mirror": 0.002, "glossy": 0.012, "satin": 0.025,
        "matte": 0.055, "rough": 0.12
    }
    amp = amplitude_map.get(roughness_class, 0.055)
    # Scale by measured texture variance (0-10000 typical range)
    amp *= min(2.0, max(0.1, texture_variance / 400.0))

    br, bg, bb = base_color

    pixels = []
    for y in range(height):
        row = []
        for x in range(width):
            # Fractional Brownian motion: 4 octaves
            wx = (x + seed_x) * grain_scale
            wy = (y + seed_y) * grain_scale

            n  = math.cos(wx*0.12 + wy*0.07) * 0.5
            n += math.cos(wx*0.31 + wy*0.19) * 0.25
            n += math.cos(wx*0.67 + wy*0.43) * 0.125
            n += math.cos(wx*1.53 + wy*0.97) * 0.0625
            # Add cross-frequency grain
            n += math.sin(wx*0.08 - wy*0.11) * 0.15
            n += math.cos(wx*0.44 + wy*0.29) * 0.08

            # Map to color variation
            factor = 1.0 + n * amp

            r = max(0, min(255, int(br * factor)))
            g = max(0, min(255, int(bg * factor)))
            b = max(0, min(255, int(bb * factor)))
            row.append((r, g, b))
        pixels.append(row)

    return pixels


def synthesize_wood_grain(width: int, height: int,
                           base_color: tuple = (139,90,43),
                           ring_frequency: float = 0.12,
                           grain_angle_deg: float = 5.0) -> list:
    """
    Synthesize wood grain texture.
    Uses radial ring pattern + longitudinal grain lines.
    """
    br, bg, bb = base_color
    angle_rad = math.radians(grain_angle_deg)
    cos_a = math.cos(angle_rad); sin_a = math.sin(angle_rad)

    pixels = []
    for y in range(height):
        row = []
        for x in range(width):
            # Rotate coordinates for grain angle
            rx = x*cos_a - y*sin_a; ry = x*sin_a + y*cos_a

            # Ring pattern (concentric rings)
            ring = math.sin(rx * ring_frequency * math.pi) * 0.5 + 0.5
            # Grain lines (longitudinal)
            grain = math.cos(ry * 0.08 + rx * 0.02) * 0.3
            # Knot perturbation
            knot_dist = ((rx-width/3)**2 + (ry-height/3)**2)**0.5
            knot = math.exp(-knot_dist*0.02) * 0.2

            factor = 0.7 + ring*0.2 + grain*0.1 + knot*0.15
            r = max(0, min(255, int(br * factor + 15*ring)))
            g = max(0, min(255, int(bg * factor)))
            b = max(0, min(255, int(bb * factor)))
            row.append((r, g, b))
        pixels.append(row)
    return pixels


def synthesize_water_surface(width: int, height: int,
                              base_color: tuple = (80,120,160),
                              wave_scale: float = 1.0,
                              roughness: float = 0.3) -> list:
    """
    Synthesize water surface texture with wave interference patterns.
    """
    br, bg, bb = base_color
    pixels = []
    for y in range(height):
        row = []
        for x in range(width):
            # Primary waves
            w1 = math.sin(x*0.15*wave_scale + y*0.08*wave_scale) * 0.5
            # Secondary crossing waves
            w2 = math.sin(x*0.07*wave_scale - y*0.12*wave_scale) * 0.3
            # Ripple interference
            w3 = math.cos((x+y)*0.09*wave_scale) * 0.2
            # Small chop
            w4 = math.sin(x*0.31*wave_scale + y*0.27*wave_scale) * roughness * 0.15

            highlight = max(0, (w1+w2+w3+w4)) * 0.3

            r = max(0, min(255, int(br + highlight*60)))
            g = max(0, min(255, int(bg + highlight*40)))
            b = max(0, min(255, int(bb + highlight*20)))
            row.append((r, g, b))
        pixels.append(row)
    return pixels


def synthesize_sand_texture(width: int, height: int,
                             base_color: tuple = (180,155,115),
                             is_wet: bool = False) -> list:
    """
    Synthesize sand texture with grain and ripple marks.
    """
    br, bg, bb = base_color
    if is_wet:
        br = int(br*0.72); bg = int(bg*0.72); bb = int(bb*0.72)

    pixels = []
    for y in range(height):
        row = []
        for x in range(width):
            # Grain noise (fine scale)
            grain = (math.cos(x*0.67+y*0.43) * 0.5 +
                    math.cos(x*1.53+y*0.97) * 0.25 +
                    math.cos(x*0.23+y*1.11) * 0.125)

            # Ripple marks (coarse scale, horizontal)
            ripple = math.sin(y*0.18 + x*0.02) * 0.12

            # Wet darkening at troughs
            wet_factor = 1.0 - max(0, -ripple)*0.4 if is_wet else 1.0

            factor = (1.0 + grain*0.06 + ripple*0.04) * wet_factor
            r = max(0, min(255, int(br * factor)))
            g = max(0, min(255, int(bg * factor)))
            b = max(0, min(255, int(bb * factor)))
            row.append((r,g,b))
        pixels.append(row)
    return pixels
```

---

## Step 2 — Apply Texture to Cluster Pixels

```python
def apply_texture_to_cluster(vapor, cluster_record_id: str,
                              texture_pixels: list,
                              texture_tile_w: int,
                              texture_tile_h: int,
                              blend_with_original: float = 0.6) -> int:
    """
    Apply a synthesized texture to all pixels in a cluster.
    Tiles the texture across the cluster's bounding box.
    Blends with original pixel color to preserve structure.

    blend_with_original: 0.0=full texture, 1.0=original only, 0.6=mostly texture
    Returns count of pixels updated.
    """
    from vapor_idx import QueryOptions, FieldFilter

    crec = vapor.get(cluster_record_id)
    if not crec: return 0
    cid = crec.data["cluster_id"]
    min_x = int(crec.data["min_x"]); min_y = int(crec.data["min_y"])

    # Get all pixels in this cluster via incoming SAME_CLUSTER edges
    pixel_rels = vapor.get_relationships(cluster_record_id, "SAME_CLUSTER", "incoming")

    updated = 0
    for rel in pixel_rels:
        prec = vapor.get(rel.source_id)
        if not prec: continue

        px = int(prec.data["x"]); py = int(prec.data["y"])

        # Tile texture coordinates
        tx = (px - min_x) % texture_tile_w
        ty = (py - min_y) % texture_tile_h

        if ty >= len(texture_pixels) or tx >= len(texture_pixels[0]):
            continue

        tr, tg, tb = texture_pixels[ty][tx]
        or2, og, ob = prec.data["r"], prec.data["g"], prec.data["b"]

        # Blend: take texture structure but keep original color tone
        nr = max(0,min(255,int(tr*(1-blend_with_original) + or2*blend_with_original)))
        ng = max(0,min(255,int(tg*(1-blend_with_original) + og*blend_with_original)))
        nb = max(0,min(255,int(tb*(1-blend_with_original) + ob*blend_with_original)))

        vapor.update(rel.source_id, {"r":float(nr),"g":float(ng),"b":float(nb)})
        updated += 1

    return updated


def apply_material_by_class(vapor, cluster_ids: dict,
                             material_map: dict = None,
                             scene_props: dict = None) -> dict:
    """
    Apply appropriate texture synthesis to every cluster based on semantic class.
    material_map: optional dict cluster_id → material_class override.
                  If None, inferred from semantic_class.

    Returns stats dict: {material_class: pixel_count}
    """
    from vapor_idx import QueryOptions

    SEMANTIC_TO_MATERIAL = {
        "sand_surface": "sand_dry", "sandy_region": "sand_dry",
        "wet_surface": "sand_wet", "wet_sand": "sand_wet",
        "water_surface": "water", "water_region": "water",
        "water_ripple": "water",
        "skin_region": "skin", "large_skin_oval": "skin",
        "arm_segment": "skin", "vertical_skin_strip": "skin",
        "horse_body": "horse_coat", "horse_coat": "horse_coat",
        "horse_mane": "hair",
        "frog_body_green": "frog_skin", "frog_body_dark": "frog_skin",
        "frog_belly": "frog_skin",
        "lily_pad_green": "lily_pad",
        "dark_clothing": "clothing_matte", "torso_region": "clothing_matte",
        "jeans_region": "denim",
        "wood_surface": "wood",
        "sky_region": None,  # skip sky
        "white_background": None,  # skip
    }

    MATERIAL_TEXTURE_PARAMS = {
        "sand_dry":       {"roughness_class":"rough",  "variance":600},
        "sand_wet":       {"roughness_class":"satin",  "variance":350, "is_wet":True},
        "water":          {"roughness_class":"glossy", "variance":200},
        "skin":           {"roughness_class":"satin",  "variance":120},
        "horse_coat":     {"roughness_class":"satin",  "variance":180},
        "frog_skin":      {"roughness_class":"glossy", "variance":80},
        "lily_pad":       {"roughness_class":"satin",  "variance":250},
        "hair":           {"roughness_class":"matte",  "variance":300},
        "clothing_matte": {"roughness_class":"matte",  "variance":400},
        "denim":          {"roughness_class":"matte",  "variance":500},
        "wood":           {"roughness_class":"matte",  "variance":450},
        "horse_mane":     {"roughness_class":"rough",  "variance":350},
    }

    stats = {}
    all_clusters = vapor.query(QueryOptions(type="Cluster"))

    for rec in all_clusters.records:
        cid = rec.data["cluster_id"]
        lbl = rec.data.get("semantic_class","")

        # Determine material class
        mat = None
        if material_map and cid in material_map:
            mat = material_map[cid]
        else:
            for key,val in SEMANTIC_TO_MATERIAL.items():
                if key in lbl: mat = val; break

        if mat is None: continue

        params = MATERIAL_TEXTURE_PARAMS.get(mat, {"roughness_class":"matte","variance":300})
        base_col = (int(rec.data["avg_r"]),int(rec.data["avg_g"]),int(rec.data["avg_b"]))
        tw = max(32, int(rec.data["width_span"]))
        th = max(32, int(rec.data["height_span"]))
        tw = min(tw, 128); th = min(th, 128)

        # Synthesize appropriate texture
        if mat == "water":
            tex = synthesize_water_surface(tw, th, base_col,
                  roughness=params.get("variance",200)/1000.0)
        elif "sand" in mat:
            tex = synthesize_sand_texture(tw, th, base_col,
                  is_wet=params.get("is_wet",False))
        elif mat == "wood":
            tex = synthesize_wood_grain(tw, th, base_col)
        else:
            tex = synthesize_texture_fbm(tw, th, base_col,
                  texture_variance=params.get("variance",300),
                  roughness_class=params.get("roughness_class","matte"),
                  seed_x=int(rec.data["center_x"]),
                  seed_y=int(rec.data["center_y"]))

        updated = apply_texture_to_cluster(vapor, rec.id, tex, tw, th,
                                           blend_with_original=0.45)
        stats[mat] = stats.get(mat,0) + updated

    print(f"  Materials applied: {stats}")
    return stats
```

---

## Step 3 — Wet Surface Effects

```python
def apply_wet_surface_effect(vapor, wet_cluster_ids: list,
                              wetness: float = 0.7) -> int:
    """
    Make clusters look wet: darken, increase specularity (handled by specular pass),
    desaturate slightly, add micro-sheen.

    wetness: 0.0=dry, 1.0=soaked
    Returns pixel count updated.
    """
    from vapor_idx import QueryOptions

    updated = 0
    for crid in wet_cluster_ids:
        crec = vapor.get(crid)
        if not crec: continue

        # Update cluster metadata for wetness
        vapor.update(crid, {"reflectivity": min(1.0, crec.data.get("reflectivity",0) + wetness*0.4)})

        # Apply to pixels
        pixel_rels = vapor.get_relationships(crid, "SAME_CLUSTER", "incoming")
        for rel in pixel_rels:
            prec = vapor.get(rel.source_id)
            if not prec: continue
            r,g,b = prec.data["r"],prec.data["g"],prec.data["b"]

            # Darken (water absorption)
            dark_f = 1.0 - wetness*0.28
            # Slight blue shift (water color contribution)
            nr = max(0,min(255,int(r*dark_f)))
            ng = max(0,min(255,int(g*dark_f)))
            nb = max(0,min(255,int(b*dark_f + wetness*8)))
            vapor.update(rel.source_id, {"r":float(nr),"g":float(ng),"b":float(nb)})
            updated += 1

    print(f"  Wet surface: {updated} pixels at wetness={wetness:.2f}")
    return updated


def apply_dry_to_wet_gradient(canvas: list, BW: int, BH: int,
                               wet_start_y: int, dry_start_y: int,
                               scene_props: dict) -> None:
    """
    Apply gradual wet→dry transition on sand/ground surface.
    Wet near water line, dry further from it.
    Operates on canvas array directly.
    """
    sr,sg,sb = scene_props.get("surface_color", scene_props.get("sand_color",(180,155,115)))

    for y in range(wet_start_y, dry_start_y):
        # 0=wet at top, 1=dry at bottom
        dry_t = (y-wet_start_y) / max(dry_start_y-wet_start_y, 1)
        wet_t = 1.0 - dry_t

        for x in range(BW):
            px = canvas[y][x]
            # Wet darkening
            dark_f = 1.0 - wet_t*0.25
            nb = max(0,min(255,int(px[2]*dark_f + wet_t*8)))
            nr = max(0,min(255,int(px[0]*dark_f)))
            ng = max(0,min(255,int(px[1]*dark_f)))
            canvas[y][x] = [nr,ng,nb,255]
```

---

## Step 4 — PBR Material Application

```python
def apply_pbr_material(fg_mask: dict, scene_props: dict,
                        pbr_params: dict) -> dict:
    """
    Apply physically-based rendering material model to a subject mask.
    Combines diffuse, metallic reflection, and roughness-based variation.

    pbr_params = {
        'roughness': 0.0-1.0,    # 0=mirror, 1=fully diffuse
        'metallic': 0.0-1.0,     # 0=dielectric, 1=conductor
        'base_color': (r,g,b),   # override color (None to use existing)
        'specular': 0.0-1.0,     # specular intensity
    }

    Based on Cook-Torrance BRDF approximation in pure Python.
    """
    roughness = pbr_params.get("roughness", 0.5)
    metallic  = pbr_params.get("metallic", 0.0)
    specular  = pbr_params.get("specular", 0.5)
    override_color = pbr_params.get("base_color", None)

    sr,sg,sb = scene_props.get("sun_color",(255,200,120))
    lr = scene_props.get("light_from_right", True)

    xs = [x for (x,y) in fg_mask]
    x_center = sum(xs)/len(xs) if xs else 0
    x_range  = max(xs)-min(xs) if xs else 1

    updated = {}
    for (px,py),(r,g,b,a) in fg_mask.items():
        if override_color:
            r,g,b = override_color

        rel_x = (px-x_center)/x_range
        facing_light = (lr and rel_x > 0) or (not lr and rel_x < 0)
        NdotL = abs(rel_x) * (1.0 if facing_light else 0.15)

        # Diffuse component
        diff = NdotL * (1.0 - metallic)

        # Specular component (Schlick approximation)
        if roughness < 0.5:
            spec_exp = int(2.0 / max(roughness, 0.01))
            spec = (NdotL ** spec_exp) * specular * (1.0 - roughness)
        else:
            spec = 0.0

        # Metallic tint: metallic surfaces reflect sun color
        if metallic > 0.5:
            m_r = r*(1-metallic) + sr*metallic
            m_g = g*(1-metallic) + sg*metallic
            m_b = b*(1-metallic) + sb*metallic
        else:
            m_r,m_g,m_b = r,g,b

        # Combine
        diffuse_strength = 0.15 * diff
        final_r = max(0,min(255,int(m_r*(1+diffuse_strength) + (sr-m_r)*spec)))
        final_g = max(0,min(255,int(m_g*(1+diffuse_strength) + (sg-m_g)*spec)))
        final_b = max(0,min(255,int(m_b*(1+diffuse_strength) + (sb-m_b)*spec)))

        updated[(px,py)] = (final_r,final_g,final_b,a)

    return updated
```

---

## Step 5 — Footprint Displacement

```python
def generate_footprint_displacement(canvas: list, BW: int, BH: int,
                                     feet_positions: list,
                                     foot_radius: int,
                                     scene_props: dict,
                                     displacement_depth: float = 0.15,
                                     surface_type: str = "sand") -> None:
    """
    Generate surface displacement where subject feet/base contacts surface.
    Creates physically correct contact impression.

    feet_positions: list of (x, y) pixel positions of each contact point
    foot_radius: radius of each foot in pixels
    displacement_depth: how deep the impression goes (0.05-0.25)
    surface_type: "sand"|"mud"|"snow"|"grass"|"lily_pad"

    Different surface types respond differently:
    - sand: darker + slightly raised rim
    - mud: darker + concave center
    - lily_pad: slight green darkening, no rim
    - snow: darker + compressed flat center
    """
    sr,sg,sb = scene_props.get("surface_color", scene_props.get("sand_color",(180,155,115)))
    shadow_r = int(sr*0.6); shadow_g = int(sg*0.5); shadow_b = int(sb*0.45)

    for (fx,fy) in feet_positions:
        for dy in range(-foot_radius*2, foot_radius*2+1):
            for dx in range(-foot_radius*2, foot_radius*2+1):
                px = fx+dx; py = fy+dy
                if not (0<=px<BW and 0<=py<BH): continue

                dist = (dx**2+dy**2)**0.5
                if dist > foot_radius: continue

                # Normalized 0=edge 1=center
                t = 1.0 - dist/foot_radius

                bg = canvas[py][px]

                if surface_type in ("sand", "mud"):
                    # Center: darkened impression
                    center_dark = t * displacement_depth * 0.8
                    # Rim: slight brightness ring at edge
                    rim = max(0, 0.5-t) * displacement_depth * 0.3
                    factor = 1.0 - center_dark + rim

                    canvas[py][px] = [
                        max(0,min(255,int(bg[0]*factor))),
                        max(0,min(255,int(bg[1]*factor))),
                        max(0,min(255,int(bg[2]*factor))),
                        255
                    ]

                elif surface_type == "lily_pad":
                    # Slight darkening without rim
                    dark = t * displacement_depth * 0.5
                    factor = 1.0 - dark
                    canvas[py][px] = [
                        max(0,min(255,int(bg[0]*factor))),
                        max(0,min(255,int(bg[1]*factor))),
                        max(0,min(255,int(bg[2]*factor))),
                        255
                    ]

                elif surface_type == "snow":
                    # Compression: flat center, slightly raised compressed rim
                    compression = t * displacement_depth * 0.6
                    canvas[py][px] = [
                        max(0,min(255,int(bg[0]*(1-compression)+200*compression))),
                        max(0,min(255,int(bg[1]*(1-compression)+210*compression))),
                        max(0,min(255,int(bg[2]*(1-compression)+220*compression))),
                        255
                    ]
```

---

## Step 6 — Water Ripple Physics

```python
def generate_water_ripples(canvas: list, BW: int, BH: int,
                            source_positions: list,
                            water_color: tuple,
                            ripple_count: int = 5,
                            max_amplitude: float = 8.0,
                            wave_speed: float = 1.0) -> None:
    """
    Generate physically-motivated water ripples from contact sources.
    Source positions = where subjects touch the water (feet, lily pad edge, etc.)

    Uses wave decay formula: amplitude = max_amplitude * e^(-dist * decay_rate)
    Interference: multiple sources create realistic crossing patterns.

    NOT geometric concentric ellipses — uses proper wave decay.
    """
    wr,wg,wb = water_color
    decay_rate = 0.008  # how fast waves decay with distance

    for y in range(BH):
        for x in range(BW):
            if not (0<=x<BW and 0<=y<BH): continue
            # Check if this is a water pixel (approximate)
            px = canvas[y][x]
            if px[2] < px[0]: continue  # skip non-water (not blue-dominant)

            # Sum wave contributions from all sources
            total_wave = 0.0
            for (sx,sy) in source_positions:
                dist = ((x-sx)**2 + (y-sy)**2)**0.5
                if dist < 2: continue  # too close to source

                # Wave decay: amplitude drops exponentially
                amp = max_amplitude * math.exp(-dist * decay_rate)

                # Wave phase: creates ring pattern
                phase = dist * 0.25 * wave_speed
                wave = amp * math.sin(phase) * math.cos(phase*0.3)
                total_wave += wave

            # Multiple source interference produces realistic patterns
            if abs(total_wave) > 0.5:
                # Normalize to reasonable range
                wave_n = max(-1.0, min(1.0, total_wave / max_amplitude))
                highlight = max(0, wave_n) * 0.35
                shadow    = max(0, -wave_n) * 0.20

                nr = max(0,min(255,int(px[0]*(1+highlight-shadow*0.3)+highlight*40)))
                ng = max(0,min(255,int(px[1]*(1+highlight-shadow*0.3)+highlight*25)))
                nb = max(0,min(255,int(px[2]*(1+highlight*0.3-shadow)+highlight*15)))
                canvas[y][x] = [nr,ng,nb,255]


def extract_pad_boundary_for_ripples(vapor) -> list:
    """
    Extract the actual lily pad (or any surface) boundary from vapor cluster data
    to use as ripple sources — NOT a procedural geometric center.

    Returns list of (x,y) boundary point coordinates.
    """
    from vapor_idx import QueryOptions

    # Find lily pad clusters
    pad_clusters = [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                    if "lily_pad" in rec.data.get("semantic_class","") or
                       "pad" in rec.data.get("semantic_class","")]

    if not pad_clusters: return []

    # Sample points around pad perimeter
    boundary_points = []
    for crec in pad_clusters:
        # Use cluster boundary: min/max extents at intervals
        min_x = int(crec.data["min_x"]); max_x = int(crec.data["max_x"])
        min_y = int(crec.data["min_y"]); max_y = int(crec.data["max_y"])
        cx = int(crec.data["center_x"]); cy = int(crec.data["center_y"])
        rx = (max_x-min_x)//2; ry = (max_y-min_y)//2

        # Sample 12 points around the perimeter
        for i in range(12):
            angle = i * math.pi / 6
            bx = cx + int(rx*math.cos(angle))
            by = cy + int(ry*math.sin(angle))
            boundary_points.append((bx,by))

    return boundary_points
```

---

## Step 7 — Identity Keypoint Locking

```python
def lock_identity_keypoints(vapor, face_cluster_ids: list,
                              identity_name: str = "subject_A") -> dict:
    """
    Store identity-defining geometric measurements from face clusters.
    These measurements are used to validate that the subject's identity
    is preserved when composited into a new environment.

    Stores: eye distance, jaw width, nose height, forehead height,
    face oval proportions.

    Returns keypoints dict with measurements.
    """
    from vapor_idx import QueryOptions

    face_recs = [vapor.get(cid) for cid in face_cluster_ids if vapor.get(cid)]
    if not face_recs:
        # Fallback: find face cluster from semantic labels
        face_recs = [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                     if "large_skin_oval" in rec.data.get("semantic_class","") or
                        "face" in rec.data.get("semantic_class","")]

    if not face_recs:
        print("  Identity lock: no face clusters found")
        return {}

    # Get face bounding box
    xs_min = min(r.data["min_x"] for r in face_recs)
    xs_max = max(r.data["max_x"] for r in face_recs)
    ys_min = min(r.data["min_y"] for r in face_recs)
    ys_max = max(r.data["max_y"] for r in face_recs)

    face_w = xs_max - xs_min; face_h = ys_max - ys_min
    face_cx = (xs_min+xs_max)/2; face_cy = (ys_min+ys_max)/2

    # Find eye clusters: dark circles in upper face region
    upper_y_thresh = ys_min + face_h * 0.45
    dark_near_face = [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                      if rec.data.get("semantic_class","") in ("dark_circle","bright_circle")
                      and rec.data["center_y"] < upper_y_thresh
                      and rec.data["center_y"] > ys_min]

    eye_distance = None
    if len(dark_near_face) >= 2:
        sorted_by_x = sorted(dark_near_face, key=lambda r: r.data["center_x"])
        left_eye = sorted_by_x[0]; right_eye = sorted_by_x[-1]
        eye_distance = right_eye.data["center_x"] - left_eye.data["center_x"]
        eye_y = (left_eye.data["center_y"] + right_eye.data["center_y"])/2
    else:
        eye_distance = face_w * 0.45  # estimate
        eye_y = ys_min + face_h * 0.38

    keypoints = {
        "identity": identity_name,
        "face_width": face_w,
        "face_height": face_h,
        "face_aspect": face_w/max(face_h,1),
        "face_center": (face_cx, face_cy),
        "eye_distance": eye_distance,
        "eye_to_face_w_ratio": (eye_distance or 0)/max(face_w,1),
        "forehead_frac": 0.35,  # approx
        "jaw_frac": 0.75,       # approx
        "face_bbox": (xs_min,ys_min,xs_max,ys_max),
    }

    print(f"  Identity '{identity_name}' locked: "
          f"face={face_w:.0f}×{face_h:.0f} eye_dist={eye_distance:.0f}")
    return keypoints


def verify_identity_preserved(measured_keypoints: dict,
                               reference_keypoints: dict,
                               tolerance: float = 0.20) -> dict:
    """
    Validate that identity is preserved between source and composite.
    Compares scale-normalized measurements.
    Returns validation report.
    """
    issues = []

    # Compare ratios (scale-invariant)
    if reference_keypoints.get("face_aspect") and measured_keypoints.get("face_aspect"):
        ratio_err = abs(measured_keypoints["face_aspect"] - reference_keypoints["face_aspect"]) \
                    / max(reference_keypoints["face_aspect"], 0.01)
        if ratio_err > tolerance:
            issues.append(f"Face aspect ratio changed by {ratio_err:.0%}")

    if reference_keypoints.get("eye_to_face_w_ratio") and measured_keypoints.get("eye_to_face_w_ratio"):
        ratio_err = abs(measured_keypoints["eye_to_face_w_ratio"] -
                        reference_keypoints["eye_to_face_w_ratio"]) \
                    / max(reference_keypoints["eye_to_face_w_ratio"], 0.01)
        if ratio_err > tolerance:
            issues.append(f"Eye spacing ratio changed by {ratio_err:.0%}")

    score = max(0.0, 1.0 - len(issues)*0.2)
    return {
        "identity": reference_keypoints.get("identity","?"),
        "preserved": len(issues) == 0,
        "score": score,
        "issues": issues
    }
```

---

## Step 8 — Cross-Image Semantic Consistency

```python
def verify_cross_image_consistency(vapor_a, vapor_b,
                                    label_keyword: str) -> dict:
    """
    Verify that the same material appears with similar properties
    in two different vapor instances.

    Example: check that 'water_surface' in the source image
    matches 'water_surface' in the composite output.
    Useful for detecting material drift during compositing.
    """
    from vapor_idx import QueryOptions

    def get_material_stats(vapor, keyword):
        matching = [rec for rec in vapor.query(QueryOptions(type="Cluster")).records
                    if keyword in rec.data.get("semantic_class","")]
        if not matching: return None

        avg_r = sum(r.data["avg_r"] for r in matching)/len(matching)
        avg_g = sum(r.data["avg_g"] for r in matching)/len(matching)
        avg_b = sum(r.data["avg_b"] for r in matching)/len(matching)
        avg_br = sum(r.data["avg_brightness"] for r in matching)/len(matching)
        avg_tex = sum(r.data.get("texture_variance",0) for r in matching)/len(matching)

        return {"avg_color":(avg_r,avg_g,avg_b),"brightness":avg_br,
                "texture_variance":avg_tex,"cluster_count":len(matching)}

    stats_a = get_material_stats(vapor_a, label_keyword)
    stats_b = get_material_stats(vapor_b, label_keyword)

    if not stats_a or not stats_b:
        return {"consistent": False, "reason": "material not found in one or both instances"}

    # Compare
    color_diff = ((stats_a["avg_color"][0]-stats_b["avg_color"][0])**2 +
                  (stats_a["avg_color"][1]-stats_b["avg_color"][1])**2 +
                  (stats_a["avg_color"][2]-stats_b["avg_color"][2])**2)**0.5
    br_diff = abs(stats_a["brightness"]-stats_b["brightness"])
    tex_diff = abs(stats_a["texture_variance"]-stats_b["texture_variance"])

    consistent = color_diff < 30 and br_diff < 25
    score = max(0.0, 1.0 - color_diff/100.0 - br_diff/80.0)

    return {
        "label": label_keyword, "consistent": consistent, "score": score,
        "color_diff": color_diff, "brightness_diff": br_diff,
        "stats_source": stats_a, "stats_composite": stats_b,
    }
```

---

## Step 9 — Full Material Pipeline

```python
def apply_full_material_pipeline(vapor, canvas: list, BW: int, BH: int,
                                  fg_mask: dict,
                                  scene_props: dict,
                                  subject_type: str = "generic",
                                  feet_positions: list = None,
                                  surface_type: str = "sand",
                                  apply_ripples: bool = False) -> dict:
    """
    Apply full material reconstruction pipeline.

    Order:
    1. Synthesize textures for all clusters by material class
    2. Apply wet surface effects if near water zone
    3. Generate footprint displacement at contact points
    4. Water ripples from contact boundary (if applicable)
    5. PBR metallic materials (if subject has metallic elements)

    Returns stats dict.
    """
    print(f"  [MATERIAL] Starting material pipeline | {len(fg_mask)} subject pixels")
    stats = {}

    # 1. Texture synthesis for all labeled clusters
    mat_stats = apply_material_by_class(vapor, {}, material_map=None, scene_props=scene_props)
    stats["textures"] = mat_stats

    # 2. Wet surface on wet_sand / wet_surface clusters
    wet_clusters = [rec.id for rec in vapor.query(
        __import__("vapor_idx").QueryOptions(type="Cluster")).records
                    if "wet" in rec.data.get("semantic_class","")]
    if wet_clusters:
        wet_count = apply_wet_surface_effect(vapor, wet_clusters, wetness=0.65)
        stats["wet_pixels"] = wet_count

    # 3. Footprint displacement
    if feet_positions:
        fr = max(4, int(BW*0.015))  # foot radius proportional to canvas
        generate_footprint_displacement(canvas, BW, BH, feet_positions,
                                        foot_radius=fr, scene_props=scene_props,
                                        displacement_depth=0.12,
                                        surface_type=surface_type)
        stats["footprints"] = len(feet_positions)

    # 4. Ripples from lily pad boundary or any surface contact
    if apply_ripples:
        boundary_pts = extract_pad_boundary_for_ripples(vapor)
        if not boundary_pts and feet_positions:
            boundary_pts = feet_positions
        if boundary_pts:
            wc = scene_props.get("water_color", scene_props.get("secondary_surface",(80,120,160)))
            generate_water_ripples(canvas, BW, BH, boundary_pts, wc,
                                   max_amplitude=6.0, wave_speed=0.8)
            stats["ripple_sources"] = len(boundary_pts)

    print(f"  [MATERIAL] Complete: {stats}")
    return stats
```

---

## Output

Report: material class distribution (which material applied to how many pixels),
wet pixel count, footprint count, ripple source count, texture variance per cluster,
identity keypoints if locked, cross-image consistency scores if validated.
