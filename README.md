# sdxf.js

Single-file JavaScript library that **writes AutoCAD R2000 (AC1015) DXF** files.
It is built for drafting automation: geometry driven by engineering calculations,
blocks with attributes, parametric ("dynamic") blocks, hatches and dimensions.
It works in Node and the browser and has no dependencies.

```js
const { Drawing, Layer, LwPolyLine, Hatch, LinearDimension, DimStyle } = require('./sdxf.js');

const d = new Drawing({ units: 'mm', dimstyles: [new DimStyle({ name: '1to20', scale: 20 })] });
const slab = new LwPolyLine([[0, 0], [3000, 0], [3000, 250], [0, 250]], { flag: 1 });
d.append(slab);
d.append(new Hatch(slab, { pattern: 'ANSI31', scale: 10 }));
d.append(new LinearDimension([0, 0], [3000, 0], [0, -300], { dimstyle: '1to20' }));
require('fs').writeFileSync('slab.dxf', d.toString());
```

See `examples/` for complete scripts:
- `examples/beam_section.js`: an RC section drawn from the design inputs.
- `examples/dynamic_blocks.js`: beams sized from a list of spans.

## Tests

```
npm test               # JS assertions + DXF validation (needs: pip install ezdxf)
npm run test:render    # also renders every test drawing to tests/out/*.png
```

The test runner does three things:
1. Runs the JS assertions.
2. Writes one DXF per test to `tests/out/`.
3. Checks every file with `tests/check_dxf.py`. That script checks for unique handles, that every owner handle exists, that every block has a block record, and that `$HANDSEED` is valid. It then runs ezdxf's `audit()`, which must report no errors and no fixes.

## API overview

### Drawing
`new Drawing({ units, ltscale, layers, linetypes, styles, dimstyles, blocks, extmin, extmax })`

| Option | What it does |
|---|---|
| `units` | `'mm' \| 'cm' \| 'm' \| 'km' \| 'in' \| 'ft'`. Sets `$INSUNITS` and `$MEASUREMENT`. |
| `ltscale` | Global linetype scale (`$LTSCALE`). |
| `extmin` / `extmax` | Leave as `null` and they are calculated from the entities. The drawing then opens zoomed to fit. |

- Blocks referenced by an `Insert` are added automatically.
- Layers used by entities are created automatically.
- Preset linetypes are added automatically when referenced.
- `d.extents()` returns `[[xmin, ymin], [xmax, ymax]]`.

### Common entity options
Every entity accepts these options:
- `layer`, `color` (ACI), `trueColor` (`[r,g,b]` or `0xRRGGBB`)
- `lineType`, `lineTypeScale`, `lineWeight`
- `thickness`, `extrusion`
- `xdata: { APPNAME: [[1000, 'text'], [1040, 1.5]] }`. The APPIDs are registered for you.

### Entities
| Class | Notes |
|---|---|
| `Line(points)` | |
| `LwPolyLine(points, { flag, bulge, bulges, width })` | `flag: 1` closes it. |
| `Circle(center, r)`, `Arc(center, r, start, end)` | Angles in degrees. |
| `Ellipse(center, majorAxis, ratio, { start, end })` | Params in radians. A ratio above 1 is normalised. |
| `Spline(controlPoints, { degree })`, `Spline.fromFitPoints(points)` | Clamped B-spline; `fromFitPoints` passes through every point. |
| `Point`, `Solid` | |
| `Text(text, point, { height, rotation, align })` | `align`: `LEFT`, `CENTER`, `MIDDLE_CENTER`, `TOP_RIGHT`, and so on. |
| `MText(text, point, { height, width, attach, lineSpacing })` | `\n` starts a new line. |
| `Hatch(boundary \| [outer, ...holes], { pattern, scale, angle })` | Patterns: `SOLID`, `ANSI31`, `ANSI32`, `ANSI37`, `NET`, `DOTS`, `EARTH`, or `{ name, lines }`. A boundary can be an `LwPolyLine`; its arcs are kept. |
| `Leader(points, text, { dimstyle, height })` | Arrow at the first point, MText at the last. |
| `Insert(block, point, { rotation, xscale, yscale, attributes, params, rows, cols, rowSpacing, colSpacing })` | `rows`/`cols` make a grid of block references (MINSERT). |

### Dimensions
These match ezdxf's argument order where possible:

| Class | Notes |
|---|---|
| `LinearDimension(p1, p2, base, { angle })` | `angle`: 0 = horizontal, 90 = vertical. |
| `AlignedDimension(p1, p2, distance)` | |
| `RadiusDimension(center, r, { angle })` | Text: `R400`. |
| `DiameterDimension(center, r, { angle })` | Text: `Ø800`. |
| `AngularDimension(vertex, p1, p2, { radius })` | Measured anticlockwise from p1 to p2. |

- `text: 'd = <>'` overrides the text; `<>` is replaced by the measured value.
- The script draws each dimension's lines and text itself, so it renders the same everywhere.

`DimStyle({ name, scale, textHeight, arrowSize, tickSize, gap, decimals, angleDecimals, measureScale, suffix })`:
- `scale` is DIMSCALE. Use 50 for a 1:50 drawing in mm.
- `tickSize > 0` draws oblique ticks instead of arrows.

### Transforms and arrays
Every entity has these methods, which change it in place and can be chained:
- `copy()`
- `translate(dx, dy)`
- `rotate(deg, center)`
- `scale(factor, center)`
- `mirror(p1, p2)`. Mirrored text stays readable, like AutoCAD with MIRRTEXT = 0.

`arrayRect(entities, { rows, cols, rowSpacing, colSpacing })` and
`arrayPolar(entities, { count, center, angle, rotateItems })` return copies.

### Blocks and attributes
```js
const title = new Block('title', { entities: [
  new AttDef('drawing no', [10, 60, 0], { height: 20, prompt: 'Drawing number' }),
  new AttDef('rev', [10, 20, 0], { height: 20, defaultValue: 'A' }),
] });
d.append(new Insert(title, [5000, 0], { attributes: { 'drawing no': 'S-101' } }));
```
- `AttDef` flags: `invisible`, `constant`, `verify`, `preset`.
- `Insert` creates the attribute values and places them using its position, scale and rotation.
- An unknown attribute name throws an error listing the valid names.

### Parametric (dynamic) blocks
```js
const beam = new DynamicBlock('beam', { entities: [outline, mark] });
beam.addLinearParameter('length', [0, 0], [1000, 0], { min: 500, max: 6000, increment: 50 });
beam.addStretchAction('length', { frame: [[900, -10], [1100, 210]] });
beam.addMoveAction('length', { entities: [mark], multiplier: 0.5 });
d.append(new Insert(beam, [0, 0], { params: { length: 2337 } }));   // snaps to 2350
```

Parameters:

| Parameter | Settings |
|---|---|
| `addLinearParameter(name, base, end, opts)` | `min`, `max`, `increment`, `values`, `baseLocation: 'start' \| 'midpoint'`. |
| `addFlipParameter(name, base, end)` | |
| `addVisibilityStates({ PLAN: [...], ELEVATION: [...] }, { defaultState })` | |
| `addLookup('section', { UB254: { depth: 254, width: 146 }, ... })` | One key sets several parameters. |

Actions:

| Action | Settings |
|---|---|
| `addStretchAction(param, { frame, entities, grip, multiplier, angleOffset })` | |
| `addMoveAction(param, { entities, ... })` | |
| `addArrayAction(param, { entities, spacing, inclusive })` | Count = floor(value / spacing), like AutoCAD; `inclusive: true` adds one. |
| `addFlipAction(param, { entities })` | |

- **Variants:** each set of values becomes one ordinary block, named `NAME__PARAM-VALUE__...`, created once and reused.
- **Reading back:** the chosen values are stored on the block reference as XDATA under `SDXF_DYNBLOCK`. In ezdxf: `insert.get_xdata('SDXF_DYNBLOCK')`.
- **Not editable in AutoCAD:** the output does **not** contain AutoCAD's own dynamic-block objects (AcDbEvalGraph etc., which Autodesk doesn't document). The geometry is fixed when the file is written; there are no grips to drag in AutoCAD.

### Text encoding
R2000 DXF is not UTF-8. Non-ASCII characters (², °, Ø) are written as `\U+XXXX`, which AutoCAD decodes.
ezdxf's plain `readfile` leaves those codes as literal text. `%%c` (Ø), `%%d` (°) and `%%p` (±) work everywhere.

## Compared with ezdxf

ezdxf is a ~140k-line Python library that **reads, edits and writes** every DXF version.
sdxf.js only **writes** R2000 drawings, and is aimed at 2D drafting automation.

**Similar to ezdxf**
- Lines, polylines, arcs, circles, ellipses and splines.
- TEXT and MTEXT.
- Hatches: solid, standard patterns, holes and arcs.
- Blocks, block references with attributes, and grids of block references (MINSERT).
- XDATA.
- Layers, linetypes, lineweights and true colour.
- Linear, aligned, radius, diameter and angular dimensions, and leaders.
- Transforms and arrays.

**Beyond ezdxf:** parametric blocks with stretch, move, array, flip, visibility states and lookup tables.

**Missing, roughly smallest effort first**

| Feature | Effort |
|---|---|
| Groups, XLINE/RAY, WIPEOUT, ordinate dimensions | S |
| Paper-space layouts with viewports (drawing sheets), IMAGE references | M |
| MLEADER, TABLE, R12 output | M–L |
| 3D entities (3DFACE, MESH, polyface), ACIS solids | L |
| Reading and editing existing DXF files, other DXF versions, binary DXF | Very large (essentially ezdxf's core) |
| Rendering to SVG/PDF/PNG, font-based text measurement, geometry kernel | Very large |

**Reading and editing:** for that, use ezdxf from Python or a JS parser such as `dxf-parser`.
Parity on the writing side for 2D drafting is realistic; matching all of ezdxf is not a sensible goal for this project.
