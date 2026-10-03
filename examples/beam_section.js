// node examples/beam_section.js  →  writes beam_section.dxf
// RC beam section drawn from design inputs: hatch, bar layout, dimensions, notes.
const fs = require('fs');
const { Drawing, Layer, DimStyle, LwPolyLine, Line, Hatch, MText, LinearDimension, MLeader, Table } = require('../sdxf.js');

// ── Design inputs (mm) ─────────────────────────────────────────────────────────
const b = 300, h = 600, cover = 40, link = 10;
const bottom = { n: 4, dia: 20 }, top = { n: 2, dia: 16 };

// ── Derived geometry ──────────────────────────────────────────────────────────
const barCentres = (n, dia, y) => {
  const x0 = cover + link + dia / 2, x1 = b - x0;
  return Array.from({ length: n }, (_, i) => [x0 + (x1 - x0) * i / (n - 1), y]);
};
const yBot = cover + link + bottom.dia / 2, yTop = h - cover - link - top.dia / 2;
const d = h - yBot;                                         // effective depth
const As = bottom.n * Math.PI * bottom.dia ** 2 / 4;        // tension steel area
const clearGap = (b - 2 * (cover + link) - bottom.n * bottom.dia) / (bottom.n - 1);

// A circle as a closed LwPolyLine (two half-circle bulges) so it can bound a hatch.
const circle = ([x, y], r) => new LwPolyLine([[x - r, y], [x + r, y]], { flag: 1, bulge: 1, layer: 'REBAR' });

// ── Drawing ───────────────────────────────────────────────────────────────────
const dwg = new Drawing({
  units: 'mm', ltscale: 10,
  layers: [
    new Layer({ name: 'concrete', color: 7, lineWeight: 35 }),
    new Layer({ name: 'rebar', color: 1, lineWeight: 25 }),
    new Layer({ name: 'centre', color: 4, lineType: 'CENTER' }),
    new Layer({ name: 'dims', color: 2 }),
    new Layer({ name: 'text', color: 7 }),
  ],
  dimstyles: [new DimStyle({ name: '1to10', scale: 10, tickSize: 2 })],   // 1:10 detail
});

const outline = new LwPolyLine([[0, 0], [b, 0], [b, h], [0, h]], { flag: 1, layer: 'CONCRETE' });
dwg.append(outline);
dwg.append(new Hatch(outline, { pattern: 'ANSI31', scale: 5, layer: 'CONCRETE', color: 8 }));

const o = cover + link / 2;   // link centreline
dwg.append(new LwPolyLine([[o, o], [b - o, o], [b - o, h - o], [o, h - o]], { flag: 1, width: link, layer: 'REBAR' }));
for (const [bars, y] of [[bottom, yBot], [top, yTop]])
  for (const c of barCentres(bars.n, bars.dia, y)) {
    const bar = circle(c, bars.dia / 2);
    dwg.append(bar);
    dwg.append(new Hatch(bar, { pattern: 'SOLID', layer: 'REBAR' }));
  }

dwg.append(new Line([[b / 2, -50, 0], [b / 2, h + 50, 0]], { layer: 'CENTRE' }));

dwg.append(new LinearDimension([0, 0], [b, 0], [0, -120], { dimstyle: '1to10', layer: 'DIMS' }));
dwg.append(new LinearDimension([b, 0], [b, h], [b + 120, 0], { angle: 90, dimstyle: '1to10', layer: 'DIMS' }));
dwg.append(new LinearDimension([0, yBot], [0, h], [-120, 0], { angle: 90, dimstyle: '1to10', layer: 'DIMS', text: 'd = <>' }));

// Bar callouts
const [b1] = barCentres(bottom.n, bottom.dia, yBot), [t1] = barCentres(top.n, top.dia, yTop);
dwg.append(new MLeader([[b1[0] - 5, b1[1] - 5], [-150, -60]], `01 ${bottom.n}B${bottom.dia}`, { dimstyle: '1to10', layer: 'TEXT' }));
dwg.append(new MLeader([[t1[0] - 5, t1[1] + 5], [-150, h + 60]], `02 ${top.n}B${top.dia}`, { dimstyle: '1to10', layer: 'TEXT' }));

// Bar schedule — lengths and masses from the section for a 6 m beam
const L = 6000;
const mass = (dia, n, len) => n * Math.PI * dia ** 2 / 4 * len * 7.85e-6;   // kg (mm, steel 7850 kg/m³)
const linkLen = 2 * (b + h - 4 * cover) + 24 * link;                         // shape code 51 approx.
const schedule = [
  ['01', bottom.dia, bottom.n, L - 2 * cover, '00'],
  ['02', top.dia, top.n, L - 2 * cover, '00'],
  ['03', link, Math.floor((L - 2 * cover) / 200) + 1, linkLen, '51'],
].map(([mark, dia, n, len, shape]) => [mark, `B${dia}`, n, len, shape, mass(dia, n, len)]);
const total = schedule.reduce((s, r) => s + r[5], 0);
dwg.append(new Table([600, h + 100], [
  ['Mark', 'Size', 'No.', 'Length (mm)', 'Shape', 'Mass (kg)'],
  ...schedule,
  [{ text: 'Total', colspan: 5, align: 'RIGHT' }, total],
], { title: 'BAR SCHEDULE', textHeight: 25, headerFill: 9, layer: 'TEXT',
     align: ['CENTER', 'CENTER', 'RIGHT', 'RIGHT', 'CENTER', 'RIGHT'],
     format: (v, r, c) => c === 5 && typeof v === 'number' ? v.toFixed(1) : v }));

dwg.append(new MText(
  `SECTION A-A  (1:10)\n` +
  `B${bottom.dia} x ${bottom.n} bottom, B${top.dia} x ${top.n} top, H${link} links\n` +
  `Cover ${cover} mm, d = ${d} mm\n` +
  `As = ${As.toFixed(0)} mm², clear bar gap = ${clearGap.toFixed(0)} mm`,
  [0, -250, 0], { height: 25, width: 900, layer: 'TEXT' }));

fs.writeFileSync('beam_section.dxf', dwg.toString());
console.log(`wrote beam_section.dxf  (d = ${d} mm, As = ${As.toFixed(0)} mm²)`);
