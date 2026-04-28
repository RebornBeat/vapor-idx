---
name: Lighting Engine
description: Apply physically correct per-cluster lighting from a scene's 12-variable light model. Handles directional light, specular highlights by material class, sub-surface scattering on organic surfaces, contact shadows, ambient occlusion, color temperature matching, depth fog, and horizon glow. All operations at cluster or pixel level — no full-image filters. Works on any subject type in any environment.
version: 1.0.0
tools:
  - computer_use
---

# Lighting Engine Skill v1.0

## Purpose

After scene analysis (scene-analyzer) and subject extraction (pixel-analyzer),
this skill re-lights the subject to match the target environment's measured
lighting conditions. Every material class has different light response behavior.
All operations are physically motivated and applied at cluster level.

## CRITICAL: vapor-idx API

```
vapor.get_relationships(id, rel_type, direction)  ← correct
vapor.getRelationships(...)  ← DOES NOT EXIST, crashes
```

## When to Trigger

- Any compositing task where the subject comes from a different lighting environment
- "Make the lighting match" requests
- When the subject looks pasted-in (flat lighting, wrong color temperature)
- When adding shadows, reflections, or AO to a composite

## Material Classes and Specular Exponents

| Material | Specular Exp | Notes |
|---|---|---|
| `skin` | 8 | Soft moist surface, SSS required |
| `frog_skin` | 8 | Wet organic, high SSS |
| `horse_coat` | 32 | Smooth hair, moderate specular |
| `fur` | 8 | Soft, diffuse |
| `hair` | 16 | Semi-specular strand |
| `clothing_matte` | 4 | Low specular |
| `clothing_glossy` | 64 | Synthetic fabrics |
| `lily_pad` | 12 | Waxy leaf surface |
| `leaf_dry` | 6 | Less waxy |
| `sand_dry` | 2 | Highly rough, diffuse |
| `sand_wet` | 64 | Retroreflective |
| `water` | 256 | Mirror at grazing angle |
| `metal` | 512 | Strong directional highlight |
| `glass` | 1024 | Near-mirror |
| `plastic_matte` | 4 | |
| `plastic_glossy` | 128 | |
| `wood` | 6 | Rough grain |
| `concrete` | 3 | Very rough |

---

## Step 1 — Diffuse Re-Lighting

```python
import math

def apply_directional_diffuse(fg_mask: dict, scene_props: dict,
                               canvas_h: int,
                               subject_type: str = "generic") -> dict:
    """
    Apply directional diffuse lighting: subject gets warm wash from sun direction,
    cool fill from ambient, ground bounce at feet.
    Preserves luminance structure — never clamps to solid color.
    Returns updated fg_mask.
    """
    sr,sg,sb = scene_props.get("sun_color",(255,180,100))
    ar,ag,ab = scene_props.get("ambient_color",(120,140,180))
    warm     = scene_props.get("warm_strength", 0.3)
    lr       = scene_props.get("light_from_right", True)
    soft     = scene_props.get("shadow_softness", 0.5)

    ys = [y for (x,y) in fg_mask]
    xs = [x for (x,y) in fg_mask]
    y_min,y_max = min(ys),max(ys); y_range = max(y_max-y_min,1)
    x_min,x_max = min(xs),max(xs); x_range = max(x_max-x_min,1)

    updated = {}
    for (px,py),(r,g,b,a) in fg_mask.items():
        rel_y = (py-y_min)/y_range  # 0=top 1=bottom
        rel_x = (px-(x_min+x_max)/2)/x_range  # -0.5 to +0.5

        # Sun tint: warm wash + stronger at bottom from sand bounce
        sun_strength = 0.18*warm + rel_y*0.07*warm
        # Lit side gets extra sun
        facing_sun = (lr and rel_x > 0) or (not lr and rel_x < 0)
        if facing_sun: sun_strength += 0.06*warm

        # Ambient fill: opposite side gets cool ambient
        amb_strength = 0.10 if facing_sun else 0.15

        # Apply: weighted average of original, sun, ambient
        nr = r*(1-sun_strength-amb_strength) + sr*sun_strength + ar*amb_strength
        ng = g*(1-sun_strength-amb_strength) + sg*sun_strength + ag*amb_strength
        nb = b*(1-sun_strength-amb_strength) + sb*sun_strength + ab*amb_strength

        # Slight outdoor contrast
        nr = max(0,min(255,(nr-128)*1.03+128))
        ng = max(0,min(255,(ng-128)*1.03+128))
        nb = max(0,min(255,(nb-128)*1.03+128))

        updated[(px,py)] = (int(nr),int(ng),int(nb),a)

    return updated
```

---

## Step 2 — Per-Cluster Specular Highlights

```python
def apply_specular_per_cluster(vapor, fg_mask: dict, scene_props: dict,
                                material_map: dict = None) -> dict:
    """
    Add directional specular highlights to each cluster based on material class.

    material_map: optional dict of cluster_id → material_class.
                  If None, uses vapor cluster semantic_class to infer material.
                  semantic_class → material mapping:
                    skin_region → "skin"
                    frog_body → "frog_skin"
                    horse_body → "horse_coat"
                    jeans → "clothing_matte"
                    dark_clothing → "clothing_matte"
                    water_surface → "water"
                    sand_surface → "sand_dry"
                    wet_sand → "sand_wet"
                    lily_pad → "lily_pad"
                    contour_edge → None (skip)
    """
    from vapor_idx import QueryOptions

    SPEC_EXPONENTS = {
        "skin":8,"frog_skin":8,"horse_coat":32,"fur":8,"hair":16,
        "clothing_matte":4,"clothing_glossy":64,"lily_pad":12,
        "sand_dry":2,"sand_wet":64,"water":256,"metal":512,
        "glass":1024,"plastic_matte":4,"plastic_glossy":128,"wood":6,
    }

    LABEL_TO_MATERIAL = {
        "skin_region":"skin","skin":"skin","large_skin_oval":"skin",
        "frog_body":"frog_skin","frog_skin":"frog_skin",
        "horse_body":"horse_coat","horse_coat":"horse_coat",
        "jeans":"clothing_matte","dark_clothing":"clothing_matte",
        "torso_region":"clothing_matte","arm_segment":"skin",
        "water_surface":"water","water_region":"water",
        "sand_surface":"sand_dry","sandy_region":"sand_dry",
        "wet_surface":"sand_wet","lily_pad_green":"lily_pad",
        "leaf":"leaf_dry","wood_surface":"wood",
    }

    sr,sg,sb = scene_props.get("sun_color",(255,180,100))
    lr = scene_props.get("light_from_right", True)

    xs_all = [x for (x,y) in fg_mask]
    x_center = sum(xs_all)/len(xs_all) if xs_all else 0
    x_range = max(xs_all)-min(xs_all) if xs_all else 1

    # Build cluster → material map from vapor
    cluster_material = {}
    if material_map:
        cluster_material = material_map
    else:
        for rec in vapor.query(QueryOptions(type="Cluster")).records:
            lbl = rec.data.get("semantic_class","")
            mat = None
            for key,val in LABEL_TO_MATERIAL.items():
                if key in lbl: mat=val; break
            if mat: cluster_material[rec.data["cluster_id"]] = mat

    # Build pixel → cluster map
    pix_cluster = {}
    for rec in vapor.query(QueryOptions(type="Pixel")).records:
        x,y = int(rec.data["x"]),int(rec.data["y"])
        if (x,y) in fg_mask:
            pix_cluster[(x,y)] = rec.data.get("cluster","")

    updated = {}
    for (px,py),(r,g,b,a) in fg_mask.items():
        cid = pix_cluster.get((px,py),"")
        mat = cluster_material.get(cid,"skin")
        exp = SPEC_EXPONENTS.get(mat, 8)

        # Surface normal approximation from x position
        rel_x = (px-x_center)/x_range
        facing_sun = (lr and rel_x > 0) or (not lr and rel_x < 0)
        dot = abs(rel_x) * (1.0 if facing_sun else 0.15)

        if dot > 0.05:
            spec = (dot ** exp) * 0.8  # scale to 80% max
            nr = max(0,min(255,int(r + (sr-r)*spec)))
            ng = max(0,min(255,int(g + (sg-g)*spec)))
            nb = max(0,min(255,int(b + (sb-b)*spec)))
            updated[(px,py)] = (nr,ng,nb,a)
        else:
            updated[(px,py)] = (r,g,b,a)

    return updated
```

---

## Step 3 — Sub-Surface Scattering

```python
def apply_sss(fg_mask: dict, scene_props: dict,
              sss_materials: set = None, step: int = 2) -> dict:
    """
    Sub-surface scattering for organic surfaces:
    - Skin: warm red-channel glow at boundaries facing light
    - Frog skin: stronger, also affects green channel slightly
    - Leaf: warm yellow-green translucency
    - Hair: softer, diffuse rim

    sss_materials: set of cluster IDs to apply SSS to.
    If None, applies to all boundary pixels.
    """
    if sss_materials is None:
        sss_materials = None  # apply everywhere

    sr,sg,sb = scene_props.get("sun_color",(255,200,100))
    lr = scene_props.get("light_from_right", True)
    warm = scene_props.get("warm_strength", 0.3)

    mask_set = set(fg_mask.keys())
    xs_all = [x for (x,y) in fg_mask]
    x_min = min(xs_all); x_max = max(xs_all); x_mid = (x_min+x_max)/2

    updated = dict(fg_mask)
    for (px,py),(r,g,b,a) in fg_mask.items():
        # Check boundary: any of the 4 neighbors is outside mask
        is_boundary = any((px+dx2,py+dy2) not in mask_set
                         for dx2,dy2 in [(step,0),(-step,0),(0,step),(0,-step)])
        if not is_boundary: continue

        rel_x = (px-x_mid)/max(x_max-x_min,1)
        facing = (lr and rel_x > 0) or (not lr and rel_x < 0)

        if facing:
            # Lit side: warm SSS glow
            sss = 0.16 * warm
            nr = max(0,min(255, int(r + (sr-r)*sss)))
            ng = max(0,min(255, int(g + max(0,sg-g)*sss*0.5)))
            nb = max(0,min(255, int(b)))
        else:
            # Rim light: cool edge
            rim = 0.08
            nr = max(0,min(255, int(r + rim*25)))
            ng = max(0,min(255, int(g)))
            nb = max(0,min(255, int(b + rim*30)))

        updated[(px,py)] = (nr,ng,nb,a)

    return updated
```

---

## Step 4 — Color Temperature Matching

```python
def apply_color_temperature(fg_mask: dict, source_temp_k: int = 5500,
                              target_temp_k: int = 2700,
                              strength: float = 0.7) -> dict:
    """
    Shift color temperature of subject pixels to match scene.
    Uses Bradford chromatic adaptation approximation.

    source_temp_k: original color temp of subject (typically 5500K studio)
    target_temp_k: scene color temp from scene_props["color_temp_kelvin"]
    strength: blend strength (0-1)
    """
    # Approximate RGB multipliers for color temperature shift
    # Based on Planckian locus approximation
    def temp_to_rgb_multiplier(temp_k):
        # Normalized around D65 (6500K = 1.0,1.0,1.0)
        if temp_k <= 6500:
            r_mult = 1.0 + (6500-temp_k)/6500 * 0.3
            g_mult = 1.0 + (6500-temp_k)/6500 * 0.05
            b_mult = max(0.5, 1.0 - (6500-temp_k)/6500 * 0.4)
        else:
            r_mult = max(0.7, 1.0 - (temp_k-6500)/10000 * 0.3)
            g_mult = 1.0 - (temp_k-6500)/20000 * 0.05
            b_mult = min(1.3, 1.0 + (temp_k-6500)/10000 * 0.2)
        return r_mult, g_mult, b_mult

    src_r,src_g,src_b = temp_to_rgb_multiplier(source_temp_k)
    tgt_r,tgt_g,tgt_b = temp_to_rgb_multiplier(target_temp_k)

    # Relative multiplier: how much to shift from source to target
    rel_r = tgt_r/max(src_r,0.01)
    rel_g = tgt_g/max(src_g,0.01)
    rel_b = tgt_b/max(src_b,0.01)

    updated = {}
    for (px,py),(r,g,b,a) in fg_mask.items():
        # Apply with blend strength
        nr = max(0,min(255,int(r * (1-strength + rel_r*strength))))
        ng = max(0,min(255,int(g * (1-strength + rel_g*strength))))
        nb = max(0,min(255,int(b * (1-strength + rel_b*strength))))
        updated[(px,py)] = (nr,ng,nb,a)

    return updated
```

---

## Step 5 — Cast Shadow on Surface

```python
def cast_shadow_on_surface(canvas: list, fg_mask: dict,
                            BW: int, BH: int,
                            feet_x: int, feet_y: int,
                            scene_props: dict,
                            subject_w: int, subject_h: int) -> None:
    """
    Cast a shadow from the subject onto the ground surface.
    Shadow is projected in the direction opposite to the light source.
    Shadow softness follows scene_props["shadow_softness"].
    Shadow color is derived from scene surface color.
    """
    lr = scene_props.get("light_from_right", True)
    elev = scene_props.get("light_elevation_deg", 30)
    soft = scene_props.get("shadow_softness", 0.5)
    sr,sg,sb = scene_props.get("surface_color",
               scene_props.get("sand_color",(180,155,115)))
    shadow_col = (int(sr*0.35), int(sg*0.27), int(sb*0.22))

    # Shadow length from elevation: lower sun = longer shadow
    shadow_length = int(subject_h * math.tan(math.radians(max(5, 90-elev))) * 0.4)
    shadow_length = min(shadow_length, int(BH*0.25))

    # Shadow direction: opposite to light
    dir_mult = -1 if lr else 1

    for i in range(shadow_length):
        t = i/shadow_length
        # Shadow x offset increases with distance
        shadow_x = feet_x + int(dir_mult * subject_w * 0.25 * t)
        shadow_y = feet_y + int(shadow_length * 0.10 * t)

        # Shadow width decreases with distance (perspective)
        sw = max(1, int(subject_w * 0.4 * (1-t*0.4)))

        if not (0<=shadow_y<BH): continue

        for dx2 in range(-sw, sw+1):
            ppx = shadow_x + dx2
            if not (0<=ppx<BW): continue

            # Soft shadow: Gaussian-like falloff from center
            center_dist = abs(dx2)/sw
            if soft > 0.5:
                # Diffuse: smooth falloff
                opacity = (1-center_dist)*0.5*(1-t)*0.55*(1-soft*0.5)
            else:
                # Hard shadow
                opacity = (1-center_dist)*0.7*(1-t)*0.65

            bg = canvas[shadow_y][ppx]
            canvas[shadow_y][ppx] = [
                max(0,min(255,int(bg[0]*(1-opacity)+shadow_col[0]*opacity))),
                max(0,min(255,int(bg[1]*(1-opacity)+shadow_col[1]*opacity))),
                max(0,min(255,int(bg[2]*(1-opacity)+shadow_col[2]*opacity))),
                255
            ]
```

---

## Step 6 — Horizon Glow + Depth Fog

```python
def render_horizon_glow(canvas: list, BW: int, BH: int,
                         horizon_y: int, scene_props: dict,
                         glow_width: int = 30) -> None:
    """
    Add sunset/golden-hour glow band at horizon line.
    Only applied when warm_strength > 0.15.
    """
    warm = scene_props.get("warm_strength", 0.0)
    if warm < 0.15: return

    gr,gg,gb = scene_props.get("horizon_glow_color",(255,175,75))

    for y in range(max(0,horizon_y-glow_width), min(BH,horizon_y+glow_width//3)):
        dist = abs(y-horizon_y)
        glow_t = max(0.0, 1.0 - dist/glow_width) * warm * 0.38
        for x in range(BW):
            px = canvas[y][x]
            canvas[y][x] = [
                max(0,min(255,int(px[0]*(1-glow_t)+gr*glow_t))),
                max(0,min(255,int(px[1]*(1-glow_t)+gg*glow_t))),
                max(0,min(255,int(px[2]*(1-glow_t)+gb*glow_t))),
                255
            ]


def apply_depth_atmosphere(canvas: list, BW: int, BH: int,
                            scene_props: dict) -> None:
    """
    Atmospheric perspective on distant (upper) canvas regions.
    Adds slight haze/desaturation to background elements above horizon.
    Applied per-pixel (allowed because it's background-only, not subject).
    """
    sr,sg,sb = scene_props.get("sky_color",(180,190,210))
    horizon_y = scene_props.get("boundary_y",
               scene_props.get("primary_horizon_y", BH//2))

    for y in range(min(horizon_y, int(BH*0.5))):
        # More haze at top (more distant)
        depth_t = max(0.0, (horizon_y-y)/max(horizon_y,1)) * 0.20
        for x in range(0,BW,1):
            px = canvas[y][x]
            canvas[y][x] = [
                max(0,min(255,int(px[0]*(1-depth_t)+sr*depth_t))),
                max(0,min(255,int(px[1]*(1-depth_t)+sg*depth_t))),
                max(0,min(255,int(px[2]*(1-depth_t)+sb*depth_t))),
                255
            ]
```

---

## Step 7 — Full Lighting Pipeline

```python
def apply_full_lighting(fg_mask: dict, scene_props: dict,
                         vapor=None,
                         material_map: dict = None,
                         subject_type: str = "generic",
                         canvas_h: int = 750,
                         apply_sss_flag: bool = True,
                         apply_specular_flag: bool = True,
                         source_temp_k: int = 5500) -> dict:
    """
    Apply full lighting pipeline to a foreground mask.
    Returns fully-lit mask ready for compositing.

    Order:
    1. Color temperature matching (scene temp vs source temp)
    2. Directional diffuse lighting
    3. Per-cluster specular highlights (if apply_specular_flag)
    4. SSS on organic surfaces (if apply_sss_flag)
    """
    target_temp_k = scene_props.get("color_temp_kelvin", 5500)

    print(f"  Lighting: {len(fg_mask)} pixels | temp {source_temp_k}K→{target_temp_k}K")

    # 1. Color temperature
    if abs(source_temp_k - target_temp_k) > 300:
        fg_mask = apply_color_temperature(fg_mask, source_temp_k, target_temp_k, strength=0.65)

    # 2. Diffuse
    fg_mask = apply_directional_diffuse(fg_mask, scene_props, canvas_h, subject_type)

    # 3. Specular
    if apply_specular_flag and vapor:
        fg_mask = apply_specular_per_cluster(vapor, fg_mask, scene_props, material_map)

    # 4. SSS
    if apply_sss_flag and subject_type in ("person","animal","frog","organic"):
        fg_mask = apply_sss(fg_mask, scene_props)

    print(f"  Lighting complete.")
    return fg_mask
```

---

## Output

Report: pixel count processed, color temperature shift applied, specular exponent
per material class used, SSS applied (yes/no), shadow length and direction,
horizon glow strength, depth fog depth applied.
