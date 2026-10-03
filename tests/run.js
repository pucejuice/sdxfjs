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
  OrdinateDimension, XLine, Ray, Wipeout, MLeader, Table, Image, ImageDef,
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

test('groups_xlines_wipeout_ordinate', () => {
  const d = new Drawing({ units: 'mm' });
  const a = new Line([[0, 0, 0], [100, 0, 0]]), b = new Circle([50, 50, 0], 20);
  const tb = new Table([200, 100], [['A', 'B'], [1, 2]]);
  [a, b, tb].forEach(e => d.append(e));
  d.addGroup('FRAME', [a, b], { description: 'frame members' });
  d.addGroup('SCHEDULE', [tb]);
  throws(() => d.addGroup('frame'), /already exists/);
  d.append(new XLine([0, 0], [1, 1]));
  d.append(new Ray([0, 0], [1, 0]).rotate(30));
  d.append(new Wipeout([[20, 20], [80, 20], [80, 60], [20, 60]]));
  d.append(new Text('MASKED', [50, 40, 0], { height: 8, align: 'MIDDLE_CENTER' }));
  const od = [new OrdinateDimension([30, 0], [30, -60]), new OrdinateDimension([100, 50], [160, 50]),
              new OrdinateDimension([100, 0], [100, -60], { origin: [50, 0], axis: 'x' })];
  od.forEach(x => d.append(x));
  const s = d.toString();
  assert.deepStrictEqual(od.map(x => x._r.measurement), [30, 50, 50]);
  assert.deepStrictEqual(od.map(x => x._r.type & 64), [64, 0, 64], 'x / y ordinate flags');
  assert.ok(s.includes('ACAD_WIPEOUT_VARS') && s.includes('\nCLASSES\n'), 'wipeout class + vars');
  assert.ok(s.endsWith('EOF\n'), 'trailing newline');
  const r = new Ray([0, 0], [1, 0]).rotate(90);
  closePt(r.direction, [0, 1], 'rotated ray direction');
  const d2 = new Drawing(); d2.addGroup('X', [new Line([[0, 0], [1, 1]])]);
  throws(() => d2.toString(), /not in the drawing/);
  return d;
});

test('multileaders', () => {
  const d = new Drawing({ units: 'mm', dimstyles: [new DimStyle({ name: 'S20', scale: 20 })] });
  d.append(new Circle([0, 0, 0], 100));
  d.append(new MLeader([[70, 70], [400, 400]], 'T16 @ 200 B1', { dimstyle: 'S20' }));
  d.append(new MLeader([[-70, 70], [-300, 300], [-400, 300]], 'LINE ONE\nLINE TWO', { dimstyle: 'S20' }));
  d.append(new MLeader([[0, -100], [200, -400]], 'SCALED', { height: 80 }).mirror([0, 0], [0, 1]));
  throws(() => new MLeader([[0, 0]], 'x'), /2 points/);
  const s = d.toString();
  assert.ok(s.includes('ACAD_MLEADERSTYLE') && s.includes('MULTILEADER'), 'mleader style + class');
  assert.ok(s.includes('LINE ONE\\PLINE TWO'), 'newline → \\P');
  return d;
});

test('tables', () => {
  const d = new Drawing({ units: 'mm' });
  const t = new Table([0, 0], [
    ['Mark', 'Type', 'Dia', 'No.', 'Length', 'Shape'],
    ['01', 'B', 16, 8, 2350, { text: 'Straight', rowspan: 2 }],
    ['02', 'B', 12, 24, 1200],
    [{ text: 'Total mass (kg)', colspan: 4, align: 'RIGHT' }, 66.7, ''],
  ], { title: 'BAR SCHEDULE', textHeight: 25, headerFill: 8, align: ['CENTER', 'CENTER', 'RIGHT', 'RIGHT', 'RIGHT', 'LEFT'],
       format: (v, r, c) => (typeof v === 'number' && c === 4 && r > 0) ? v.toFixed(1) : v });
  d.append(t);
  const g = t._grid();
  assert.strictEqual(g.widths.length, 6); assert.strictEqual(g.heights.length, 5);
  assert.strictEqual(g.cells.find(c => c.text === 'Straight').rs, 2);
  assert.strictEqual(g.cells.find(c => c.text === '66.7').c, 4, 'value after colspan 4 lands in column 4');
  const lines = t._entities().filter(e => e instanceof Line);
  const n = t._entities().filter(e => e instanceof MText).length;
  assert.strictEqual(n, 1 + 6 + 6 + 5 + 2, 'title + header + rows (merged and empty cells skipped)');
  d.append(new Table([0, -500], [['A', 'B'], ['1', '2']], { colWidths: [100, 60], rowHeights: 40, textHeight: 20, rotation: 90 }));
  throws(() => new Table([0, 0], [[{ text: 'x', colspan: 2 }, 'y'], ['a', { text: 'b', rowspan: 0 }]], { colWidths: [1] })._entities(), /colWidths/);
  throws(() => new Table([0, 0], [['a', { text: 'b', rowspan: 2 }], [{ text: 'c', colspan: 2 }]]), /covered/);
  const ragged = new Table([0, 0], [['a', 'b', 'c'], ['d']])._grid();
  assert.strictEqual(ragged.cells.length, 6, 'short row padded with empty cells');
  return d;
});

// Minimal valid RGB PNG (w × h gradient) for the image tests
function makePng(w, h) {
  const zlib = require('zlib');
  const crc = buf => { let c, k = ~0; for (const b of buf) { c = (k ^ b) & 0xFF; for (let i = 0; i < 8; i++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; k = (k >>> 8) ^ c; } return ~k >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 255 / w; raw[o + 1] = y * 255 / h; raw[o + 2] = 160;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr),
                        chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('images', () => {
  fs.writeFileSync(path.join(OUT, 'gradient.png'), makePng(64, 32));
  const def = ImageDef.fromFile(path.join(OUT, 'gradient.png'), 'gradient.png');
  assert.deepStrictEqual(def.size, [64, 32]);
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0, 0, 0]);
  assert.deepStrictEqual(ImageDef.fromBytes('a.gif', gif).size, [10, 20]);
  const bmp = new Uint8Array(30); bmp[0] = 0x42; bmp[1] = 0x4D; bmp[18] = 100; bmp[22] = 50;
  assert.deepStrictEqual(ImageDef.fromBytes('a.bmp', bmp).size, [100, 50]);
  const jpg = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0, 200, 1, 44, 3, 0, 0, 0]);
  assert.deepStrictEqual(ImageDef.fromBytes('a.jpg', jpg).size, [300, 200]);
  throws(() => ImageDef.fromBytes('x.txt', Uint8Array.from([1, 2, 3])), /not a PNG/);

  const d = new Drawing({ units: 'mm' });
  const a = new Image(def, [0, 0, 0], { width: 640 });
  close(a.height, 320, 'height from aspect');
  d.append(a);
  d.append(new Image(def, [800, 0, 0], { height: 200, rotation: 30 }));
  d.append(new Image(def, [0, -400, 0], { width: 320 }).mirror([0, -300], [1, -300]));
  const blk = new Block('logo', { entities: [new Image(def, [0, 0, 0], { width: 100 })] });
  d.append(new Insert(blk, [1500, 0, 0]));
  const s = d.toString();
  assert.ok(s.includes('ACAD_IMAGE_DICT') && s.includes('IMAGEDEF_REACTOR') && s.includes('\ngradient.png\n'));
  assert.strictEqual((s.match(/\n0\nIMAGEDEF\n/g) || []).length, 1, 'one IMAGEDEF shared by all images');
  return d;
});

test('mleader_blocks', () => {
  const bubble = new Block('grid_bubble', { entities: [
    new Circle([0, 0, 0], 5), new AttDef('ref', [0, 0, 0], { height: 4, align: 'MIDDLE_CENTER', defaultValue: '?' }),
  ] });
  const d = new Drawing({ units: 'mm', dimstyles: [new DimStyle({ name: 'S50', scale: 50 })] });
  d.append(new Line([[0, 0, 0], [0, 3000, 0]]));
  d.append(new Line([[3000, 0, 0], [3000, 3000, 0]]));
  const a = new MLeader([[0, 3000], [0, 3400], [100, 3400]], { block: bubble, attributes: { ref: 'A' } }, { dimstyle: 'S50' });
  const b = new MLeader([[3000, 3000], [3000, 3400], [2900, 3400]], { block: bubble, attributes: { ref: 'B' } }, { dimstyle: 'S50' });
  const c = new MLeader([[1500, 0], [1500, -500]], bubble, { dimstyle: 'S50' });
  [a, b, c].forEach(x => d.append(x));
  assert.strictEqual(a.block.name, 'GRID_BUBBLE__REF-A');
  assert.strictEqual(new MLeader([[0, 0], [1, 1]], { block: bubble, attributes: { ref: 'A' } }).block, a.block, 'variant reused');
  assert.ok(a.block.entities.some(e => e instanceof Text && e.text === 'A'), 'attribute baked into text');
  throws(() => new MLeader([[0, 0], [1, 1]], { block: bubble, attributes: { nope: 1 } }), /NOPE/);
  const s = d.toString();   // resolves the 'S50' dimstyle
  const L = a._layout();
  close(L.scale, 50, 'block scaled by dimstyle'); closePt(L.box[0], [100 + L.dogleg, 3400 - 250], 'bubble left edge at landing end');
  assert.ok(s.includes('GRID_BUBBLE__REF-B') && s.includes('GRID_BUBBLE__REF-?'.replace('?', '_')), 'variant blocks written');
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
