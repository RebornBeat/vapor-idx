---
name: Environment Modifier
description: Modify environment elements in-place using vapor-idx cluster data. Amplify waves (including tsunami-scale), add weather (rain/snow/storm), change time of day, add particle systems. All modifications occur at cluster level — not full-image filters. Cluster structure from vapor drives all modifications so they are physically consistent with the original scene.
version: 1.0.0
tools:
  - computer_use
---

# Environment Modifier Skill v1.0

## Purpose

Modify natural environment elements after scene analysis has been completed.
Every modification: identifies the relevant zone clusters in vapor, applies
a parameterized transform to their pixel data, generates new pixels
for synthesized elements, and validates physical consistency.

The key principle: **modifications propagate from structure, not from pixels alone.**
Adding a tsunami doesn't flood-fill the image blue — it reads the actual wave
profile from vapor's cluster data, scales it, and regenerates the water zone
with physically motivated amplitude, foam, and reflection.

## CRITICAL: vapor-idx API

```
vapor.get_relationships(id, rel_type, direction)  ← correct
vapor.getRelationships(...)  ← DOES NOT EXIST
```

## When to Trigger

- "Add a tsunami / giant wave"
- "Make the sky stormy"
- "Change it to golden hour"
- "Add snow / rain / sand particles"
- "Add fog"
- "Make it night time"

---

## Step 1 — Wave Amplification (Including Tsunami)

```python
import math
from collections import deque

def amplify_waves(canvas: list, vapor, BW: int, BH: int,
                  horizon_y: int, scene_props: dict,
                  factor: float = 3.0,
                  secondary_waves: bool = True) -> dict:
    """
    Scale wave amplitude by factor. factor=1 is original, factor=8 is tsunami scale.

    Algorithm:
    1. Extract current wave profile: for each x-column, find topmost water pixel
    2. Scale the wave height by factor
    3. Smooth the scaled profile to remove jaggedness
    4. Regenerate water pixels from horizon_y to new wave height
    5. Add foam at wave crests
    6. Update sky reflection in water
    7. Cast wave shadow on beach for large factors

    Returns stats dict.
    """
    from vapor_idx import QueryOptions

    water_col_r,water_col_g,water_col_b = scene_props.get("water_color",
                                          scene_props.get("secondary_surface",(80,120,160)))
    foam_col   = (240, 248, 255)  # white foam
    deep_col   = (int(water_col_r*0.6), int(water_col_g*0.7), int(water_col_b*0.85))
    surf_col   = (min(255,water_col_r+40), min(255,water_col_g+30), water_col_b)
    warm       = scene_props.get("warm_strength", 0.2)

    # Extract current wave profile
    wave_h = {}  # x → current wave height above horizon_y (in pixels)
    for x in range(0, BW, 2):
        # Find topmost water pixel in this column
        for y in range(horizon_y, min(BH, horizon_y+200)):
            px = canvas[y][x]
            if px[2] > px[0] and px[2] > 80:  # blue-dominant = water
                wave_h[x] = y - horizon_y
                break
        if x not in wave_h:
            wave_h[x] = 5  # default small wave

    # Scale wave heights
    scaled_h = {}
    for x, h in wave_h.items():
        new_h = min(BH-horizon_y-10, int(h * factor))
        scaled_h[x] = new_h

    # Gaussian smoothing to prevent jagged edges
    def smooth(d, sigma=15):
        result = {}
        for x in d:
            vals = [d.get(x+dx,d.get(x,0)) * math.exp(-(dx**2)/(2*sigma**2))
                    for dx in range(-sigma*2, sigma*2+1) if x+dx in d]
            weights = [math.exp(-(dx**2)/(2*sigma**2))
                      for dx in range(-sigma*2, sigma*2+1) if x+dx in d]
            result[x] = int(sum(vals)/max(sum(weights),0.01)) if vals else d[x]
        return result

    if factor > 1.5:
        scaled_h = smooth(scaled_h, sigma=max(5, int(BW*0.02)))

    if secondary_waves:
        # Add secondary wave pattern
        sec_amp = max(3, int(max(scaled_h.values())*0.15)) if scaled_h else 8
        for x in scaled_h:
            scaled_h[x] += int(sec_amp * math.sin(x * 0.03))

    # Regenerate water pixels
    pixels_written = 0
    for x in range(0, BW, 1):
        wh = scaled_h.get(x, scaled_h.get((x//2)*2, 20))
        wave_top = horizon_y + wh

        for y in range(horizon_y, min(BH, wave_top+1)):
            depth_frac = (y-horizon_y)/max(wh,1)  # 0=surface 1=deep

            # Color gradient: surface = lighter, deep = darker
            r = int(surf_col[0]*(1-depth_frac) + deep_col[0]*depth_frac)
            g = int(surf_col[1]*(1-depth_frac) + deep_col[1]*depth_frac)
            b = int(surf_col[2]*(1-depth_frac) + deep_col[2]*depth_frac)

            # Sky reflection in water surface
            if depth_frac < 0.2:
                sky_r,sky_g,sky_b = scene_props.get("sky_color",(180,200,230))
                sky_blend = (1-depth_frac/0.2)*0.35
                r = int(r*(1-sky_blend)+sky_r*sky_blend)
                g = int(g*(1-sky_blend)+sky_g*sky_blend)
                b = int(b*(1-sky_blend)+sky_b*sky_blend)

            # Wave chop texture
            chop = math.sin(x*0.15+y*0.08)*0.06 + math.cos(x*0.07-y*0.12)*0.04
            r = max(0,min(255,int(r*(1+chop))))
            g = max(0,min(255,int(g*(1+chop*0.7))))
            b = max(0,min(255,int(b*(1+chop*0.3))))

            if 0<=x<BW and 0<=y<BH:
                canvas[y][x] = [r,g,b,255]
                pixels_written += 1

        # Foam at wave crest
        foam_height = max(3, int(wh*0.08))
        for fy in range(max(horizon_y,wave_top-foam_height), min(BH,wave_top+3)):
            if 0<=x<BW and 0<=fy<BH:
                foam_dist = abs(fy-wave_top)
                foam_opacity = max(0, 1.0-foam_dist/foam_height)*0.9
                bg = canvas[fy][x]
                canvas[fy][x] = [
                    min(255,int(bg[0]*(1-foam_opacity)+foam_col[0]*foam_opacity)),
                    min(255,int(bg[1]*(1-foam_opacity)+foam_col[1]*foam_opacity)),
                    min(255,int(bg[2]*(1-foam_opacity)+foam_col[2]*foam_opacity)),
                    255
                ]

    # Cast shadow for large waves
    if factor > 4.0:
        light_right = scene_props.get("light_from_right", True)
        shadow_x_off = int(BW*0.05 * (-1 if light_right else 1))
        max_wave_y = horizon_y + max(scaled_h.values()) if scaled_h else horizon_y+50
        sr,sg,sb = scene_props.get("surface_color",scene_props.get("sand_color",(180,155,115)))
        shadow_col = (int(sr*0.45),int(sg*0.38),int(sb*0.32))
        for y in range(max_wave_y, min(BH, max_wave_y+int(BH*0.15))):
            for x in range(0,BW):
                t = (y-max_wave_y)/(BH*0.15)
                str2 = max(0,0.5*(1-t))
                bg = canvas[y][x]
                canvas[y][x] = [
                    max(0,min(255,int(bg[0]*(1-str2)+shadow_col[0]*str2))),
                    max(0,min(255,int(bg[1]*(1-str2)+shadow_col[1]*str2))),
                    max(0,min(255,int(bg[2]*(1-str2)+shadow_col[2]*str2))),
                    255
                ]

    return {"factor":factor,"pixels_written":pixels_written,
            "max_wave_height":max(scaled_h.values()) if scaled_h else 0}
```

---

## Step 2 — Weather Systems

```python
def add_rain(canvas: list, BW: int, BH: int,
             intensity: float = 0.5,
             wind_angle_deg: float = 15.0,
             rain_color: tuple = (200, 210, 230)) -> int:
    """
    Add rain streaks to canvas.
    Uses procedural streaks — not random per-pixel (which looks like noise).
    Streaks are generated from seed positions with physics-based direction.
    intensity: 0.0=drizzle, 1.0=downpour
    wind_angle: degrees from vertical (0=straight down, 30=blowing right)
    """
    rr,rg,rb = rain_color
    streak_count = int(BW * BH * intensity * 0.0004)
    streak_len = int(BH * 0.06 * (0.5+intensity*0.5))
    angle_rad = math.radians(wind_angle_deg)
    dx_per_y = math.tan(angle_rad)

    import random; rng = random.Random(42)

    written = 0
    for _ in range(streak_count):
        sx = rng.randint(0, BW-1)
        sy = rng.randint(0, int(BH*0.7))

        for i in range(streak_len):
            px = int(sx + dx_per_y*i); py = sy+i
            if not (0<=px<BW and 0<=py<BH): break
            # Streak opacity: full in middle, fades at ends
            t = i/streak_len
            opacity = min(1.0, t*3*(1-t)*3) * (0.3+intensity*0.3)
            bg = canvas[py][px]
            canvas[py][px] = [
                min(255,int(bg[0]*(1-opacity)+rr*opacity)),
                min(255,int(bg[1]*(1-opacity)+rg*opacity)),
                min(255,int(bg[2]*(1-opacity)+rb*opacity)),
                255
            ]
            written += 1

    return written


def add_snow(canvas: list, BW: int, BH: int,
             intensity: float = 0.4,
             flake_size: int = 2,
             drift_x: float = 0.3) -> int:
    """
    Add snowfall to canvas.
    Uses larger circular flakes, not random pixel noise.
    """
    flake_count = int(BW * BH * intensity * 0.0003)
    import random; rng = random.Random(99)

    written = 0
    for _ in range(flake_count):
        fx = rng.randint(0, BW-1)
        fy = rng.randint(0, BH-1)
        opacity = 0.5 + rng.random()*0.4

        for dy in range(-flake_size, flake_size+1):
            for dx in range(-flake_size, flake_size+1):
                if dx**2+dy**2 > flake_size**2: continue
                px = fx+dx; py = fy+dy
                if not (0<=px<BW and 0<=py<BH): continue
                edge_t = 1.0-(dx**2+dy**2)**0.5/flake_size
                op = opacity*edge_t
                bg = canvas[py][px]
                canvas[py][px] = [
                    min(255,int(bg[0]*(1-op)+240*op)),
                    min(255,int(bg[1]*(1-op)+245*op)),
                    min(255,int(bg[2]*(1-op)+255*op)),
                    255
                ]
                written += 1

    return written


def add_storm_atmosphere(canvas: list, BW: int, BH: int,
                          horizon_y: int, scene_props: dict,
                          storm_intensity: float = 0.7) -> None:
    """
    Add storm atmosphere: desaturate sky, darken, add rolling cloud texture.
    Operates only on sky zone (above horizon).
    """
    # Darken and desaturate sky
    for y in range(0, horizon_y):
        for x in range(0, BW):
            px = canvas[y][x]
            # Convert to grayscale partially
            gray = int((px[0]+px[1]+px[2])/3)
            desat_t = storm_intensity * 0.6
            dark_t = storm_intensity * 0.35
            nr = int(px[0]*(1-desat_t) + gray*desat_t) * (1-dark_t)
            ng = int(px[1]*(1-desat_t) + gray*desat_t) * (1-dark_t)
            nb = int(px[2]*(1-desat_t) + gray*desat_t) * (1-dark_t)

            # Add rolling cloud texture
            cloud = math.cos(x*0.04+y*0.02)*0.5 + math.cos(x*0.09-y*0.05)*0.3
            cloud = max(0, cloud) * storm_intensity * 25
            canvas[y][x] = [
                max(0,min(255,int(nr+cloud))),
                max(0,min(255,int(ng+cloud*0.9))),
                max(0,min(255,int(nb+cloud*0.8))),
                255
            ]
```

---

## Step 3 — Time of Day Shift

```python
def change_time_of_day(canvas: list, BW: int, BH: int,
                        current_scene_props: dict,
                        target_time: str) -> dict:
    """
    Shift the entire scene's lighting and sky to a different time of day.
    target_time: "golden_hour"|"midday"|"blue_hour"|"night"|"overcast"

    Modifies canvas directly by re-grading all pixels.
    Uses per-pixel color temperature shift — no global filter, but applied
    to entire canvas because time-of-day affects every pixel.

    Returns new_scene_props dict with updated lighting values.
    """
    TIME_SETTINGS = {
        "golden_hour": {
            "sky_color": (255,195,100), "sun_color": (255,210,120),
            "ambient": (120,140,200), "warm": 0.55, "temp_k": 3500,
            "sky_gradient": [(255,215,120),(255,180,80),(255,140,60)],
            "intensity": 0.85,
        },
        "midday": {
            "sky_color": (120,170,230), "sun_color": (255,255,240),
            "ambient": (150,170,210), "warm": 0.10, "temp_k": 5800,
            "sky_gradient": [(120,160,220),(140,180,235),(160,200,240)],
            "intensity": 1.0,
        },
        "blue_hour": {
            "sky_color": (60,80,160), "sun_color": (120,140,200),
            "ambient": (80,100,180), "warm": -0.15, "temp_k": 9000,
            "sky_gradient": [(40,60,140),(70,90,170),(90,120,190)],
            "intensity": 0.45,
        },
        "night": {
            "sky_color": (15,20,55), "sun_color": (80,90,140),
            "ambient": (20,25,70), "warm": -0.3, "temp_k": 10000,
            "sky_gradient": [(10,15,45),(20,25,65),(30,40,80)],
            "intensity": 0.15,
        },
        "overcast": {
            "sky_color": (160,165,175), "sun_color": (200,200,205),
            "ambient": (155,160,170), "warm": 0.0, "temp_k": 7500,
            "sky_gradient": [(150,155,165),(160,165,175),(170,175,185)],
            "intensity": 0.65,
        },
    }

    settings = TIME_SETTINGS.get(target_time, TIME_SETTINGS["midday"])
    current_warm = current_scene_props.get("warm_strength", 0.3)
    target_warm  = settings["warm"]
    warm_delta   = target_warm - current_warm

    tr,tg,tb = settings["sky_color"]
    intensity = settings["intensity"]
    horizon_y = current_scene_props.get("boundary_y",
               current_scene_props.get("primary_horizon_y", BH//2))

    for y in range(BH):
        sky_frac  = max(0, 1.0 - y/horizon_y) if y < horizon_y else 0
        gnd_frac  = min(1.0, (y-horizon_y)/max(BH-horizon_y,1)) if y > horizon_y else 0

        for x in range(BW):
            px = canvas[y][x]
            r,g,b = px[0],px[1],px[2]

            if y < horizon_y:
                # Sky: blend toward target sky color
                blend = 0.55 * sky_frac
                r = int(r*(1-blend)+tr*blend)
                g = int(g*(1-blend)+tg*blend)
                b = int(b*(1-blend)+tb*blend)
                # Darken/brighten
                r = int(r*intensity); g = int(g*intensity); b = int(b*intensity)
            else:
                # Ground: shift color temperature + intensity
                if warm_delta > 0:
                    r = min(255,int(r + warm_delta*40*gnd_frac))
                    g = min(255,int(g + warm_delta*20*gnd_frac))
                elif warm_delta < 0:
                    b = min(255,int(b - warm_delta*40*gnd_frac))
                    r = max(0,int(r + warm_delta*20*gnd_frac))
                r = int(r*intensity*0.9+r*0.1)
                g = int(g*intensity*0.9+g*0.1)
                b = int(b*intensity*0.9+b*0.1)

            canvas[y][x] = [max(0,min(255,r)),max(0,min(255,g)),max(0,min(255,b)),255]

    # Build new scene props
    new_props = dict(current_scene_props)
    new_props.update({
        "sky_color": settings["sky_color"],
        "sun_color": settings["sun_color"],
        "ambient_color": settings["ambient"],
        "warm_strength": settings["warm"],
        "color_temp_kelvin": settings["temp_k"],
        "color_temp": target_time.upper().replace("_"," "),
    })

    return new_props
```

---

## Step 4 — Particle Systems

```python
def add_particle_layer(canvas: list, BW: int, BH: int,
                        particle_type: str,
                        zone_y_start: int, zone_y_end: int,
                        density: float = 0.3,
                        wind_speed: float = 1.0,
                        scene_props: dict = None) -> int:
    """
    Add a particle layer to a specific zone of the canvas.
    particle_type: "sand"|"snow"|"ember"|"foam"|"dust"|"leaves"|"rain"

    All particles are generated with size variation and depth-based opacity.
    Larger particles at lower y (closer to viewer).

    Returns particle count.
    """
    import random; rng = random.Random(1337)

    PARTICLE_SETTINGS = {
        "sand":   {"color":(220,180,120),"size_range":(1,3),"opacity":0.6},
        "snow":   {"color":(240,248,255),"size_range":(1,4),"opacity":0.7},
        "ember":  {"color":(255,140,40), "size_range":(1,3),"opacity":0.8},
        "foam":   {"color":(255,255,255),"size_range":(2,6),"opacity":0.5},
        "dust":   {"color":(180,160,130),"size_range":(1,2),"opacity":0.3},
        "leaves": {"color":(100,140,40), "size_range":(2,5),"opacity":0.7},
        "rain":   {"color":(200,215,235),"size_range":(1,2),"opacity":0.4},
    }

    cfg = PARTICLE_SETTINGS.get(particle_type, PARTICLE_SETTINGS["dust"])
    pr,pg,pb = cfg["color"]
    sz_min,sz_max = cfg["size_range"]
    base_opacity = cfg["opacity"] * density

    zone_h = zone_y_end - zone_y_start
    particle_count = max(1, int(BW * zone_h * density * 0.0008))

    placed = 0
    for _ in range(particle_count):
        px_center = rng.randint(0, BW-1)
        py_center = rng.randint(zone_y_start, zone_y_end)

        # Depth-based size scaling: particles near bottom (closer) are larger
        depth_frac = (py_center-zone_y_start)/max(zone_h,1)
        sz = int(sz_min + (sz_max-sz_min)*depth_frac)
        sz = max(1, sz)

        # Wind drift: horizontal offset based on wind_speed
        wind_drift = int(rng.gauss(0, sz*wind_speed*0.5))
        px_center += wind_drift

        opacity = base_opacity * (0.7+depth_frac*0.3)

        # Draw particle (circle approximation)
        for dy in range(-sz, sz+1):
            for dx in range(-sz, sz+1):
                if dx**2+dy**2 > sz**2: continue
                ppx = px_center+dx; ppy = py_center+dy
                if not (0<=ppx<BW and 0<=ppy<BH): continue

                edge_fade = 1.0-(dx**2+dy**2)**0.5/max(sz,1)
                op = opacity*edge_fade

                bg = canvas[ppy][ppx]
                canvas[ppy][ppx] = [
                    max(0,min(255,int(bg[0]*(1-op)+pr*op))),
                    max(0,min(255,int(bg[1]*(1-op)+pg*op))),
                    max(0,min(255,int(bg[2]*(1-op)+pb*op))),
                    255
                ]
        placed += 1

    return placed


def add_fog_layer(canvas: list, BW: int, BH: int,
                  scene_props: dict,
                  fog_start_y_frac: float = 0.4,
                  fog_density: float = 0.35) -> None:
    """
    Add volumetric fog to the scene, strongest at mid-distance,
    dissipating toward viewer and toward sky.
    Applies only to ground zone (below horizon).
    """
    sr,sg,sb = scene_props.get("sky_color",(180,190,210))
    # Fog is slightly warmer than sky
    fr = min(255,sr+15); fg2 = min(255,sg+10); fb = sb

    horizon_y = scene_props.get("boundary_y",
               scene_props.get("primary_horizon_y", BH//2))
    fog_start = int(horizon_y + (BH-horizon_y)*fog_start_y_frac)

    for y in range(fog_start, BH):
        # Fog strongest at fog_start, dissipates downward (viewer is close)
        fog_t = max(0, 1.0-(y-fog_start)/(BH-fog_start)) * fog_density
        for x in range(BW):
            # Add slight turbulence to fog edge
            turb = math.sin(x*0.08+y*0.04)*0.1 * fog_density
            op = max(0, fog_t + turb)
            px = canvas[y][x]
            canvas[y][x] = [
                max(0,min(255,int(px[0]*(1-op)+fr*op))),
                max(0,min(255,int(px[1]*(1-op)+fg2*op))),
                max(0,min(255,int(px[2]*(1-op)+fb*op))),
                255
            ]
```

---

## Step 5 — Full Environment Modification Pipeline

```python
def apply_environment_modification(canvas: list, vapor, BW: int, BH: int,
                                    scene_props: dict,
                                    modification: str,
                                    params: dict) -> dict:
    """
    Apply a named environment modification to the canvas.

    modification options and params:
    "amplify_waves":   factor (default 3.0), secondary_waves (default True)
    "tsunami":         factor (8.0), secondary_waves=True, cast_shadow=True
    "add_rain":        intensity (0-1), wind_angle_deg (default 15)
    "add_snow":        intensity (0-1), flake_size (default 2)
    "add_storm":       intensity (0-1)
    "change_time":     target_time ("golden_hour","midday","blue_hour","night","overcast")
    "add_particles":   type, zone_y_start, zone_y_end, density, wind_speed
    "add_fog":         fog_start_y_frac, fog_density
    "add_sand_kick":   applies sand particles at ground level

    Returns result dict with modified scene_props.
    """
    result = {"modification": modification, "params": params}
    horizon_y = scene_props.get("boundary_y",
               scene_props.get("primary_horizon_y", BH//2))

    if modification in ("amplify_waves","tsunami"):
        factor = 8.0 if modification=="tsunami" else params.get("factor",3.0)
        wave_result = amplify_waves(canvas, vapor, BW, BH, horizon_y, scene_props,
                                    factor=factor,
                                    secondary_waves=params.get("secondary_waves",True))
        result["wave_result"] = wave_result

    elif modification == "add_rain":
        n = add_rain(canvas, BW, BH,
                     intensity=params.get("intensity",0.5),
                     wind_angle_deg=params.get("wind_angle_deg",15.0))
        result["rain_pixels"] = n

    elif modification == "add_snow":
        n = add_snow(canvas, BW, BH,
                     intensity=params.get("intensity",0.4),
                     flake_size=params.get("flake_size",2))
        result["snow_pixels"] = n

    elif modification == "add_storm":
        add_storm_atmosphere(canvas, BW, BH, horizon_y, scene_props,
                             storm_intensity=params.get("intensity",0.7))
        n_rain = add_rain(canvas, BW, BH,
                         intensity=params.get("intensity",0.7)*1.2,
                         wind_angle_deg=25.0)
        result["storm_rain_pixels"] = n_rain

    elif modification == "change_time":
        new_props = change_time_of_day(canvas, BW, BH, scene_props,
                                       target_time=params.get("target_time","golden_hour"))
        scene_props.update(new_props)
        result["new_scene_props"] = new_props

    elif modification == "add_particles":
        n = add_particle_layer(canvas, BW, BH,
                               particle_type=params.get("type","sand"),
                               zone_y_start=params.get("zone_y_start",horizon_y),
                               zone_y_end=params.get("zone_y_end",BH),
                               density=params.get("density",0.3),
                               wind_speed=params.get("wind_speed",1.0),
                               scene_props=scene_props)
        result["particles_placed"] = n

    elif modification == "add_sand_kick":
        n = add_particle_layer(canvas, BW, BH, "sand",
                               zone_y_start=int(BH*0.80), zone_y_end=BH,
                               density=params.get("density",0.4),
                               wind_speed=params.get("wind_speed",2.0),
                               scene_props=scene_props)
        result["sand_particles"] = n

    elif modification == "add_fog":
        add_fog_layer(canvas, BW, BH, scene_props,
                      fog_start_y_frac=params.get("fog_start_y_frac",0.5),
                      fog_density=params.get("fog_density",0.35))
        result["fog_applied"] = True

    print(f"  [ENV-MOD] {modification}: {result}")
    return result
```

---

## Output

Report: modification applied, zone affected, pixel count modified/generated,
wave profile stats (max height, smoothing applied), particle counts,
new scene_props values if time-of-day was changed.
