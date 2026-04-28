---
name: Scene Analyzer
description: Extract physical scene properties from any background image before compositing any subject into it. Detects structural boundaries, segments environment zones, extracts 12-variable lighting model, estimates depth, classifies materials. Foundational layer for all compositing pipelines — must run before placing any subject. Pure Python, vapor-idx, no external libraries.
version: 1.0.0
tools:
  - computer_use
---

# Scene Analyzer Skill v1.0

## Purpose

The scene-analyzer is the **first step** in any compositing pipeline. Before any
subject is extracted or placed, the target environment must be fully understood:
- What type of scene is this? (outdoor/indoor/underwater/studio/urban)
- Where is the structural boundary that separates scene zones?
- What zones exist and where? (sky, water, sand, floor, wall, etc.)
- Where does the light come from? What color is it?
- What are the material properties of each surface?
- How deep is each region? Where is the viewer relative to the scene?

Without this analysis, any compositing is guesswork.

## CRITICAL: vapor-idx API

```
vapor.get_relationships(id, rel_type=None, direction="both")  ← correct
vapor.getRelationships(...)  ← DOES NOT EXIST, will crash
```

## When to Trigger

- Before any subject is composited into an environment
- When asked to analyze scene lighting or composition
- When asked to detect depth, perspective, or vanishing points
- Before environment modification (waves, weather, time-of-day change)
- When asked "what kind of scene is this?"

## Environment

```bash
pip install vapor-idx
```

---

## Step 1 — Scene Type Classification

```python
def classify_scene_type(pixels: list, W: int, H: int) -> str:
    """
    Classify the overall scene type from raw pixel statistics.
    No vapor needed — pure pixel sampling.

    Returns: "outdoor_beach"|"outdoor_nature"|"outdoor_urban"|"indoor_room"|
             "indoor_studio"|"underwater"|"aerial"|"night"|"unknown"
    """
    # Sample key regions
    def sample_region(y_frac_start, y_frac_end, x_frac_start=0, x_frac_end=1):
        samples = []
        for y in range(int(H*y_frac_start), int(H*y_frac_end), 4):
            for x in range(int(W*x_frac_start), int(W*x_frac_end), 4):
                samples.append(pixels[y][x][:3])
        return samples

    top    = sample_region(0, 0.3)
    middle = sample_region(0.3, 0.7)
    bottom = sample_region(0.7, 1.0)

    def avg(s): return tuple(sum(c[i] for c in s)/len(s) for i in range(3)) if s else (128,128,128)

    top_col    = avg(top)
    mid_col    = avg(middle)
    bot_col    = avg(bottom)
    global_br  = sum(avg(top+middle+bottom)) / 3

    # Feature detection
    top_is_sky    = top_col[2] > top_col[0] and top_col[2] > 80 or \
                    sum(top_col)/3 > 160
    bot_is_sandy  = bot_col[0] > bot_col[2] and bot_col[0] > 130
    bot_is_green  = bot_col[1] > bot_col[0] and bot_col[1] > bot_col[2]
    is_warm       = top_col[0] > top_col[2] + 30
    is_uniform_bg = max(abs(top_col[0]-bot_col[0]),
                        abs(top_col[1]-bot_col[1]),
                        abs(top_col[2]-bot_col[2])) < 40
    is_dark       = global_br < 80
    has_blue_dom  = sum(1 for r,g,b in middle if b>r and b>g and b>80) > len(middle)*0.5

    if is_dark:                          return "night"
    if is_uniform_bg and global_br>200:  return "indoor_studio"
    if top_is_sky and bot_is_sandy:      return "outdoor_beach"
    if top_is_sky and bot_is_green:      return "outdoor_nature"
    if has_blue_dom and not top_is_sky:  return "underwater"
    if top_is_sky:                       return "outdoor_generic"
    if not top_is_sky and global_br>150: return "indoor_room"
    return "unknown"
```

---

## Step 2 — Structural Boundary Detection

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions
import struct, zlib, math
from collections import deque

def detect_all_boundaries(pixels: list, W: int, H: int,
                           scene_type: str = "outdoor_beach") -> list[dict]:
    """
    Find ALL significant structural boundaries in the image.
    Different scene types have different boundary patterns:

    outdoor_beach:  horizon (sky|water), waterline (water|sand), wet/dry sand junction
    outdoor_nature: horizon, treeline, ground level
    indoor_room:    ceiling/wall junction, wall/floor junction, table surface
    underwater:     surface line, depth gradient

    Returns list of boundary dicts sorted by y position, each with:
    { y, confidence, boundary_type, brightness_above, brightness_below }
    """
    boundaries = []

    # Compute per-row statistics
    row_stats = {}
    for y in range(H):
        r_vals = [pixels[y][x][0] for x in range(0,W,4)]
        g_vals = [pixels[y][x][1] for x in range(0,W,4)]
        b_vals = [pixels[y][x][2] for x in range(0,W,4)]
        n = len(r_vals)
        if n == 0: continue
        avg_r = sum(r_vals)/n; avg_g = sum(g_vals)/n; avg_b = sum(b_vals)/n
        br = (avg_r+avg_g+avg_b)/3

        # Horizontal edge: row-to-row brightness change
        row_stats[y] = {"r":avg_r,"g":avg_g,"b":avg_b,"br":br}

    sorted_ys = sorted(row_stats.keys())

    # Compute per-row gradient magnitude (absolute brightness change)
    row_grad = {}
    for i,y in enumerate(sorted_ys[1:],1):
        y_prev = sorted_ys[i-1]
        delta_br = abs(row_stats[y]["br"] - row_stats[y_prev]["br"])
        delta_r  = abs(row_stats[y]["r"]  - row_stats[y_prev]["r"])
        delta_g  = abs(row_stats[y]["g"]  - row_stats[y_prev]["g"])
        delta_b  = abs(row_stats[y]["b"]  - row_stats[y_prev]["b"])
        row_grad[y] = max(delta_br, (delta_r+delta_g+delta_b)/3)

    # Find local maxima in gradient within search zones
    # Different scene types search different zones
    if scene_type in ("outdoor_beach","outdoor_generic"):
        # Primary horizon: 15-60% from top
        search_zones = [
            (0.15, 0.60, "horizon"),
            (0.45, 0.80, "waterline"),
            (0.70, 0.92, "wet_dry_junction"),
        ]
    elif scene_type == "indoor_room":
        search_zones = [
            (0.05, 0.25, "ceiling_wall"),
            (0.60, 0.90, "wall_floor"),
        ]
    elif scene_type == "outdoor_nature":
        search_zones = [
            (0.20, 0.55, "horizon"),
            (0.40, 0.80, "treeline"),
        ]
    elif scene_type == "underwater":
        search_zones = [
            (0.05, 0.25, "water_surface"),
        ]
    else:
        search_zones = [(0.20, 0.80, "structural_edge")]

    for y_frac_min, y_frac_max, boundary_name in search_zones:
        y_min = int(H*y_frac_min); y_max = int(H*y_frac_max)
        zone_ys = [y for y in sorted_ys if y_min <= y <= y_max]
        if not zone_ys: continue

        # Find y with maximum gradient in this zone
        best_y = max(zone_ys, key=lambda y: row_grad.get(y,0))
        best_grad = row_grad.get(best_y,0)

        if best_grad < 3.0: continue  # No significant boundary here

        # Compute brightness above and below
        above_ys = [y for y in sorted_ys if y < best_y]
        below_ys = [y for y in sorted_ys if y > best_y]
        br_above = sum(row_stats[y]["br"] for y in above_ys[-20:])/max(len(above_ys[-20:]),1) if above_ys else 128
        br_below = sum(row_stats[y]["br"] for y in below_ys[:20])/max(len(below_ys[:20]),1) if below_ys else 128

        # Classify boundary from color characteristics
        ab = row_stats[best_y]
        if ab["b"] > ab["r"] and br_below < br_above:
            btype = "water_horizon"
        elif ab["r"] > ab["b"] and ab["r"] > 150 and br_above > 150:
            btype = "warm_horizon"
        elif abs(br_above-br_below) < 20:
            btype = "texture_change"
        else:
            btype = boundary_name

        confidence = min(1.0, best_grad / 30.0)

        boundaries.append({
            "y": best_y, "confidence": confidence,
            "boundary_type": btype,
            "brightness_above": br_above, "brightness_below": br_below,
            "gradient_magnitude": best_grad,
        })

    # Sort by y position
    boundaries.sort(key=lambda b: b["y"])
    print(f"  Boundaries found: {len(boundaries)}")
    for b in boundaries:
        print(f"    y={b['y']} type={b['boundary_type']} conf={b['confidence']:.2f}")

    return boundaries
```

---

## Step 3 — Full 12-Variable Lighting Model

```python
def extract_full_lighting_model(pixels: list, W: int, H: int,
                                boundaries: list[dict],
                                scene_type: str = "outdoor_beach") -> dict:
    """
    Extract all 12 lighting variables from the background image.

    Variables:
    1.  sky_color            (r,g,b) dominant sky
    2.  sky_gradient          (top_color, mid_color, horizon_color)
    3.  sun_color             (r,g,b) direct light source
    4.  ambient_color         (r,g,b) fill/skylight
    5.  light_direction       "LEFT"|"RIGHT"|"TOP"|"FRONT"|"REAR"
    6.  light_elevation_deg   angle above horizon (0=horizontal, 90=overhead)
    7.  shadow_softness       0.0=hard 1.0=fully diffuse
    8.  warm_strength         0.0-1.0 scene warmth
    9.  surface_color         (r,g,b) primary ground/floor surface
    10. secondary_surface     (r,g,b) secondary zone (water, wall, etc.)
    11. horizon_glow_color    (r,g,b) transitional glow at boundary
    12. color_temp_kelvin     approximate color temperature
    """
    # Find primary horizon boundary
    primary_y = H//2  # fallback
    for b in boundaries:
        if "horizon" in b["boundary_type"] or b["confidence"] > 0.5:
            primary_y = b["y"]; break

    def sample_zone(y0, y1, x0=0, x1=None):
        if x1 is None: x1 = W
        s = []
        for y in range(max(0,y0),min(H,y1),3):
            for x in range(max(0,x0),min(W,x1),4):
                s.append(pixels[y][x][:3])
        return s

    def avg_rgb(samples):
        if not samples: return (128,128,128)
        n=len(samples); return tuple(int(sum(c[i] for c in samples)/n) for i in range(3))

    # 1. Sky color
    sky_all   = sample_zone(0, primary_y)
    sky_top   = sample_zone(0, primary_y//3)
    sky_mid   = sample_zone(primary_y//3, 2*primary_y//3)
    sky_hor   = sample_zone(2*primary_y//3, primary_y)
    sky_col   = avg_rgb(sky_all)
    sky_top_c = avg_rgb(sky_top)
    sky_mid_c = avg_rgb(sky_mid)
    sky_hor_c = avg_rgb(sky_hor)

    # 3. Sun color: warmest/brightest sky pixels
    bright_sky = sorted(sky_all, key=lambda s: s[0]-s[2], reverse=True)[:30]
    sun_col = avg_rgb(bright_sky) if bright_sky else sky_col

    # 4. Ambient: cooler complement
    sc = sky_col
    amb_col = (max(0,sc[0]-35), sc[1], min(255,sc[2]+40))

    # 5 & 6. Light direction and elevation
    left_samp  = sample_zone(int(H*0.7), H, 0, W//3)
    right_samp = sample_zone(int(H*0.7), H, 2*W//3, W)
    top_samp   = sample_zone(int(H*0.7), int(H*0.75))
    bot_samp   = sample_zone(int(H*0.90), H)

    left_br  = sum((r+g+b)/3 for r,g,b in left_samp)  / max(len(left_samp),1)
    right_br = sum((r+g+b)/3 for r,g,b in right_samp) / max(len(right_samp),1)

    if right_br > left_br + 5:       light_dir = "RIGHT"; light_right = True
    elif left_br > right_br + 5:     light_dir = "LEFT";  light_right = False
    else:                             light_dir = "FRONT"; light_right = True

    # Elevation: estimate from sky brightness distribution
    sky_br_top  = sum((r+g+b)/3 for r,g,b in sky_top)  / max(len(sky_top),1)
    sky_br_hor  = sum((r+g+b)/3 for r,g,b in sky_hor)  / max(len(sky_hor),1)
    if sky_br_hor > sky_br_top + 20:
        elevation_deg = 8   # near horizon sun (sunset/sunrise)
    elif sky_br_top > sky_br_hor + 20:
        elevation_deg = 60  # high sun (midday)
    else:
        elevation_deg = 30  # mid elevation

    # 7. Shadow softness from sky saturation
    # Overcast sky → soft shadows; clear sky → hard shadows
    sky_sat_vals = []
    for r,g,b in sky_all:
        mx = max(r,g,b); mn = min(r,g,b)
        sky_sat_vals.append((mx-mn)/max(mx,1))
    avg_sky_sat = sum(sky_sat_vals)/len(sky_sat_vals) if sky_sat_vals else 0.2
    shadow_softness = max(0.1, min(1.0, 1.0 - avg_sky_sat * 1.5))

    # 8. Warm strength
    sr,sg,sb = sky_col
    warm_strength = max(0.0, min(1.0, (sr-sb)/255.0))

    # 9 & 10. Surface colors (below primary horizon)
    below_left   = sample_zone(primary_y, H, 0, W//2)
    below_right  = sample_zone(primary_y, H, W//2, W)
    below_mid    = sample_zone(primary_y, int(H*0.75))
    below_bot    = sample_zone(int(H*0.75), H)

    # Primary surface = bottom zone
    primary_surf = avg_rgb(below_bot)
    # Secondary = mid zone (often water or wet sand)
    secondary_surf = avg_rgb(below_mid)

    # 11. Horizon glow
    glow_zone = sample_zone(max(0,primary_y-20), min(H,primary_y+15))
    glow_warm = [s for s in glow_zone if s[0]>140 and s[0]>s[2]]
    horiz_glow = avg_rgb(glow_warm) if glow_warm else sky_hor_c

    # 12. Color temperature (Kelvin approximation)
    if warm_strength > 0.4:        color_temp_k = 2700  # warm sunset
    elif warm_strength > 0.25:     color_temp_k = 4000  # golden hour
    elif sr > 200 and sb > 200:    color_temp_k = 7500  # overcast
    elif sb > sr:                  color_temp_k = 9000  # blue hour
    else:                          color_temp_k = 5500  # daylight

    # Human-readable temp name
    temp_names = {2700:"WARM_SUNSET",4000:"GOLDEN_HOUR",5500:"DAYLIGHT",
                  7500:"OVERCAST",9000:"BLUE_HOUR"}
    color_temp = temp_names.get(color_temp_k, "DAYLIGHT")

    result = {
        "sky_color":         sky_col,
        "sky_gradient":      (sky_top_c, sky_mid_c, sky_hor_c),
        "sun_color":         sun_col,
        "ambient_color":     amb_col,
        "light_direction":   light_dir,
        "light_from_right":  light_right,
        "light_elevation_deg": elevation_deg,
        "shadow_softness":   shadow_softness,
        "warm_strength":     warm_strength,
        "surface_color":     primary_surf,
        "secondary_surface": secondary_surf,
        "horizon_glow_color":horiz_glow,
        "color_temp":        color_temp,
        "color_temp_kelvin": color_temp_k,
        "primary_horizon_y": primary_y,
        "fog_depth":         0.65,
        "all_boundaries":    boundaries,
    }

    print(f"  Lighting: sky={sky_col} sun={sun_col} dir={light_dir} elev={elevation_deg}°")
    print(f"            warm={warm_strength:.2f} temp={color_temp} ({color_temp_k}K)")
    print(f"            surface={primary_surf} horiz_glow={horiz_glow}")
    return result
```

---

## Step 4 — Depth Map Estimation

```python
def estimate_depth_map(pixels: list, W: int, H: int,
                        boundaries: list[dict], scene_type: str) -> list[list[float]]:
    """
    Estimate relative depth (0=near, 1=far) for each pixel using:
    1. Y-position relative to horizon (below horizon = closer)
    2. Atmospheric desaturation: distant objects are less saturated
    3. Blur gradient: distant objects are softer
    4. Size heuristic: smaller objects are farther

    Returns depth_map[y][x] = float 0.0-1.0 (0=near, 1=far/distant)

    Pure Python computation — no vapor needed for this pass.
    """
    primary_y = H//2
    for b in boundaries:
        if b["confidence"] > 0.4:
            primary_y = b["y"]; break

    depth_map = [[0.0]*W for _ in range(H)]

    for y in range(H):
        for x in range(0,W,2):  # step=2 for speed
            # Base depth from y position relative to horizon
            if y <= primary_y:
                # Above horizon: sky = farther (depth increases toward top)
                y_depth = 1.0 - (y / primary_y) * 0.5  # sky ranges 0.5-1.0
            else:
                # Below horizon: ground/sand, closer toward bottom
                ground_h = H - primary_y
                y_depth = 0.5 * (1.0 - (y - primary_y) / ground_h)  # 0.0-0.5

            # Atmospheric haze: above horizon, objects at top are more desaturated
            r,g,b = pixels[y][x][:3]
            mx = max(r,g,b); mn = min(r,g,b)
            sat = (mx-mn)/max(mx,1)
            haze_factor = max(0.0, (1.0-sat)*0.3) if y < primary_y else 0.0

            depth_map[y][x] = min(1.0, max(0.0, y_depth + haze_factor))
            if x+1 < W: depth_map[y][x+1] = depth_map[y][x]  # fill second pixel

    return depth_map
```

---

## Step 5 — Material Zone Characterization

```python
def characterize_material_zones(pixels: list, W: int, H: int,
                                 boundaries: list[dict],
                                 scene_type: str) -> dict:
    """
    Extract full material properties for each scene zone.
    Returns zone_materials: dict zone_name → material_props dict.

    material_props includes:
    {
      avg_color: (r,g,b),
      texture_variance: float,
      reflectivity: float,
      roughness_class: str,
      color_histogram: list of (r,g,b,count),
      saturation_mean: float,
      dominant_hue: float,
    }
    """
    primary_y = H//2
    for b in boundaries:
        if b["confidence"] > 0.4:
            primary_y = b["y"]; break

    def sample_zone_px(y0, y1, x0=0, x1=None):
        if x1 is None: x1 = W
        s = []
        for y in range(max(0,y0),min(H,y1),3):
            for x in range(max(0,x0),min(W,x1),4):
                s.append(pixels[y][x][:3])
        return s

    def characterize(samples):
        if not samples: return {}
        n = len(samples)
        rs = [s[0] for s in samples]; gs = [s[1] for s in samples]; bs = [s[2] for s in samples]
        brs = [(r+g+b)/3 for r,g,b in samples]
        avg_r = sum(rs)/n; avg_g = sum(gs)/n; avg_b = sum(bs)/n
        avg_br = sum(brs)/n
        br_std = (sum((b2-avg_br)**2 for b2 in brs)/n)**0.5

        # HSV
        hsv_vals = []
        for r,g,b in samples:
            mx=max(r,g,b); mn=min(r,g,b); d=mx-mn
            if mx > 0 and d > 0:
                if mx==r:   h=60*(((g-b)/d)%6)
                elif mx==g: h=60*((b-r)/d+2)
                else:       h=60*((r-g)/d+4)
                s=d/mx
            else:
                h=0.0; s=0.0
            hsv_vals.append((h,s,mx/255))

        avg_h = sum(v[0] for v in hsv_vals)/n
        avg_s = sum(v[1] for v in hsv_vals)/n

        # Reflectivity: fraction with brightness>220 and saturation<0.15
        refl = sum(1 for v in hsv_vals if v[2]*255>220 and v[1]<0.15) / n
        reflectivity = min(1.0, refl * 8.0)

        tex_var = br_std**2

        if reflectivity > 0.5:    roughness = "mirror"
        elif tex_var < 50:        roughness = "glossy"
        elif tex_var < 200:       roughness = "satin"
        elif tex_var < 800:       roughness = "matte"
        else:                     roughness = "rough"

        # Simplified 8-bucket color histogram
        bucket_size = 32
        hist = {}
        for r,g,b in samples:
            key = (r//bucket_size*bucket_size, g//bucket_size*bucket_size, b//bucket_size*bucket_size)
            hist[key] = hist.get(key,0) + 1
        top_hist = sorted(hist.items(), key=lambda x:-x[1])[:8]

        return {
            "avg_color": (int(avg_r),int(avg_g),int(avg_b)),
            "texture_variance": tex_var,
            "reflectivity": reflectivity,
            "roughness_class": roughness,
            "color_histogram": [(k[0],k[1],k[2],v) for k,v in top_hist],
            "saturation_mean": avg_s,
            "dominant_hue": avg_h,
            "sample_count": n,
        }

    zones = {}

    if scene_type in ("outdoor_beach","outdoor_generic"):
        zones["sky"]       = characterize(sample_zone_px(0, int(primary_y*0.7)))
        zones["sky_glow"]  = characterize(sample_zone_px(int(primary_y*0.7), primary_y))
        zones["water"]     = characterize(sample_zone_px(primary_y, int(H*0.60)))
        zones["wet_sand"]  = characterize(sample_zone_px(int(H*0.60), int(H*0.80)))
        zones["dry_sand"]  = characterize(sample_zone_px(int(H*0.80), H))
    elif scene_type == "indoor_room":
        zones["ceiling"]   = characterize(sample_zone_px(0, int(H*0.20)))
        zones["wall"]      = characterize(sample_zone_px(int(H*0.15), int(H*0.75)))
        zones["floor"]     = characterize(sample_zone_px(int(H*0.75), H))
    elif scene_type == "outdoor_nature":
        zones["sky"]       = characterize(sample_zone_px(0, primary_y))
        zones["foliage"]   = characterize(sample_zone_px(primary_y, int(H*0.75)))
        zones["ground"]    = characterize(sample_zone_px(int(H*0.75), H))
    else:
        zones["upper"]     = characterize(sample_zone_px(0, H//2))
        zones["lower"]     = characterize(sample_zone_px(H//2, H))

    print(f"  Material zones: {list(zones.keys())}")
    for name,props in zones.items():
        print(f"    {name}: color={props.get('avg_color','?')} "
              f"roughness={props.get('roughness_class','?')} "
              f"reflectivity={props.get('reflectivity',0):.2f}")
    return zones
```

---

## Step 6 — Full Scene Analysis Pipeline

```python
def analyze_scene(image_fp: str) -> dict:
    """
    Run full scene analysis on a background image.
    Returns comprehensive scene_data dict for use in compositing.
    Call this BEFORE any subject processing.
    """
    import struct, zlib

    def parse_png_simple(fp):
        with open(fp,'rb') as f: raw=f.read()
        assert raw[:8]==b'\x89PNG\r\n\x1a\n'
        pos=8; W=H=0; idat=b''; clr=0; ch_n=3
        while pos<len(raw):
            ln=struct.unpack('>I',raw[pos:pos+4])[0]
            tag=raw[pos+4:pos+8]; dat=raw[pos+8:pos+8+ln]; pos+=12+ln
            if tag==b'IHDR': W,H=struct.unpack('>II',dat[:8]); clr=dat[9]; ch_n={2:3,6:4}.get(clr,3)
            elif tag==b'IDAT': idat+=dat
            elif tag==b'IEND': break
        sl=W*ch_n; dec=zlib.decompress(idat); pixels=[]; prev=bytes(sl)
        for y in range(H):
            base=y*(sl+1); flt=dec[base]; row=bytearray(dec[base+1:base+1+sl])
            if flt==1:
                for i in range(ch_n,len(row)): row[i]=(row[i]+row[i-ch_n])&0xFF
            elif flt==2:
                for i in range(len(row)): row[i]=(row[i]+prev[i])&0xFF
            elif flt==3:
                for i in range(len(row)):
                    a2=row[i-ch_n] if i>=ch_n else 0; row[i]=(row[i]+(a2+prev[i])//2)&0xFF
            elif flt==4:
                for i in range(len(row)):
                    a2=row[i-ch_n] if i>=ch_n else 0; b2=prev[i]; c=prev[i-ch_n] if i>=ch_n else 0
                    p=a2+b2-c; pr=a2 if abs(p-a2)<=abs(p-b2) and abs(p-a2)<=abs(p-c) else (b2 if abs(p-b2)<=abs(p-c) else c)
                    row[i]=(row[i]+pr)&0xFF
            rp=[]
            for x in range(W):
                i=x*ch_n
                if clr==6: r2,g2,b2,a3=row[i],row[i+1],row[i+2],row[i+3]
                elif clr==2: r2,g2,b2,a3=row[i],row[i+1],row[i+2],255
                else: r2=g2=b2=row[i]; a3=255
                rp.append((r2,g2,b2,a3))
            pixels.append(rp); prev=bytes(row)
        return W,H,pixels

    print(f"Analyzing scene: {image_fp}")
    W,H,pixels = parse_png_simple(image_fp)
    print(f"  Image: {W}×{H}")

    # Step 1: Scene type
    scene_type = classify_scene_type(pixels, W, H)
    print(f"  Scene type: {scene_type}")

    # Step 2: All boundaries
    boundaries = detect_all_boundaries(pixels, W, H, scene_type)

    # Step 3: Full lighting model
    lighting = extract_full_lighting_model(pixels, W, H, boundaries, scene_type)

    # Step 4: Depth map
    depth_map = estimate_depth_map(pixels, W, H, boundaries, scene_type)

    # Step 5: Material zones
    materials = characterize_material_zones(pixels, W, H, boundaries, scene_type)

    scene_data = {
        "image_path": image_fp,
        "width": W, "height": H,
        "scene_type": scene_type,
        "boundaries": boundaries,
        "lighting": lighting,
        "depth_map": depth_map,
        "materials": materials,
        # Convenience shortcuts
        "horizon_y": lighting["primary_horizon_y"],
        "sky_color": lighting["sky_color"],
        "sun_color": lighting["sun_color"],
        "ambient_color": lighting["ambient_color"],
        "light_direction": lighting["light_direction"],
        "light_from_right": lighting["light_from_right"],
        "warm_strength": lighting["warm_strength"],
        "color_temp": lighting["color_temp"],
        "surface_color": lighting["surface_color"],
        "horizon_glow_color": lighting["horizon_glow_color"],
        "shadow_softness": lighting["shadow_softness"],
        # For pixel-analyzer compatibility
        "sand_color": lighting["surface_color"],
        "water_color": lighting["secondary_surface"],
        "boundary_y": lighting["primary_horizon_y"],
    }

    print(f"\nScene analysis complete:")
    print(f"  type={scene_type} horizon_y={scene_data['horizon_y']}")
    print(f"  {len(boundaries)} boundaries | {len(materials)} material zones")
    return scene_data
```

---

## Output

Run `analyze_scene(image_fp)` and receive `scene_data` dict containing all scene properties.
Pass `scene_data` directly to the pixel-analyzer compositing pipeline as `scene_props`.

Report:
- Scene type classification
- All detected boundaries with y-position, type, and confidence
- Full 12-variable lighting model
- Material zone properties for each zone
- Key values: horizon_y, light_direction, warm_strength, color_temp
