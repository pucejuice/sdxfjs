// node tests/run.js [--render]
// Runs the JS assertions, writes one DXF per drawing test to tests/out/, then
// validates them with tests/check_dxf.py when python3 + ezdxf are available.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const X = require('../sdxf.js');
const {
  Drawing, Layer, LineType, DimStyle, Block, DynamicBlock, Insert, AttDef,
  Line, LwPolyLine, Circle, Arc, Ellipse, Spline, Point, Text, MText, Solid, Hatch, Leader,
  LinearDimension, AlignedDimension, RadiusDimension, DiameterDimension, AngularDimension,
  arrayRect, arrayPolar,
} = X;

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f));

const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const closePt = (a, b, msg) => { close(a[0], b[0], `${msg} x`); close(a[1], b[1], `${msg} y`); };
const throws = (fn, re) => assert.throws(fn, re);

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── Basics ────────────────────────────────────────────────────────────────────
test('basic_entities', () => {
  const d = new Drawing({ units: 'mm' });
  d.append(new Line([[0, 0, 0], [100, 50, 0]]));
  d.append(new LwPolyLine([[0, 0], [100, 0], [100, 50]], { flag: 1, bulges: [0, 0.5, 0] }));
  d.append(new Circle([50, 50, 0], 20, { thickness: 5 }));
  d.append(new Arc([0, 0, 0], 30, 0, 90, { trueColor: [255, 0, 0] }));
  d.append(new Point([10, 10, 0]));
  d.append(new Text('Hello ²°Ø', [0, -20, 0], { height: 5, align: 'MIDDLE_CENTER' }));
  d.append(new Solid([[0, 0], [10, 0], [0, 10], [10, 10]]));
  d.append(new Ellipse([200, 0, 0], [50, 0], 0.5));
  d.append(new Ellipse([200, 100, 0], [0, 20], 2, { start: 0, end: Math.PI }));
  d.append(Spline.fromFitPoints([[0, 100], [50, 150], [100, 120], [150, 160]]));
  const s = d.toString();
  assert.ok(!/[^\x00-\x7F]/.test(s), 'output is ASCII');
  assert.ok(s.includes('\\U+00B2'), 'superscript escaped');
  return d;
});

test('ellipse_ratio_normalised', () => {
  const e = new Ellipse([0, 0], [0, 20], 2);   // minor longer than major → swapped
  close(e.ratio, 0.5, 'ratio');
  closePt(e.majorAxis, [-40, 0], 'major axis');
});

test('linetypes_and_layers', () => {
  const d = new Drawing({ layers: [new Layer({ name: 'centre', lineType: 'CENTER', lineWeight: 25 })], ltscale: 5 });
  d.append(new Line([[0, 0], [100, 0]], { layer: 'CENTRE' }));
  d.append(new Line([[0, 10], [100, 10]], { lineType: 'DASHED', layer: 'NEWLAYER' }));
  d.toString();
  assert.ok(d.linetypes.some(l => l.name === 'CENTER') && d.linetypes.some(l => l.name === 'DASHED'));
  assert.ok(d.layers.some(l => l.name === 'NEWLAYER') && d.layers.some(l => l.name === '0'));
  throws(() => new Drawing({ entities: [new Line([[0, 0], [1, 1]], { lineType: 'WIGGLY' })] }).toString(), /WIGGLY/);
  return d;
});

// ── Transforms & arrays ───────────────────────────────────────────────────────
test('transforms', () => {
  const l = new Line([[10, 0, 0], [20, 0, 0]]).rotate(90);
  closePt(l.points[0], [0, 10], 'rotated line start');
  const shared = [5, 5, 0];
  const a = new Line([shared, [6, 6, 0]]), b = new Line([shared, [7, 7, 0]]);
  a.translate(100, 0);
  closePt(b.points[0], [5, 5], 'shared point not mutated');
  const arc = new Arc([0, 0, 0], 10, 0, 90).mirror([0, 0], [0, 1]);   // mirror about the y axis
  close(arc.startAngle, 90, 'mirrored arc start'); close(arc.endAngle, 180, 'mirrored arc end');
  const c = new Circle([10, 0, 0], 5).scale(2, [0, 0]);
  closePt(c.center, [20, 0], 'scaled centre'); close(c.radius, 10, 'scaled radius');
  const t = new Text('A', [10, 0, 0], { rotation: 0 }).mirror([0, 0], [0, 1]);
  close(t.rotation, 0, 'mirrored text stays readable'); closePt(t.point, [-10, 0], 'mirrored text point');
  const pl = new LwPolyLine([[0, 0], [10, 0]], { bulges: [0.5, 0] }).mirror([0, 0], [1, 0]);
  close(pl.bulges[0], -0.5, 'bulge flips');
  const blk = new Block('b', { entities: [new Line([[0, 0], [10, 0]])] });
  const ins = new Insert(blk, [0, 0, 0], { rotation: 30 }).mirror([0, 0], [0, 1]);
  close(ins.rotation, 150, 'mirrored insert rotation'); close(ins.yscale, -1, 'mirrored insert yscale');
  const copy = l.copy().translate(1, 1);
  assert.notStrictEqual(copy.points, l.points);
  throws(() => l.transform([2, 0, 0, 1, 0, 0]), /uniform/);

  const d = new Drawing();
  const tri = [new LwPolyLine([[100, 0], [120, 0], [110, 15]], { flag: 1 })];
  d.entities.push(...arrayPolar(tri, { count: 6, center: [0, 0] }));
  d.entities.push(...arrayRect([new Circle([0, 0, 0], 5)], { rows: 3, cols: 4, rowSpacing: 20, colSpacing: 30 }).map(e => e.translate(200, 0)));
  assert.strictEqual(d.entities.length, 18);
  closePt(d.entities[3].points[0], [-100, 0], 'polar copy at 180°');
  return d;
});

test('minsert_grid', () => {
  const bolt = new Block('bolt', { entities: [new Circle([0, 0, 0], 10)] });
  const d = new Drawing();
  const g = new Insert(bolt, [0, 0, 0], { rows: 2, cols: 3, rowSpacing: 60, colSpacing: 80 });
  d.append(g);
  const box = g._bbox();
  closePt(box[0], [-10, -10], 'grid min'); closePt(box[1], [170, 70], 'grid max');
  assert.ok(d.toString().includes('\n70\n3\n71\n2\n44\n80\n45\n60'));
  return d;
});

// ── Blocks & attributes ───────────────────────────────────────────────────────
test('attributes', () => {
  const title = new Block('title', { entities: [
    new LwPolyLine([[0, 0], [400, 0], [400, 100], [0, 100]], { flag: 1 }),
    new AttDef('drawing no', [10, 60, 0], { height: 20 }),
    new AttDef('rev', [10, 20, 0], { height: 20, defaultValue: 'A' }),
    new AttDef('const', [300, 20, 0], { height: 10, defaultValue: 'X', constant: true }),
  ] });
  const d = new Drawing();
  const ins = new Insert(title, [1000, 0, 0], { rotation: 90, attributes: { 'drawing no': 'S-101' } });
  d.append(ins);
  const at = ins._attribs();
  assert.deepStrictEqual(at.map(a => [a.tag, a.value]), [['DRAWING_NO', 'S-101'], ['REV', 'A']]);
  closePt(at[0].point, [940, 10], 'rotated attribute position');
  throws(() => new Insert(title, [0, 0], { attributes: { nope: 1 } }), /NOPE/);
  return d;
});

// ── Dynamic blocks ────────────────────────────────────────────────────────────
function beamBlock() {
  const outline = new LwPolyLine([[0, 0], [1000, 0], [1000, 200], [0, 200]], { flag: 1 });
  const mark = new AttDef('mark', [500, 100, 0], { defaultValue: 'B1', height: 50, align: 'MIDDLE_CENTER' });
  const hatch = new Hatch([[0, 0], [1000, 0], [1000, 200], [0, 200]], { pattern: 'ANSI31', scale: 5 });
  const dim = new LinearDimension([0, 0], [1000, 0], [0, -150]);
  const beam = new DynamicBlock('beam', { entities: [outline, mark, hatch, dim] });
  beam.addLinearParameter('length', [0, 0], [1000, 0], { min: 500, max: 6000, increment: 50 });
  beam.addLinearParameter('depth', [0, 0], [0, 200], { values: [150, 200, 300, 450] });
  beam.addStretchAction('length', { frame: [[900, -200], [1100, 250]] });
  beam.addMoveAction('length', { entities: [mark], multiplier: 0.5 });
  beam.addStretchAction('depth', { frame: [[-10, 190], [1100, 210]], entities: [outline, hatch] });
  return { beam, outline, mark };
}

test('dynamic_stretch', () => {
  const { beam } = beamBlock();
  const d = new Drawing();
  const ins = new Insert(beam, [0, 0, 0], { params: { length: 2337, depth: 420 } });
  d.append(ins);
  assert.deepStrictEqual(ins.params, { LENGTH: 2350, DEPTH: 450 });
  assert.strictEqual(ins.block.name, 'BEAM__LENGTH-2350__DEPTH-450');
  const [pl, mk, h] = ins.block.entities;
  closePt(pl.points[2], [2350, 450], 'stretched corner');
  closePt(mk.point, [1175, 100], 'moved mark');
  closePt(h.paths[0][0][2], [2350, 450], 'stretched hatch');
  assert.strictEqual(new Insert(beam, [0, 0]).block, beam, 'defaults use the base block');
  assert.strictEqual(new Insert(beam, [0, 0], { params: { length: 2340 } }).block, ins.block.source._variants.get('BEAM__LENGTH-2350__DEPTH-200') || new Insert(beam, [0, 0], { params: { length: 2340 } }).block);
  d.toString();
  close(ins.block.entities[3]._r.measurement, 2350, 'dimension follows the stretch');
  return d;
});

test('dynamic_lookup_visibility_flip_array', () => {
  // Door: width lookup, swing flip, plan/elevation visibility, hinges arrayed along height
  const leaf = new Line([[0, 0, 0], [0, 900, 0]]);
  const swing = new Arc([0, 0, 0], 900, 0, 90);
  const elev = new LwPolyLine([[0, 0], [900, 0], [900, 2100], [0, 2100]], { flag: 1 });
  const hinge = new Circle([20, 300, 0], 10);
  const door = new DynamicBlock('door', { entities: [leaf, swing, elev, hinge] });
  door.addLinearParameter('width', [0, 0], [900, 0]);
  door.addLinearParameter('height', [0, 0], [0, 2100], { min: 1800, max: 2400 });
  door.addFlipParameter('hand', [450, 0], [450, 100]);
  door.addVisibilityStates({ plan: [leaf, swing], elevation: [elev, hinge] });
  door.addLookup('size', { D826: { width: 826 }, D926: { width: 926, height: 2040 } });
  door.addStretchAction('width', { frame: [[800, -10], [1000, 2200]], entities: [elev] });
  door.addArrayAction('height', { entities: [hinge], spacing: 700 });
  door.addFlipAction('hand', { entities: [leaf, swing] });

  const plan = new Insert(door, [0, 0, 0], { params: { size: 'd926', hand: true } });
  assert.deepStrictEqual(plan.params, { WIDTH: 926, HEIGHT: 2040, HAND: true, VISIBILITY: 'PLAN' });
  assert.deepStrictEqual(plan.choices, { SIZE: 'D926' });
  const [l, sw] = plan.block.entities;
  assert.strictEqual(plan.block.entities.length, 2, 'plan shows leaf + swing only');
  closePt(l.points[0], [900, 0], 'flipped leaf');
  close(sw.startAngle, 90, 'flipped swing start'); close(sw.endAngle, 180, 'flipped swing end');

  const el = new Insert(door, [2000, 0, 0], { params: { visibility: 'Elevation', width: 826, height: 2100 } });
  const ents = el.block.entities;
  assert.strictEqual(ents.length, 1 + 3, 'outline + floor(2100 / 700) = 3 hinges');
  closePt(ents[0].points[1], [826, 0], 'stretched elevation');
  closePt(ents[3].center, [20, 1700], 'last hinge');
  const studs = new DynamicBlock('studs', { entities: [new Line([[0, 0, 0], [0, 100, 0]])] });
  studs.addLinearParameter('length', [0, 0], [600, 0]);
  studs.addArrayAction('length', { entities: studs.entities, spacing: 600, inclusive: true });
  assert.strictEqual(new Insert(studs, [0, 0], { params: { length: 3000 } }).block.entities.length, 6, 'inclusive: studs at 0..3000');
  throws(() => new Insert(door, [0, 0], { params: { size: 'D999' } }), /D999/);
  throws(() => new Insert(door, [0, 0], { params: { size: 'D826', width: 900 } }), /conflicts/);
  throws(() => new Insert(door, [0, 0], { params: { visibility: 'section' } }), /no state 'section'/);

  const d = new Drawing();
  d.append(plan); d.append(el);
  d.append(new Insert(door, [4000, 0, 0], { params: { size: 'D826' } }));
  return d;
});

// ── Annotation ────────────────────────────────────────────────────────────────
test('hatch_mtext', () => {
  const d = new Drawing({ units: 'mm' });
  const slab = new LwPolyLine([[0, 0], [2000, 0], [2000, 200], [0, 200]], { flag: 1 });
  d.append(slab);
  for (const [i, pattern] of ['ANSI31', 'ANSI32', 'ANSI37', 'NET', 'DOTS', 'EARTH', 'SOLID'].entries())
    d.append(new Hatch([[i * 300, 400], [i * 300 + 250, 400], [i * 300 + 250, 650], [i * 300, 650]], { pattern, scale: 5 }));
  d.append(new Hatch([[[0, 1000], [500, 1000], [500, 1500], [0, 1500]], [[200, 1200], [300, 1200], [300, 1300], [200, 1300]]], { pattern: 'SOLID' }));
  d.append(new Hatch(new LwPolyLine([[1000, 1250], [1200, 1250]], { flag: 1, bulge: 1 }), { pattern: 'SOLID' }));
  d.append(new MText('NOTES:\nLine 2 ' + 'x'.repeat(600), [0, -100, 0], { height: 20, width: 1500 }));
  throws(() => new Hatch([[0, 0], [1, 1]]), /3 points/);
  throws(() => new Hatch([[0, 0], [1, 0], [1, 1]], { pattern: 'NOPE' }), /NOPE/);
  assert.ok(d.toString().split('\n3\n').length > 2, 'long MText chunked into group 3');
  return d;
});

test('dimensions_and_leaders', () => {
  const d = new Drawing({ dimstyles: [new DimStyle({ name: 'S50', scale: 50, tickSize: 2 })] });
  const dims = [
    new LinearDimension([0, 0], [2350, 0], [0, -800], { dimstyle: 'S50' }),
    new LinearDimension([2350, 0], [2350, 200], [2800, 0], { angle: 90, dimstyle: 'S50' }),
    new AlignedDimension([3000, 0], [4000, 500], 300, { dimstyle: 'S50', text: 'L = <>' }),
    new RadiusDimension([5000, 0], 400, { dimstyle: 'S50' }),
    new DiameterDimension([6500, 0], 400, { angle: 30, dimstyle: 'S50' }),
    new AngularDimension([7500, 0], [8500, 0], [8000, 800], { dimstyle: 'S50', radius: 600 }),
  ];
  dims.forEach(x => d.append(x));
  d.append(new Leader([[5000, 400], [5400, 900], [5800, 900]], 'T16 @ 200\nB1', { dimstyle: 'S50' }));
  d.append(new Leader([[9000, -400], [8800, -900], [8400, -900]], 'LEFT', { dimstyle: 'S50' }));
  d.toString();
  const m = dims.map(x => x._r.measurement);
  close(m[0], 2350, 'linear'); close(m[1], 200, 'vertical'); close(m[2], Math.hypot(1000, 500), 'aligned');
  close(m[3], 400, 'radius'); close(m[4], 800, 'diameter'); close(m[5], Math.atan2(800, 500), 'angle');
  const texts = dims.map(x => x._block.entities.find(e => e instanceof Text).text);
  assert.deepStrictEqual(texts, ['2350', '200', 'L = 1118', 'R400', '%%c800', '58%%d']);
  return d;
});

// ── Run ───────────────────────────────────────────────────────────────────────
let failed = 0;
for (const t of tests) {
  try {
    const d = t.fn();
    if (d instanceof Drawing) fs.writeFileSync(path.join(OUT, `${t.name}.dxf`), d.toString());
    console.log(`ok   ${t.name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}\n     ${e.stack.split('\n').slice(0, 3).join('\n     ')}`);
  }
}
// examples must keep working
for (const ex of fs.readdirSync(path.join(__dirname, '..', 'examples'))) {
  try {
    execFileSync('node', [path.join(__dirname, '..', 'examples', ex)], { cwd: OUT, stdio: 'pipe' });
    console.log(`ok   examples/${ex}`);
  } catch (e) { failed++; console.log(`FAIL examples/${ex}\n     ${String(e.stderr).split('\n')[0]}`); }
}
console.log(`${tests.length - failed + fs.readdirSync(path.join(__dirname, '..', 'examples')).length}/${tests.length + fs.readdirSync(path.join(__dirname, '..', 'examples')).length} JS checks passed`);

const py = spawnSync('python3', ['-c', 'import ezdxf'], { stdio: 'ignore' });
if (py.status === 0) {
  const dxfs = fs.readdirSync(OUT).filter(f => f.endsWith('.dxf')).map(f => path.join(OUT, f));
  const r = spawnSync('python3', [path.join(__dirname, 'check_dxf.py'), ...dxfs, ...process.argv.slice(2)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
} else {
  console.log('(python3 + ezdxf not found — skipped DXF validation; pip install ezdxf)');
}
process.exit(failed ? 1 : 0);
