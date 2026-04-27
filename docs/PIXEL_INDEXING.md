# vapor-idx — Pixel and Image Indexing Guide

## Overview

vapor-idx can index image data at the pixel level, treating each pixel as a typed
record with spatial coordinates, colour channels, and relationships to its
neighbours. This enables image understanding without any ML model — Claude traverses
the structured pixel index and applies its own semantic reasoning.

The key insight: a pixel is structurally identical to a mesh vertex. Both have
spatial coordinates (x, y vs x, y, z), both have properties (colour channels vs
normal vectors), and both connect to neighbours via relationships. The same indexing
patterns apply to both.

---

## The pixel schema

A minimal pixel schema for a greyscale or colour image:

```typescript
import { createVapor } from 'vapor-idx';

const vapor = createVapor({
  types: {
    Pixel: {
      fields: {
        // Spatial position — range-indexed for spatial queries
        x:         { type: 'number', index: 'range' },
        y:         { type: 'number', index: 'range' },
        // Colour channels (0–255) — range-indexed for colour queries
        r:         { type: 'number', index: 'range' },
        g:         { type: 'number', index: 'range' },
        b:         { type: 'number', index: 'range' },
        a:         { type: 'number', index: 'range' },
        // Derived properties — computed during indexing
        brightness:{ type: 'number', index: 'range' },   // (r+g+b)/3
        edgeScore: { type: 'number', index: 'range' },   // gradient magnitude
        // Region label — assigned after region detection
        region:    { type: 'string', index: 'exact'  },
      },
      relationships: {
        // 4-connectivity (N/E/S/W) or 8-connectivity (diagonals too)
        ADJACENT_TO: {
          targetTypes: ['Pixel'],
          directed:    false,
          cardinality: 'many-to-many',
        },
        // Region membership
        BELONGS_TO: {
          targetTypes: ['Region'],
          directed:    true,
          cardinality: 'many-to-one',
        },
      },
    },
    Region: {
      fields: {
        label:      { type: 'string', index: 'keyword' },
        area:       { type: 'number', index: 'range'   },
        centerX:    { type: 'number', index: 'range'   },
        centerY:    { type: 'number', index: 'range'   },
        minR:       { type: 'number', index: 'range'   },
        maxR:       { type: 'number', index: 'range'   },
        avgBright:  { type: 'number', index: 'range'   },
      },
      relationships: {
        BORDERS:    { targetTypes: ['Region'], directed: false, cardinality: 'many-to-many' },
      },
    },
  },
});
```

---

## Indexing from raw pixel data

### TypeScript — from a flat pixel array (RGBA)

```typescript
// pixelData: Uint8ClampedArray from Canvas API (ImageData.data)
// width, height: image dimensions
function indexPixels(
  vapor:     ReturnType<typeof createVapor>,
  pixelData: Uint8ClampedArray,
  width:     number,
  height:    number
): Map<string, string> {  // maps "x,y" → record ID
  const idGrid = new Map<string, string>();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const r = pixelData[offset];
      const g = pixelData[offset + 1];
      const b = pixelData[offset + 2];
      const a = pixelData[offset + 3];
      const brightness = (r + g + b) / 3;

      const id = vapor.store('Pixel', { x, y, r, g, b, a, brightness, edgeScore: 0, region: '' });
      idGrid.set(`${x},${y}`, id);
    }
  }

  // Create adjacency relationships (4-connectivity)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const id = idGrid.get(`${x},${y}`)!;
      if (x + 1 < width)  vapor.relate(id, 'ADJACENT_TO', idGrid.get(`${x+1},${y}`)!);
      if (y + 1 < height) vapor.relate(id, 'ADJACENT_TO', idGrid.get(`${x},${y+1}`)!);
    }
  }

  return idGrid;
}
```

### Python — from a PIL/Pillow image

```python
from vapor_idx import create_vapor, QueryOptions, FieldFilter, TraversalOptions

def index_pixels(vapor, image) -> dict:
    """
    Index pixels from a PIL Image into vapor.
    Returns a dict mapping (x, y) tuples to record IDs.
    """
    pixels = image.load()
    width, height = image.size
    id_grid: dict[tuple[int, int], str] = {}

    for y in range(height):
        for x in range(width):
            pixel = pixels[x, y]
            if isinstance(pixel, int):  # greyscale
                r = g = b = pixel
                a = 255
            elif len(pixel) == 4:
                r, g, b, a = pixel
            else:
                r, g, b = pixel
                a = 255
            brightness = (r + g + b) / 3
            record_id = vapor.store('Pixel', {
                'x': x, 'y': y,
                'r': r, 'g': g, 'b': b, 'a': a,
                'brightness': brightness, 'edge_score': 0, 'region': '',
            })
            id_grid[(x, y)] = record_id

    # 4-connectivity adjacency
    for y in range(height):
        for x in range(width):
            pid = id_grid[(x, y)]
            if x + 1 < width:
                vapor.relate(pid, 'ADJACENT_TO', id_grid[(x + 1, y)])
            if y + 1 < height:
                vapor.relate(pid, 'ADJACENT_TO', id_grid[(x, y + 1)])

    return id_grid
```

---

## Querying pixels

### Find all dark pixels (brightness < 50)

```typescript
const darkPixels = vapor.query({
  type:  'Pixel',
  where: { field: 'brightness', op: 'lt', value: 50 },
});
```

### Find pixels in a spatial region (bounding box)

```typescript
const topLeftQuadrant = vapor.query({
  type:  'Pixel',
  where: [
    { field: 'x', op: 'lt', value: width / 2 },
    { field: 'y', op: 'lt', value: height / 2 },
  ],
  logic: 'AND',
});
```

### Find highly saturated red pixels

```typescript
const redPixels = vapor.query({
  type:  'Pixel',
  where: [
    { field: 'r', op: 'gt', value: 200 },
    { field: 'g', op: 'lt', value: 80  },
    { field: 'b', op: 'lt', value: 80  },
  ],
  logic: 'AND',
});
```

### Find edge pixels (high edge score)

```typescript
const edgePixels = vapor.query({
  type:  'Pixel',
  where: { field: 'edgeScore', op: 'gt', value: 50 },
  orderBy: { field: 'edgeScore', direction: 'desc' },
  limit: 1000,
});
```

---

## Computing edge scores

Edge detection without ML: compute the Sobel gradient magnitude for each pixel,
then update the `edgeScore` field via `vapor.update()`.

```typescript
function computeEdgeScores(
  vapor:  ReturnType<typeof createVapor>,
  idGrid: Map<string, string>,
  width:  number,
  height: number
): void {
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const getBrightness = (dx: number, dy: number): number => {
        const rec = vapor.get(idGrid.get(`${x + dx},${y + dy}`)!);
        return (rec?.data as any).brightness as number;
      };

      // Sobel operator
      const gx = (
        -1 * getBrightness(-1, -1) + 1 * getBrightness(1, -1) +
        -2 * getBrightness(-1,  0) + 2 * getBrightness(1,  0) +
        -1 * getBrightness(-1,  1) + 1 * getBrightness(1,  1)
      );
      const gy = (
        -1 * getBrightness(-1, -1) - 2 * getBrightness(0, -1) - 1 * getBrightness(1, -1) +
         1 * getBrightness(-1,  1) + 2 * getBrightness(0,  1) + 1 * getBrightness(1,  1)
      );
      const edgeScore = Math.sqrt(gx * gx + gy * gy);

      vapor.update(idGrid.get(`${x},${y}`)!, { edgeScore });
    }
  }
}
```

---

## Traversing connected regions

Starting from a seed pixel, BFS traversal follows `ADJACENT_TO` edges to find
the connected component — pixels that are spatially adjacent and similar in colour.

```typescript
function findConnectedRegion(
  vapor:       ReturnType<typeof createVapor>,
  seedId:      string,
  maxBrightnessDiff: number = 30
): string[] {
  const result = vapor.traverse({
    from:         seedId,
    relationship: 'ADJACENT_TO',
    direction:    'both',
    depth:        1000,  // large enough to span the whole image
    filter: {
      // Only traverse to pixels with similar brightness
      // (This filter is applied by Claude's reasoning in a skill context)
      type: 'Pixel',
    },
  });

  return result.records.map(r => r.id);
}
```

---

## Reconstructing a PNG from indexed data

Once the pixel index has been queried and modified (e.g. after region detection or
colour transformation), reconstruct the image as a flat pixel array:

```typescript
// Reconstruct pixel buffer from vapor index
function reconstructPixelBuffer(
  vapor:  ReturnType<typeof createVapor>,
  width:  number,
  height: number
): Uint8ClampedArray {
  const buffer = new Uint8ClampedArray(width * height * 4);

  // Query all pixels ordered by position
  const allPixels = vapor.query({
    type: 'Pixel',
    orderBy: { field: 'y', direction: 'asc' },
  });

  for (const rec of allPixels.records) {
    const { x, y, r, g, b, a } = rec.data as any;
    const offset = (y * width + x) * 4;
    buffer[offset]     = r;
    buffer[offset + 1] = g;
    buffer[offset + 2] = b;
    buffer[offset + 3] = a;
  }

  return buffer;
}

// In a browser skill: write to Canvas
function writeToCanvas(canvas: HTMLCanvasElement, buffer: Uint8ClampedArray, width: number, height: number): void {
  const ctx = canvas.getContext('2d')!;
  const imageData = new ImageData(buffer, width, height);
  ctx.putImageData(imageData, 0, 0);
}
```

### Python PNG reconstruction

```python
from PIL import Image

def reconstruct_image(vapor, width: int, height: int) -> Image.Image:
    """Reconstruct a PIL Image from the pixel index."""
    from vapor_idx import QueryOptions
    
    img = Image.new('RGBA', (width, height))
    pixels = img.load()
    
    all_pixels = vapor.query(QueryOptions(type='Pixel'))
    
    for rec in all_pixels.records:
        x = int(rec.data['x'])
        y = int(rec.data['y'])
        r = int(rec.data['r'])
        g = int(rec.data['g'])
        b = int(rec.data['b'])
        a = int(rec.data.get('a', 255))
        pixels[x, y] = (r, g, b, a)
    
    return img
```

---

## Memory guidance

A 512×512 image has 262,144 pixels. With 9 declared fields and range indexes on 7
of them, each pixel record consumes roughly:

- Record object: ~200 bytes
- Range index entries (7 fields × 1 entry): ~7 × 48 bytes = ~336 bytes
- Relationship edges (avg 2 per pixel for 4-connectivity): ~2 × 200 bytes = ~400 bytes

Total per pixel: ~936 bytes → **~245 MB for a 512×512 image.**

For large images, consider:
- Downsampling before indexing (e.g. 128×128 for region detection)
- Using `index: 'none'` for fields you don't query (saves range index memory)
- Processing in tiles and destroying/rebuilding the index per tile
- Only indexing a representative sample (e.g. every 4th pixel)

Call `vapor.stats()` to see the current memory estimate.

---

## Cross-modal: pixels → SVG regions

After region detection, emit an SVG that describes the detected regions:

```typescript
function pixelIndexToSVG(
  vapor:  ReturnType<typeof createVapor>,
  width:  number,
  height: number
): string {
  const regions = vapor.query({ type: 'Region' });
  
  const rects = regions.records.map(r => {
    const { centerX, centerY, area, label } = r.data as any;
    const size = Math.sqrt(area);
    return `  <rect x="${centerX - size/2}" y="${centerY - size/2}" width="${size}" height="${size}" fill="none" stroke="red" stroke-width="2">
    <title>${label}</title>
  </rect>`;
  }).join('\n');

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
${rects}
</svg>`;
}
```
