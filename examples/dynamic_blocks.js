// node examples/dynamic_blocks.js  →  writes dynamic_blocks.dxf
const fs = require('fs');
const { Drawing, Layer, Block, DynamicBlock, Insert, AttDef, LwPolyLine, Line, Circle } = require('../sdxf.js');

// ── Dynamic block: 1000 x 200 beam with LENGTH (stretch) and DEPTH (stretch) ──
const outline = new LwPolyLine([[0, 0], [1000, 0], [1000, 200], [0, 200]], { flag: 1 });
const centre  = new Line([[0, 100, 0], [1000, 100, 0]]);
const bolt    = new Circle([950, 100, 0], 10);
const mark    = new AttDef('mark', [500, 100, 0], { prompt: 'Beam mark', defaultValue: 'B1', height: 50, align: 'MIDDLE_CENTER' });

const beam = new DynamicBlock('beam', { entities: [outline, centre, bolt, mark] });
beam.addLinearParameter('length', [0, 0], [1000, 0], { min: 500, max: 6000, increment: 50 });
beam.addLinearParameter('depth',  [0, 0], [0, 200],  { values: [150, 200, 300, 450] });
// right-hand end moves with LENGTH; the mark stays centred (moves half as far)
beam.addStretchAction('length', { frame: [[900, -10], [1100, 210]] });
beam.addMoveAction('length', { entities: [mark], multiplier: 0.5 });
// top edge moves with DEPTH (outline only)
beam.addStretchAction('depth', { frame: [[-10, 190], [1100, 210]], entities: [outline] });

// ── Plain block with attributes ────────────────────────────────────────────────
const title = new Block('title', { entities: [
  new LwPolyLine([[0, 0], [400, 0], [400, 100], [0, 100]], { flag: 1 }),
  new AttDef('drawing no', [10, 60, 0], { height: 20 }),
  new AttDef('rev', [10, 20, 0], { height: 20, defaultValue: 'A' }),
]});

// ── Drive it from a calculation ───────────────────────────────────────────────
const spans = [2337, 3120, 4800];   // mm, e.g. from a span table
const d = new Drawing({ layers: [new Layer(), new Layer({ name: 'beams', color: 3 })] });
spans.forEach((span, i) => d.append(new Insert(beam, [0, i * 800, 0], {
  layer: 'BEAMS',
  params: { length: span, depth: span / 12 },    // snapped to the value sets
  attributes: { mark: `B${i + 1}` },
  xdata: { CALC: [[1000, 'clear span'], [1040, span]] },
})));
d.append(new Insert(title, [6000, 0, 0], { attributes: { 'drawing no': 'S-101', rev: 'C' } }));

// Blocks referenced by inserts are added to the drawing automatically.
fs.writeFileSync('dynamic_blocks.dxf', d.toString());
console.log('wrote dynamic_blocks.dxf');
