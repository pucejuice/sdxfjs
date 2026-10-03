/**
 * SDXF JavaScript Translation — Complete & AC1015-Compliant
 *
 * Fixes applied:
 * 1. Group code 330 (owner handle) on all entities — required by AC1015
 * 2. AcDb subclass markers (group 100) on all entities
 * 3. *Model_Space / *Paper_Space blocks in BLOCKS section
 * 4. BLOCK_RECORD, APPID, DIMSTYLE tables
 * 5. OBJECTS section
 * 6. $HANDSEED in HEADER
 * 7. Unique handles per entity (group 5)
 * 8. Collection.toString() filters empty strings — prevents null object ID
 * 9. LwPolyLine: group 90 (vertex count), group 70 (flag), 2D-only vertices,
 *    no trailing bare group-code-0, degenerate guard (< 2 points returns '')
 * 10. Text: empty string guard
 * 11. brTable: fixed blank line bug (NL+content → count+NL+content)
 * 12. Every user block gets its own BLOCK_RECORD; entities inside a block are
 *     owned (330) by that block's record, not *Model_Space
 * 13. $HANDSEED computed from the last handle used; root DICTIONARY in OBJECTS
 * 14. Linetype dash elements written (49/74); BYBLOCK/BYLAYER/CONTINUOUS and
 *     layer 0 always present; DIMSTYLE handle uses group 105
 * 15. Style defaults: width factor 1, oblique 0 (were 40/50 → 40x wide text)
 * 16. Non-ASCII text (², °, Ø) written as \U+XXXX escapes; $DWGCODEPAGE set
 *
 * Drawing options: units ('mm','m','in',...) → $INSUNITS/$MEASUREMENT, ltscale,
 *   automatic $EXTMIN/$EXTMAX and *ACTIVE viewport zoomed to the drawing.
 * Entity options: thickness, lineTypeScale, extrusion, trueColor ([r,g,b] or 0xRRGGBB).
 * MText, Hatch (SOLID + ANSI31/32/37, NET, DOTS, EARTH or custom),
 * LinearDimension / AlignedDimension with DimStyle (incl. dimscale for plot scale).
 * Ellipse, Spline (control or fit points), Leader, Radius/Diameter/AngularDimension.
 * Transforms on every entity: copy, translate, rotate, scale, mirror; arrayRect,
 * arrayPolar; MINSERT grids. Dynamic blocks: flip, visibility, array, lookups.
 * Full API: README.md. Tests: npm test.
 *
 * Blocks & attributes:
 *   AttDef  — attribute definition inside a Block (tag, prompt, default, flags)
 *   Insert  — block reference; fills ATTRIBs from the block's AttDefs
 *   XDATA   — any entity accepts { xdata: { APPNAME: [[1000,'txt'],[1040,1.5]] } }
 *
 * Dynamic blocks (DynamicBlock):
 *   Linear parameters with stretch / move actions, value sets (min/max/
 *   increment or list). Each Insert resolves its parameter values into a
 *   concrete block definition named NAME__PARAM-VALUE, generated once and
 *   reused. The values are stored on the INSERT as XDATA (app SDXF_DYNBLOCK).
 *   NOTE: this bakes the geometry; the output does not contain AutoCAD's
 *   undocumented dynamic-block objects (AcDbEvalGraph etc.), so grips are
 *   not editable in AutoCAD — the drawing is driven from code instead.
 */

const NL = String.fromCharCode(10);

// ── Handle counter — unique hex handle per entity, reset per Drawing ──────────
let _dxfHandle = 1;
function _nextHandle() { return (_dxfHandle++).toString(16).toUpperCase(); }
function _resetHandles() { _dxfHandle = 1; }

// ── Pre-allocate a block of handles at start so referenced objects have
//    known handles before any entities are written ────────────────────────────
let _H_TABLES, _H_BLOCKTABLE, _H_MODEL_BTR, _H_PAPER_BTR;
let _H_LTYPE_TBL, _H_LAYER_TBL, _H_STYLE_TBL, _H_VIEW_TBL;
let _H_UCS_TBL, _H_APPID_TBL, _H_DIM_TBL, _H_VPORT_TBL;
function _preAllocHandles() {
  _H_TABLES      = _nextHandle();
  _H_BLOCKTABLE  = _nextHandle();
  _H_MODEL_BTR   = _nextHandle(); // *Model_Space block table record — owner of all model entities
  _H_PAPER_BTR   = _nextHandle();
  _H_LTYPE_TBL   = _nextHandle();
  _H_LAYER_TBL   = _nextHandle();
  _H_STYLE_TBL   = _nextHandle();
  _H_VIEW_TBL    = _nextHandle();
  _H_UCS_TBL     = _nextHandle();
  _H_APPID_TBL   = _nextHandle();
  _H_DIM_TBL     = _nextHandle();
  _H_VPORT_TBL   = _nextHandle();
}

// Handle of the BLOCK_RECORD that owns the entities currently being written.
let _owner = null;
const DYN_APPID = 'SDXF_DYNBLOCK';

function _point(x, index = 0) { return x.map((val, i) => `${(i + 1) * 10 + index}${NL}${val}`).join(NL); }
function _points(p) { return p.map((pt, i) => _point(pt, i)); }
function _bboxOf(pts) {
  if (!pts || !pts.length) return null;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]];
}
function _union(boxes) {
  return _bboxOf(boxes.filter(Boolean).flat());
}
// 2D similarity transform m = [a, b, c, d, e, f]:  x' = a·x + c·y + e,  y' = b·x + d·y + f
const _num = v => Number(v.toFixed(10));
function _apply(m, p) {
  const x = p[0], y = p[1];
  p[0] = _num(m[0] * x + m[2] * y + m[4]); p[1] = _num(m[1] * x + m[3] * y + m[5]);
}
const _rot = ([x, y], deg) => {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
};
const _normAngle = a => _num(((a % 360) + 360) % 360);
// Keep text readable after a mirror (like AutoCAD's MIRRTEXT = 0).
const _readable = a => { a = _normAngle(a); return a > 90 && a <= 270 ? _normAngle(a - 180) : a; };
const _textRotation = (info, r) => info.mirror ? _readable(info.angle(r || 0)) : _normAngle(info.angle(r || 0));
function _rgb(c) { return Array.isArray(c) ? (c[0] << 16) + (c[1] << 8) + c[2] : c; }
function calculate_end_point(start_point, angle_degrees, length) {
  const [x_start, y_start] = start_point;
  const angle_radians = angle_degrees * (Math.PI / 180);
  return [x_start + length * Math.cos(angle_radians), y_start + length * Math.sin(angle_radians)];
}

class Entity {
  constructor({ color = 256, extrusion = null, layer = '0', lineType = null, lineTypeScale = null, lineWeight = null, thickness = null, parent = null, xdata = null, trueColor = null } = {}) {
    this.color = color; this.extrusion = extrusion; this.layer = layer; this.lineType = lineType;
    this.lineTypeScale = lineTypeScale; this.lineWeight = lineWeight; this.thickness = thickness; this.parent = parent;
    this.xdata = xdata; this.trueColor = trueColor;
  }
  _common(handle = _nextHandle(), owner = _owner || _H_MODEL_BTR) {
    const parent = this.parent || this;
    // Group 5: unique handle. Group 330: owner = block table record of the
    // block being written (*Model_Space for the ENTITIES section).
    const lines = ['5', handle, '330', owner, '100', 'AcDbEntity', '8', parent.layer];
    if (parent.lineType !== null) lines.push('6', parent.lineType);
    if (parent.color !== null && parent.color !== 256) lines.push('62', parent.color);
    if (parent.trueColor !== null && parent.trueColor !== undefined) lines.push('420', _rgb(parent.trueColor));
    if (parent.lineWeight !== null) lines.push('370', parent.lineWeight);
    if (parent.lineTypeScale !== null) lines.push('48', parent.lineTypeScale);
    return lines.join(NL);
  }
  // Group 39 (thickness) and 210/220/230 (extrusion) — go inside the entity's subclass.
  _thick() { return this.thickness !== null ? ['39', this.thickness] : []; }
  _extr() { return this.extrusion ? [_point(this.extrusion, 200)] : []; }
  /** Approximate 2D bounding box [[xmin,ymin],[xmax,ymax]] or null. */
  _bbox() { return _bboxOf(this._pts()); }
  // XDATA must be the last thing in an entity. Returns [] when there is none.
  _xdata() {
    if (!this.xdata) return [];
    const lines = [];
    for (const [app, pairs] of Object.entries(this.xdata)) {
      lines.push('1001', app.toUpperCase());
      for (const [code, value] of pairs) lines.push(String(code), value);
    }
    return lines;
  }
  // Mutable references to every defining point — used by dynamic block actions and transforms.
  _pts() { return []; }

  // ── Transforms (in place, chainable). Use copy() first to keep the original. ──
  copy() { return _cloneEntity(this); }
  /** Apply m = [a,b,c,d,e,f]; only moves, rotations, uniform scaling and mirroring. */
  transform(m) {
    const s = Math.hypot(m[0], m[1]), det = m[0] * m[3] - m[1] * m[2];
    if (!s || Math.abs(Math.hypot(m[2], m[3]) - s) > 1e-9 * s || Math.abs(m[0] * m[2] + m[1] * m[3]) > 1e-9 * s * s)
      throw new Error('transform: only moves, rotations, uniform scaling and mirroring are supported');
    const beta = Math.atan2(m[1], m[0]) * 180 / Math.PI, mirror = det < 0;
    const info = { m, s, mirror, beta, angle: th => mirror ? beta - th : th + beta };
    // Detach point arrays the caller may share with other entities before mutating them.
    for (const [k, v] of Object.entries(this)) if (Array.isArray(v)) this[k] = _deep(v);
    for (const p of new Set(this._pts())) _apply(m, p);
    this._transformExtra(info);
    return this;
  }
  _transformExtra(info) {}   // angles, radii, heights… per entity type
  translate(dx, dy = 0) { return this.transform([1, 0, 0, 1, dx, dy]); }
  rotate(angle, center = [0, 0]) {
    const r = angle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), [x, y] = center;
    return this.transform([c, s, -s, c, x - c * x + s * y, y - s * x - c * y]);
  }
  scale(factor, center = [0, 0]) {
    const [x, y] = center;
    return this.transform([factor, 0, 0, factor, x - factor * x, y - factor * y]);
  }
  /** Mirror about the line through p1 and p2. */
  mirror(p1, p2) {
    const a = 2 * Math.atan2(p2[1] - p1[1], p2[0] - p1[0]), c = Math.cos(a), s = Math.sin(a);
    return this.transform([c, s, s, -c, p1[0] - c * p1[0] - s * p1[1], p1[1] - s * p1[0] + c * p1[1]]);
  }
}

/** Copies of `entities` in a grid (the first cell is a copy too, at the original position). */
function arrayRect(entities, { rows = 1, cols = 1, rowSpacing = 0, colSpacing = 0 } = {}) {
  const out = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      for (const e of entities) out.push(e.copy().translate(c * colSpacing, r * rowSpacing));
  return out;
}
/**
 * Copies of `entities` around `center`. angle = total sweep (360 = full circle,
 * items evenly spaced; otherwise first and last item at 0 and `angle`).
 * rotateItems: false keeps each copy's orientation and only moves it.
 */
function arrayPolar(entities, { count, center = [0, 0], angle = 360, rotateItems = true } = {}) {
  const step = Math.abs(angle) >= 360 ? angle / count : angle / Math.max(1, count - 1);
  const box = _union(entities.map(e => e._bbox())) || [center, center];
  const ref = [(box[0][0] + box[1][0]) / 2, (box[0][1] + box[1][1]) / 2];
  const out = [];
  for (let i = 0; i < count; i++)
    for (const e of entities) {
      if (rotateItems) { out.push(e.copy().rotate(i * step, center)); continue; }
      const p = [...ref]; _apply(_rotM(i * step, center), p);
      out.push(e.copy().translate(p[0] - ref[0], p[1] - ref[1]));
    }
  return out;
}
function _rotM(angle, [x, y]) {
  const r = angle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, x - c * x + s * y, y - s * x - c * y];
}

// Text alignment names (same as ezdxf's TextEntityAlignment) → [72 halign, valign]
const _ALIGN = {
  LEFT: [0, 0], CENTER: [1, 0], RIGHT: [2, 0], MIDDLE: [4, 0],
  BOTTOM_LEFT: [0, 1], BOTTOM_CENTER: [1, 1], BOTTOM_RIGHT: [2, 1],
  MIDDLE_LEFT: [0, 2], MIDDLE_CENTER: [1, 2], MIDDLE_RIGHT: [2, 2],
  TOP_LEFT: [0, 3], TOP_CENTER: [1, 3], TOP_RIGHT: [2, 3],
};
function _alignCodes(align) {
  const a = _ALIGN[String(align || 'LEFT').toUpperCase()];
  if (!a) throw new Error(`Unknown text alignment '${align}'. Use one of: ${Object.keys(_ALIGN).join(', ')}`);
  return a;
}
// Approximate box of a w×h text block placed at p; col 0/1/2 = left/centre/right,
// row 0/1/2 = bottom/middle/top of the block sits on p. Rotation is ignored.
function _textBox(p, w, h, col = 0, row = 0) {
  const x0 = p[0] - w * col / 2, y0 = p[1] - h * row / 2;
  return [[x0, y0], [x0 + w, y0 + h]];
}
// Shared AcDbText body for TEXT / ATTDEF / ATTRIB. Returns [lines, valign].
function _textLines(e, value) {
  const [h, v] = _alignCodes(e.align);
  const lines = ['100','AcDbText',_point(e.point),'40',e.height,'1',value];
  if (e.rotation !== null) lines.push('50', e.rotation);
  if (e.style !== null) lines.push('7', e.style);
  if (h) lines.push('72', h);
  if (h || v) lines.push(_point(e.alignPoint || e.point, 1)); // 11/21/31 alignment point
  return [lines, v];
}

class Collection {
  constructor(entities = []) { this.entities = [...entities]; }
  append(entity) { this.entities.push(entity); }
  // Filter empty/whitespace strings — prevents blank lines inside sections
  // that parse as group code 0 with null value ("Null object ID").
  toString() { return this.entities.map(e => e.toString()).filter(s => s && s.trim()).join(NL); }
}

// ── Table entry classes ───────────────────────────────────────────────────────
class Layer {
  constructor({ name = 'pydxf', color = 7, lineType = 'continuous', flag = 64, lineWeight = null, plot = true, trueColor = null } = {}) {
    this.name = name.toUpperCase(); this.color = color; this.lineType = lineType; this.flag = flag;
    this.lineWeight = lineWeight; this.plot = plot; this.trueColor = trueColor;
  }
  toString() {
    const lines = ['0','LAYER','5',_nextHandle(),'330',_H_LAYER_TBL,
            '100','AcDbSymbolTableRecord','100','AcDbLayerTableRecord',
            '2',this.name,'70',this.flag,'62',this.color];
    if (this.trueColor !== null) lines.push('420', _rgb(this.trueColor));
    lines.push('6', this.lineType);
    if (!this.plot) lines.push('290', '0');
    lines.push('370', this.lineWeight ?? -3);  // -3 = default lineweight
    return lines.join(NL);
  }
}
// Dash patterns from acadiso.lin (mm). Positive = dash, negative = gap, 0 = dot.
const LINETYPE_PRESETS = {
  DASHED:  ['Dashed __ __ __ __', [12.7, -6.35]],
  HIDDEN:  ['Hidden _ _ _ _ _ _', [6.35, -3.175]],
  CENTER:  ['Center ____ _ ____ _', [31.75, -6.35, 6.35, -6.35]],
  PHANTOM: ['Phantom _____ _ _ _____', [31.75, -6.35, 6.35, -6.35, 6.35, -6.35]],
  DASHDOT: ['Dash dot __ . __ .', [12.7, -6.35, 0, -6.35]],
  DOT:     ['Dot . . . . . .', [0, -6.35]],
};
class LineType {
  constructor({ name = 'continuous', description = 'Solid line', elements = [], flag = 64 } = {}) {
    this.name = name.toUpperCase(); this.description = description; this.elements = [...elements]; this.flag = flag;
  }
  /** Standard linetype by name (DASHED, HIDDEN, CENTER, PHANTOM, DASHDOT, DOT), dashes × scale. */
  static preset(name, { scale = 1 } = {}) {
    const p = LINETYPE_PRESETS[String(name).toUpperCase()];
    if (!p) throw new Error(`Unknown linetype preset '${name}'. Use one of: ${Object.keys(LINETYPE_PRESETS).join(', ')}`);
    return new LineType({ name, description: p[0], elements: p[1].map(e => e * scale) });
  }
  toString() {
    const total = this.elements.reduce((a, e) => a + Math.abs(e), 0);
    const lines = ['0','LTYPE','5',_nextHandle(),'330',_H_LTYPE_TBL,
            '100','AcDbSymbolTableRecord','100','AcDbLinetypeTableRecord',
            '2',this.name,'70',this.flag,'3',this.description,'72','65','73',this.elements.length,'40',total];
    for (const e of this.elements) lines.push('49', e, '74', '0');
    return lines.join(NL);
  }
}
class Style {
  constructor({ name = 'standard', flag = 0, height = 0, widthFactor = 1, obliqueAngle = 0, mirror = 0, lastHeight = 1, font = 'arial.ttf', bigFont = '' } = {}) {
    this.name = name.toUpperCase(); this.flag = flag; this.height = height; this.widthFactor = widthFactor;
    this.obliqueAngle = obliqueAngle; this.mirror = mirror; this.lastHeight = lastHeight;
    this.font = font.toUpperCase(); this.bigFont = bigFont.toUpperCase();
  }
  toString() {
    return ['0','STYLE','5',_nextHandle(),'330',_H_STYLE_TBL,
            '100','AcDbSymbolTableRecord','100','AcDbTextStyleTableRecord',
            '2',this.name,'70',this.flag,'40',this.height,'41',this.widthFactor,
            '50',this.obliqueAngle,'71',this.mirror,'42',this.lastHeight,'3',this.font,'4',this.bigFont].join(NL);
  }
}

// ── Block / Insert ────────────────────────────────────────────────────────────
class Block extends Collection {
  constructor(name, { layer = '0', flag = 0, base = [0, 0, 0], entities = [] } = {}) {
    super(entities); this.name = name; this.layer = layer; this.flag = flag; this.base = base;
  }
  get attdefs() { return this.entities.filter(e => e instanceof AttDef); }
  _bbox() { return _union(this.entities.map(e => e._bbox())); }
  // Block definitions this object contributes to the BLOCKS section.
  _definitions() { return [this]; }
  toString() {
    const upperName = this.name.toUpperCase();
    const btr = this._btrHandle || _nextHandle();
    const flag = this.attdefs.length ? (this.flag | 2) : this.flag; // 2 = has attribute definitions
    const prevOwner = _owner;
    _owner = btr;
    let body;
    try { body = super.toString(); } finally { _owner = prevOwner; }
    const parts = ['0','BLOCK','5',_nextHandle(),'330',btr,
                   '100','AcDbEntity','8',this.layer,'100','AcDbBlockBegin',
                   '2',upperName,'70',flag,_point(this.base),'3',upperName,'1',''];
    if (body) parts.push(body);
    parts.push('0','ENDBLK','5',_nextHandle(),'330',btr,'100','AcDbEntity','8',this.layer,'100','AcDbBlockEnd');
    return parts.join(NL);
  }
}

// ── Attributes ────────────────────────────────────────────────────────────────
function _tag(tag) {
  const t = String(tag ?? '').trim().toUpperCase().replace(/\s+/g, '_');
  if (!t) throw new Error('Attribute tag must not be empty');
  return t;
}
/** Attribute definition — place inside a Block. */
class AttDef extends Entity {
  constructor(tag, point = [0,0,0], { prompt = '', defaultValue = '', height = 1, rotation = null, style = null,
                                      align = 'LEFT', alignPoint = null,
                                      invisible = false, constant = false, verify = false, preset = false,
                                      ...common } = {}) {
    super(common); this.tag = _tag(tag); this.point = point; this.prompt = prompt || this.tag;
    this.defaultValue = String(defaultValue ?? ''); this.height = height; this.rotation = rotation;
    this.style = style; this.align = align; this.alignPoint = alignPoint;
    this.flags = (invisible ? 1 : 0) | (constant ? 2 : 0) | (verify ? 4 : 0) | (preset ? 8 : 0);
  }
  get constant() { return (this.flags & 2) !== 0; }
  _pts() { return this.alignPoint ? [this.point, this.alignPoint] : [this.point]; }
  _transformExtra(info) { this.height *= info.s; this.rotation = _textRotation(info, this.rotation); }
  toString() {
    const [text, valign] = _textLines(this, this.defaultValue);
    const lines = ['0','ATTDEF',this._common(),...text,
                   '100','AcDbAttributeDefinition','3',this.prompt,'2',this.tag,'70',this.flags];
    if (valign) lines.push('74', valign);
    return [...lines, ...this._xdata()].join(NL);
  }
}
/** Attribute instance attached to an Insert. Normally created by Insert itself. */
class Attrib extends Entity {
  constructor(tag, value, point = [0,0,0], { height = 1, rotation = null, style = null, align = 'LEFT',
                                             alignPoint = null, flags = 0, ...common } = {}) {
    super(common); this.tag = _tag(tag); this.value = String(value ?? ''); this.point = point;
    this.height = height; this.rotation = rotation; this.style = style; this.align = align;
    this.alignPoint = alignPoint; this.flags = flags;
  }
  _toString(owner) {
    const [text, valign] = _textLines(this, this.value);
    const lines = ['0','ATTRIB',this._common(_nextHandle(), owner),...text,
                   '100','AcDbAttribute','2',this.tag,'70',this.flags];
    if (valign) lines.push('74', valign);
    return [...lines, ...this._xdata()].join(NL);
  }
}

/**
 * Block reference.
 *   new Insert(block, [x,y,0], { rotation, xscale, yscale, zscale,
 *                                attributes: { TAG: 'value' },     // fills AttDefs
 *                                params: { LENGTH: 1500 },         // DynamicBlock only
 *                                rows, cols, rowSpacing, colSpacing })  // MINSERT grid
 * `block` may be a Block / DynamicBlock object or a block name string
 * (attributes and params need the object).
 */
class Insert extends Entity {
  constructor(block, insert = [0,0,0], { xscale = 1, yscale = 1, zscale = 1, rotation = 0,
                                        attributes = {}, params = null,
                                        rows = 1, cols = 1, rowSpacing = 0, colSpacing = 0, ...common } = {}) {
    super(common);
    this.insert = insert; this.xscale = xscale; this.yscale = yscale; this.zscale = zscale; this.rotation = rotation;
    this.rows = rows; this.cols = cols; this.rowSpacing = rowSpacing; this.colSpacing = colSpacing;
    this.attributes = Object.fromEntries(Object.entries(attributes || {}).map(([k, v]) => [_tag(k), v]));
    this.params = null;
    if (block instanceof DynamicBlock) {
      this.params = block.resolveParams(params || {});
      this.choices = block.lookupChoices(params || {});
      this.source = block;
      this.block = block.variant(this.params);
    } else {
      if (params && Object.keys(params).length) throw new Error('params are only valid for a DynamicBlock');
      this.block = block;
    }
    if (typeof this.block === 'string' && Object.keys(this.attributes).length)
      throw new Error('attributes need a Block object (to find the AttDef positions), not a block name');
    if (this.block instanceof Block) {
      const tags = new Set(this.block.attdefs.map(a => a.tag));
      const bad = Object.keys(this.attributes).filter(t => !tags.has(t));
      if (bad.length) throw new Error(`Block '${this.block.name}' has no attribute(s) ${bad.join(', ')}. Valid: ${[...tags].join(', ') || '(none)'}`);
    }
  }
  get isGrid() { return this.rows > 1 || this.cols > 1; }
  _bbox() {
    const b = this.block instanceof Block ? this.block._bbox() : null;
    if (!b) return _bboxOf([this.insert]);
    const [[x0, y0], [x1, y1]] = b;
    const one = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => this._transform(p));
    if (!this.isGrid) return _bboxOf(one);
    // MINSERT: the grid runs along the insert's rotated x / y axes
    const corners = [];
    for (const [c, r] of [[0, 0], [this.cols - 1, 0], [0, this.rows - 1], [this.cols - 1, this.rows - 1]]) {
      const [dx, dy] = _rot([c * this.colSpacing, r * this.rowSpacing], this.rotation);
      corners.push(...one.map(p => [p[0] + dx, p[1] + dy]));
    }
    return _bboxOf(corners);
  }
  _pts() { return [this.insert]; }
  _transformExtra(info) {
    if (info.mirror) { this.rotation = info.beta - this.rotation; this.yscale = -this.yscale; this.rowSpacing = -this.rowSpacing; }
    else this.rotation += info.beta;
    this.rotation = _normAngle(this.rotation);
    this.xscale *= info.s; this.yscale *= info.s; this.zscale *= info.s;
    this.rowSpacing *= info.s; this.colSpacing *= info.s;
  }
  get blockName() { return (typeof this.block === 'string' ? this.block : this.block.name).toUpperCase(); }
  // Block coords → world coords for this insert
  _transform(p) {
    const base = this.block.base, r = this.rotation * Math.PI / 180;
    const x = (p[0] - base[0]) * this.xscale, y = (p[1] - base[1]) * this.yscale;
    const z = ((p[2] || 0) - (base[2] || 0)) * this.zscale;
    return [this.insert[0] + x * Math.cos(r) - y * Math.sin(r),
            this.insert[1] + x * Math.sin(r) + y * Math.cos(r),
            (this.insert[2] || 0) + z];
  }
  _attribs() {
    if (!(this.block instanceof Block)) return [];
    const parent = this.parent || this;
    return this.block.attdefs.filter(a => !a.constant).map(a => new Attrib(
      a.tag, a.tag in this.attributes ? this.attributes[a.tag] : a.defaultValue, this._transform(a.point), {
        height: a.height * Math.abs(this.yscale),
        rotation: (a.rotation || 0) + this.rotation || null,
        style: a.style, align: a.align, alignPoint: a.alignPoint ? this._transform(a.alignPoint) : null,
        flags: a.flags & 1,                       // keep 'invisible'
        layer: a.layer === '0' ? parent.layer : a.layer,
        color: a.color,
      }));
  }
  // XDATA SDXF_DYNBLOCK: source block name, then name/value pairs
  // (1040 number, 1070 0/1 flip, 1000 text), then lookup choices.
  _dynXdata() {
    if (!this.params) return [];
    const lines = ['1001', DYN_APPID, '1000', this.source.name.toUpperCase()];
    for (const [k, v] of Object.entries({ ...this.params, ...this.choices })) {
      lines.push('1000', k);
      if (typeof v === 'number') lines.push('1040', v);
      else if (typeof v === 'boolean') lines.push('1070', v ? 1 : 0);
      else lines.push('1000', v);
    }
    return lines;
  }
  toString() {
    const h = _nextHandle();
    const attribs = this._attribs();
    const lines = ['0','INSERT',this._common(h),'100','AcDbBlockReference'];
    if (attribs.length) lines.push('66', '1');
    lines.push('2', this.blockName, _point(this.insert));
    if (this.xscale !== 1) lines.push('41', this.xscale);
    if (this.yscale !== 1) lines.push('42', this.yscale);
    if (this.zscale !== 1) lines.push('43', this.zscale);
    if (this.rotation) lines.push('50', this.rotation);
    if (this.isGrid) lines.push('70', this.cols, '71', this.rows, '44', this.colSpacing, '45', this.rowSpacing);
    lines.push(...this._extr(), ...this._dynXdata(), ...this._xdata());
    if (attribs.length) {
      for (const a of attribs) lines.push(a._toString(h));
      lines.push('0','SEQEND','5',_nextHandle(),'330',h,'100','AcDbEntity','8',(this.parent || this).layer);
    }
    return lines.join(NL);
  }
}

// ── Dynamic blocks ────────────────────────────────────────────────────────────
const _fmt = v => String(Number(Number(v).toFixed(6)));
// Value → block-name-safe text
const _key = v => typeof v === 'number' ? _fmt(v) : typeof v === 'boolean' ? (v ? 'Y' : 'N')
                : String(v).toUpperCase().replace(/[^A-Z0-9.]+/g, '_');

/** Linear parameter: distance from `base` to `end`; its default value is that distance. */
class LinearParameter {
  constructor(name, base, end, { min = null, max = null, increment = null, values = null, baseLocation = 'start' } = {}) {
    this.name = _tag(name); this.base = base; this.end = end;
    const dx = end[0] - base[0], dy = end[1] - base[1];
    this.distance = Math.hypot(dx, dy);
    if (!this.distance) throw new Error(`Linear parameter '${name}': base and end points coincide`);
    this.angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (!['start', 'midpoint'].includes(baseLocation)) throw new Error(`baseLocation must be 'start' or 'midpoint'`);
    this.min = min; this.max = max; this.increment = increment;
    this.values = values ? [...values].sort((a, b) => a - b) : null;
    this.baseLocation = baseLocation;
  }
  get default() { return this.resolve(this.distance); }
  /** Snap a requested value to the value set, like AutoCAD does when you drag a grip. */
  resolve(v) {
    v = Number(v);
    if (!Number.isFinite(v)) throw new Error(`Parameter ${this.name}: value must be a number`);
    if (this.values) return this.values.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
    if (this.increment) {
      const origin = this.min ?? 0;
      v = origin + Math.round((v - origin) / this.increment) * this.increment;
      if (this.max !== null && v > this.max) v -= this.increment;   // stay on an increment inside the range
    }
    if (this.min !== null) v = Math.max(v, this.min);
    if (this.max !== null) v = Math.min(v, this.max);
    return Number(v.toFixed(9));
  }
  /** Displacement of a grip ('start' | 'end') along the parameter when the value changes by `delta`. */
  _gripShift(grip, delta) {
    if (this.baseLocation === 'midpoint') return grip === 'end' ? delta / 2 : -delta / 2;
    return grip === 'end' ? delta : 0;  // base at start: only the end point moves
  }
}
/** Flip parameter: true mirrors the flip action's entities about the line base → end. */
class FlipParameter {
  constructor(name, base, end) {
    this.name = _tag(name); this.base = base; this.end = end;
    if (base[0] === end[0] && base[1] === end[1]) throw new Error(`Flip parameter '${name}': base and end points coincide`);
  }
  get default() { return false; }
  resolve(v) {
    if (typeof v === 'string') return ['1', 'TRUE', 'YES', 'Y', 'FLIPPED'].includes(v.trim().toUpperCase());
    return !!v;
  }
}
/** Visibility parameter: named states, each showing a subset of the block's entities. */
class VisibilityParameter {
  constructor(name, states, defaultState = null) {
    this.name = _tag(name);
    this.states = new Map(Object.entries(states).map(([k, v]) => [String(k).trim().toUpperCase(), v]));
    if (!this.states.size) throw new Error('Visibility parameter needs at least one state');
    this._default = defaultState === null ? [...this.states.keys()][0] : this.resolve(defaultState);
  }
  get default() { return this._default; }
  resolve(v) {
    const k = String(v).trim().toUpperCase();
    if (!this.states.has(k)) throw new Error(`Visibility '${this.name}': no state '${v}'. States: ${[...this.states.keys()].join(', ')}`);
    return k;
  }
  /** Entities hidden in `state`: those listed in some state but not in this one. */
  hidden(state) {
    const shown = new Set(this.states.get(state));
    return new Set([...this.states.values()].flat().filter(e => !shown.has(e)));
  }
}

function _insideFrame(p, frame) {
  if (frame.length === 2) {   // two corners of a rectangle
    const [[x1, y1], [x2, y2]] = frame;
    return p[0] >= Math.min(x1, x2) && p[0] <= Math.max(x1, x2) && p[1] >= Math.min(y1, y2) && p[1] <= Math.max(y1, y2);
  }
  let inside = false;         // polygon: even-odd ray cast
  for (let i = 0, j = frame.length - 1; i < frame.length; j = i++) {
    const [xi, yi] = frame[i], [xj, yj] = frame[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const _deep = v => Array.isArray(v) ? v.map(_deep) : v;
function _cloneEntity(e) {
  const c = Object.create(Object.getPrototypeOf(e));
  for (const [k, v] of Object.entries(e)) c[k] = _deep(v);
  return c;
}

/**
 * Block with parameters and actions. Usage:
 *   const beam = new DynamicBlock('beam', { entities: [outline, label] });
 *   beam.addLinearParameter('length', [0,0], [1000,0], { min: 500, max: 6000, increment: 50 });
 *   beam.addStretchAction('length', { frame: [[900,-50],[1100,250]] });
 *   drawing.append(new Insert(beam, [0,0], { params: { length: 2350 } }));
 *
 * Parameters: linear (stretch / move / array actions), flip (flip action),
 * visibility states, and lookup tables that set several parameters by one key.
 */
class DynamicBlock extends Block {
  constructor(name, options = {}) {
    super(name, options);
    this.parameters = {}; this.actions = []; this.lookups = {}; this._variants = new Map();
  }
  _addParam(p) {
    if (this.parameters[p.name] || this.lookups[p.name]) throw new Error(`DynamicBlock '${this.name}': '${p.name}' is already defined`);
    this.parameters[p.name] = p;
    return p;
  }
  addLinearParameter(name, base, end, options = {}) { return this._addParam(new LinearParameter(name, base, end, options)); }
  addFlipParameter(name, base, end) { return this._addParam(new FlipParameter(name, base, end)); }
  /** states: { STATE: [entities shown] }. Entities in no state are always shown. */
  addVisibilityStates(states, { name = 'visibility', defaultState = null } = {}) {
    for (const e of Object.values(states).flat())
      if (!this.entities.includes(e)) throw new Error(`Visibility entity is not part of block '${this.name}'`);
    return this._addParam(new VisibilityParameter(name, states, defaultState));
  }
  /**
   * Lookup table: one key sets several parameters, e.g. steel sections
   *   addLookup('section', { UB203: { depth: 203, width: 133 }, UB254: { depth: 254, width: 146 } })
   *   new Insert(blk, pt, { params: { section: 'UB254' } })
   */
  addLookup(name, table) {
    const n = _tag(name);
    if (this.parameters[n] || this.lookups[n]) throw new Error(`DynamicBlock '${this.name}': '${n}' is already defined`);
    const rows = new Map();
    for (const [key, row] of Object.entries(table)) {
      const r = Object.fromEntries(Object.entries(row).map(([k, v]) => [_tag(k), v]));
      for (const k of Object.keys(r)) if (!this.parameters[k]) throw new Error(`Lookup '${n}': no parameter '${k}' (add parameters before the lookup)`);
      rows.set(String(key).trim().toUpperCase(), { key, row: r });
    }
    this.lookups[n] = rows;
    return this;
  }
  _param(param, cls, action) {
    const p = this.parameters[_tag(param)];
    if (!p) throw new Error(`DynamicBlock '${this.name}': no parameter '${param}'`);
    if (!(p instanceof cls)) throw new Error(`${action} action needs a ${cls.name}, '${p.name}' is a ${p.constructor.name}`);
    return p;
  }
  _action(type, p, { entities = null, grip = 'end', multiplier = 1, angleOffset = 0, frame = null, spacing = null, inclusive = false }) {
    if (!['start', 'end'].includes(grip)) throw new Error(`grip must be 'start' or 'end'`);
    const sel = entities || this.entities;
    for (const e of sel) if (!this.entities.includes(e)) throw new Error(`Action entity is not part of block '${this.name}'`);
    this.actions.push({ type, param: p, entities: sel, grip, multiplier, angleOffset, frame, spacing, inclusive });
    return this;
  }
  /** Points of the selected entities that lie inside `frame` move; everything else stays. */
  addStretchAction(param, { frame, ...options }) {
    if (!frame || frame.length < 2) throw new Error('Stretch action needs a frame: [[x1,y1],[x2,y2]] or a polygon');
    return this._action('stretch', this._param(param, LinearParameter, 'Stretch'), { ...options, frame });
  }
  /** The selected entities move as a whole with the grip. */
  addMoveAction(param, { entities, ...options }) {
    if (!entities || !entities.length) throw new Error('Move action needs an entities list');
    return this._action('move', this._param(param, LinearParameter, 'Move'), { ...options, entities });
  }
  /**
   * Repeat the entities every `spacing` along the parameter, like AutoCAD's array
   * action: count = floor(value / spacing) (at least 1). inclusive: true adds one
   * more, for items that sit on both ends of the parameter (studs at 0 … L).
   */
  addArrayAction(param, { entities, spacing, ...options }) {
    if (!entities || !entities.length) throw new Error('Array action needs an entities list');
    if (!(spacing > 0)) throw new Error('Array action needs spacing > 0');
    return this._action('array', this._param(param, LinearParameter, 'Array'), { ...options, entities, spacing });
  }
  /** Mirror the entities about the flip parameter's line when it is true. */
  addFlipAction(param, { entities = null } = {}) {
    return this._action('flip', this._param(param, FlipParameter, 'Flip'), { entities });
  }
  _given(params) {
    const given = Object.fromEntries(Object.entries(params).map(([k, v]) => [_tag(k), v]));
    for (const k of Object.keys(given))
      if (!this.parameters[k] && !this.lookups[k])
        throw new Error(`DynamicBlock '${this.name}' has no parameter '${k}'. Valid: ${[...Object.keys(this.parameters), ...Object.keys(this.lookups)].join(', ')}`);
    return given;
  }
  /** Lookup keys chosen in `params`, e.g. { SECTION: 'UB254' }. */
  lookupChoices(params) {
    const out = {};
    for (const [k, v] of Object.entries(this._given(params)))
      if (this.lookups[k]) out[k] = this._lookupRow(k, v).key;
    return out;
  }
  _lookupRow(name, v) {
    const r = this.lookups[name].get(String(v).trim().toUpperCase());
    if (!r) throw new Error(`Lookup '${name}': no entry '${v}'. Entries: ${[...this.lookups[name].values()].map(x => x.key).join(', ')}`);
    return r;
  }
  /** Expand lookups, fill in defaults and snap every value to its parameter's value set. */
  resolveParams(params) {
    const given = this._given(params), vals = {};
    for (const [k, v] of Object.entries(given)) if (this.parameters[k]) vals[k] = v;
    for (const [k, v] of Object.entries(given)) {
      if (!this.lookups[k]) continue;
      for (const [p, pv] of Object.entries(this._lookupRow(k, v).row)) {
        if (p in vals && this.parameters[p].resolve(vals[p]) !== this.parameters[p].resolve(pv))
          throw new Error(`Parameter ${p}: ${vals[p]} conflicts with lookup ${k}=${v} (${pv})`);
        vals[p] = pv;
      }
    }
    const out = {};
    for (const [k, p] of Object.entries(this.parameters)) out[k] = k in vals ? p.resolve(vals[k]) : p.default;
    return out;
  }
  /** Concrete Block for a set of parameter values (cached; the base block when nothing changes). */
  variant(params = {}) {
    const values = this.resolveParams(params);
    const changed = Object.entries(values).some(([k, v]) => {
      const p = this.parameters[k];
      return p instanceof LinearParameter ? Math.abs(v - p.distance) > 1e-9 : v !== p.default;
    });
    const always = this.actions.some(a => a.type === 'array') ||
                   Object.values(this.parameters).some(p => p instanceof VisibilityParameter);
    if (!changed && !always) return this;
    const name = this.name.toUpperCase() + Object.entries(values).map(([k, v]) => `__${k}-${_key(v)}`).join('');
    if (this._variants.has(name)) return this._variants.get(name);

    const clones = new Map(this.entities.map(e => [e, _cloneEntity(e)]));
    // 1. Stretch / move. Frames are tested against the ORIGINAL geometry and the
    //    shifts summed, so actions of different parameters are order-independent.
    const shifts = new Map();  // point array → [dx, dy]
    for (const a of this.actions) {
      if (a.type !== 'stretch' && a.type !== 'move') continue;
      const p = a.param;
      const s = p._gripShift(a.grip, values[p.name] - p.distance) * a.multiplier;
      if (!s) continue;
      const [dx, dy] = _rot([s, 0], p.angle + a.angleOffset).map(_num);
      for (const e of a.entities) {
        const orig = e._pts(), copy = clones.get(e)._pts();
        orig.forEach((pt, i) => {
          if (a.type === 'stretch' && !_insideFrame(pt, a.frame)) return;
          const acc = shifts.get(copy[i]) || [0, 0];
          shifts.set(copy[i], [acc[0] + dx, acc[1] + dy]);
        });
      }
    }
    for (const [pt, [dx, dy]] of shifts) { pt[0] = _num(pt[0] + dx); pt[1] = _num(pt[1] + dy); }
    // 2. Arrays: extra copies of the (stretched) clones
    const extra = new Map();   // original entity → [copies]
    for (const a of this.actions) {
      if (a.type !== 'array') continue;
      const v = values[a.param.name];
      const n = Math.max(1, Math.floor(v / a.spacing + 1e-9) + (a.inclusive ? 1 : 0));
      const [ux, uy] = _rot([a.spacing, 0], a.param.angle + a.angleOffset);
      for (const e of a.entities)
        for (let k = 1; k < n; k++) {
          const list = extra.get(e) || [];
          list.push(clones.get(e).copy().translate(ux * k, uy * k));
          extra.set(e, list);
        }
    }
    // 3. Flips
    for (const a of this.actions) {
      if (a.type !== 'flip' || !values[a.param.name]) continue;
      for (const e of a.entities) for (const c of [clones.get(e), ...(extra.get(e) || [])]) c.mirror(a.param.base, a.param.end);
    }
    // 4. Visibility
    const hidden = new Set();
    for (const p of Object.values(this.parameters))
      if (p instanceof VisibilityParameter) p.hidden(values[p.name]).forEach(e => hidden.add(e));
    const entities = this.entities.filter(e => !hidden.has(e)).flatMap(e => [clones.get(e), ...(extra.get(e) || [])]);

    const blk = new Block(name, { layer: this.layer, flag: this.flag, base: this.base, entities });
    blk.paramValues = values; blk.source = this;
    this._variants.set(name, blk);
    return blk;
  }
  _definitions() { return [this, ...this._variants.values()]; }
}

// ── Geometry entities ─────────────────────────────────────────────────────────
class Line extends Entity {
  constructor(points, commonOptions = {}) { super(commonOptions); this.points = points; }
  _pts() { return this.points; }
  toString() { return ['0','LINE',this._common(),'100','AcDbLine',...this._thick(),_points(this.points).join(NL),...this._extr(),...this._xdata()].join(NL); }
}
class LwPolyLine extends Entity {
  constructor(points, { flag = 0, width = null, elevation = null, bulge = null, bulges = null, ...commonOptions } = {}) {
    super(commonOptions); this.points = points; this.flag = flag; this.width = width;
    this.elevation = elevation; this.bulge = bulge; this.bulges = bulges;
  }
  _pts() { return this.points; }
  _transformExtra(info) {
    if (info.mirror) {
      if (this.bulge !== null) this.bulge = -this.bulge;
      if (this.bulges) this.bulges = this.bulges.map(b => -b);
    }
    if (this.width !== null) this.width *= info.s;
  }
  toString() {
    if (!this.points || this.points.length < 2) return '';
    const lines = ['0','LWPOLYLINE',this._common(),'100','AcDbPolyline',
                   '90',this.points.length,'70',this.flag || 0];
    if (this.width !== null) lines.push('43', this.width);
    if (this.elevation !== null) lines.push('38', this.elevation);
    lines.push(...this._thick());
    for (let idx = 0; idx < this.points.length; idx++) {
      const pt = this.points[idx];
      lines.push(`10${NL}${pt[0]}`, `20${NL}${pt[1]}`);
      if (this.bulges !== null && idx < this.bulges.length) lines.push('42', this.bulges[idx]);
      else if (this.bulge !== null) lines.push('42', this.bulge);
    }
    return [...lines, ...this._extr(), ...this._xdata()].join(NL);
  }
}
class Circle extends Entity {
  constructor(center = [0,0,0], radius = 1, commonOptions = {}) { super(commonOptions); this.center = center; this.radius = radius; }
  _pts() { return [this.center]; }
  _bbox() { const [x, y] = this.center, r = this.radius; return [[x - r, y - r], [x + r, y + r]]; }
  _transformExtra(info) { this.radius *= info.s; }
  toString() { return ['0','CIRCLE',this._common(),'100','AcDbCircle',...this._thick(),_point(this.center),'40',this.radius,...this._extr(),...this._xdata()].join(NL); }
}
class Arc extends Entity {
  constructor(center = [0,0,0], radius = 1, startAngle = 0, endAngle = 90, commonOptions = {}) {
    super(commonOptions); this.center = center; this.radius = radius; this.startAngle = startAngle; this.endAngle = endAngle;
  }
  _pts() { return [this.center]; }
  _bbox() { const [x, y] = this.center, r = this.radius; return [[x - r, y - r], [x + r, y + r]]; }
  _transformExtra(info) {
    this.radius *= info.s;
    const [s, e] = [info.angle(this.startAngle), info.angle(this.endAngle)];
    [this.startAngle, this.endAngle] = (info.mirror ? [e, s] : [s, e]).map(_normAngle);  // mirror reverses direction
  }
  toString() { return ['0','ARC',this._common(),'100','AcDbCircle',...this._thick(),_point(this.center),'40',this.radius,...this._extr(),'100','AcDbArc','50',this.startAngle,'51',this.endAngle,...this._xdata()].join(NL); }
}
class Point extends Entity {
  constructor(point = [0,0,0], commonOptions = {}) { super(commonOptions); this.point = point; }
  _pts() { return [this.point]; }
  toString() { return ['0','POINT',this._common(),'100','AcDbPoint',_point(this.point),...this._thick(),...this._extr(),...this._xdata()].join(NL); }
}
class Text extends Entity {
  constructor(text = '', point = [0,0,0], { height = 1, rotation = null, style = null, align = 'LEFT', alignPoint = null, ...common } = {}) {
    super(common); this.text = text; this.point = point; this.height = height; this.rotation = rotation; this.style = style;
    this.align = align; this.alignPoint = alignPoint;
  }
  _pts() { return this.alignPoint ? [this.point, this.alignPoint] : [this.point]; }
  _transformExtra(info) { this.height *= info.s; this.rotation = _textRotation(info, this.rotation); }
  _bbox() {
    const [h, v] = _alignCodes(this.align);
    return _textBox(this.alignPoint || this.point, String(this.text ?? '').trim().length * this.height * 0.8,
                    this.height, h === 4 ? 1 : Math.min(h, 2), v === 3 ? 2 : v === 2 || h === 4 ? 1 : 0);
  }
  toString() {
    const t = String(this.text ?? '').trim();
    if (!t) return '';
    const [text, valign] = _textLines(this, t);
    const lines = ['0','TEXT',this._common(),...text,...this._thick(),...this._extr()];
    lines.push('100','AcDbText');  // second AcDbText subclass marker required by R2000
    if (valign) lines.push('73', valign);
    return [...lines, ...this._xdata()].join(NL);
  }
}
class Solid extends Entity {
  constructor(points = [], commonOptions = {}) { super(commonOptions); this.points = points; }
  _pts() { return this.points; }
  toString() {
    const p = this.points;
    const rp = [p[0],p[1],p[3],p[2]];
    return ['0','SOLID',this._common(),'100','AcDbTrace',_points(rp).join(NL),...this._thick(),...this._extr(),...this._xdata()].join(NL);
  }
}

// ── MText ─────────────────────────────────────────────────────────────────────
const _ATTACH = { TOP_LEFT: 1, TOP_CENTER: 2, TOP_RIGHT: 3, MIDDLE_LEFT: 4, MIDDLE_CENTER: 5,
                  MIDDLE_RIGHT: 6, BOTTOM_LEFT: 7, BOTTOM_CENTER: 8, BOTTOM_RIGHT: 9 };
/**
 * Multi-line text. '\n' starts a new paragraph; MTEXT formatting codes
 * (e.g. '\\LUnderline\\l', '{\\H2x;big}') pass through unchanged.
 *   new MText('NOTES:\n1. All dims in mm', [0,0], { height: 3.5, width: 120 })
 */
class MText extends Entity {
  constructor(text = '', point = [0,0,0], { height = 1, width = null, attach = 'TOP_LEFT', rotation = null,
                                            style = null, lineSpacing = null, ...common } = {}) {
    super(common); this.text = text; this.point = point; this.height = height; this.width = width;
    this.attach = attach; this.rotation = rotation; this.style = style; this.lineSpacing = lineSpacing;
  }
  _pts() { return [this.point]; }
  _transformExtra(info) {
    this.height *= info.s; if (this.width !== null) this.width *= info.s;
    this.rotation = _textRotation(info, this.rotation);
  }
  _bbox() {
    const rows = String(this.text).split('\n');
    const w = this.width || Math.max(...rows.map(r => r.length)) * this.height * 0.8;
    const a = (_ATTACH[String(this.attach).toUpperCase()] || 1) - 1;
    return _textBox(this.point, w, rows.length * this.height * 1.7 * (this.lineSpacing || 1), a % 3, 2 - Math.floor(a / 3));
  }
  toString() {
    const t = String(this.text ?? '').replace(/\r?\n/g, '\\P');
    if (!t.trim()) return '';
    const attach = _ATTACH[String(this.attach).toUpperCase()];
    if (!attach) throw new Error(`Unknown MText attach '${this.attach}'. Use one of: ${Object.keys(_ATTACH).join(', ')}`);
    const lines = ['0','MTEXT',this._common(),'100','AcDbMText',_point(this.point),'40',this.height];
    if (this.width !== null) lines.push('41', this.width);
    lines.push('71', attach, '72', '1');
    // > 250 chars: 250-char chunks in group 3, remainder in group 1
    const chunks = t.match(/[\s\S]{1,250}/g);
    chunks.slice(0, -1).forEach(c => lines.push('3', c));
    lines.push('1', chunks[chunks.length - 1]);
    if (this.style !== null) lines.push('7', this.style);
    lines.push(...this._extr());
    if (this.rotation !== null) lines.push('50', this.rotation);
    if (this.lineSpacing !== null) lines.push('73', '1', '44', this.lineSpacing);
    return [...lines, ...this._xdata()].join(NL);
  }
}

// ── Hatch ─────────────────────────────────────────────────────────────────────
// acadiso.pat pattern lines: [angle, baseX, baseY, offsetX, offsetY, ...dashes]
const HATCH_PATTERNS = {
  ANSI31: [[45, 0, 0, 0, 3.175]],                                       // general / brick / iron
  ANSI32: [[45, 0, 0, 0, 9.525], [45, 4.490128, 0, 0, 9.525]],          // steel
  ANSI37: [[45, 0, 0, 0, 3.175], [135, 0, 0, 0, 3.175]],                // lead / cross hatch
  NET:    [[0, 0, 0, 0, 3.175], [90, 0, 0, 0, 3.175]],
  DOTS:   [[0, 0, 0, 0.79375, 1.5875, 0, -1.5875]],
  EARTH:  [[0, 0, 0, 6.35, 6.35, 6.35, -6.35], [0, 0, 2.38125, 6.35, 6.35, 6.35, -6.35],
           [0, 0, 4.7625, 6.35, 6.35, 6.35, -6.35], [90, 0.79375, 5.55625, 6.35, 6.35, 6.35, -6.35],
           [90, 3.175, 5.55625, 6.35, 6.35, 6.35, -6.35], [90, 5.55625, 5.55625, 6.35, 6.35, 6.35, -6.35]],
};
/**
 * Hatch inside one or more closed boundaries (the first is the outer, the rest are holes).
 *   new Hatch([[0,0],[100,0],[100,50],[0,50]], { pattern: 'ANSI31', scale: 2 })
 *   new Hatch([outerPts, holePts], { pattern: 'SOLID', color: 8 })
 * A boundary is a point list or an LwPolyLine (its bulges are kept).
 * pattern: 'SOLID', a HATCH_PATTERNS name, or { name, lines: [[angle,bx,by,dx,dy,...dashes]] }.
 */
class Hatch extends Entity {
  constructor(boundaries, { pattern = 'SOLID', scale = 1, angle = 0, ...common } = {}) {
    super(common);
    const single = boundaries instanceof LwPolyLine || typeof boundaries?.[0]?.[0] === 'number';
    const list = single ? [boundaries] : boundaries;
    // Each path is [points, bulges|null] — plain arrays so DynamicBlock cloning deep-copies them.
    this.paths = list.map(b => b instanceof LwPolyLine
      ? [b.points.map(p => [p[0], p[1]]), b.bulges ? [...b.bulges] : (b.bulge !== null ? b.points.map(() => b.bulge) : null)]
      : [b.map(p => [p[0], p[1]]), null]);
    // 3+ points, or 2 points joined by arcs (e.g. a circle made of two bulges)
    if (!this.paths.length || this.paths.some(([p, bg]) => p.length < (bg && bg.some(x => x) ? 2 : 3)))
      throw new Error('Hatch boundaries need at least 3 points each (or 2 with bulges)');
    if (typeof pattern === 'string') {
      const name = pattern.toUpperCase();
      if (name !== 'SOLID' && !HATCH_PATTERNS[name])
        throw new Error(`Unknown hatch pattern '${pattern}'. Use SOLID, ${Object.keys(HATCH_PATTERNS).join(', ')} or { name, lines }`);
      this.pattern = { name, lines: HATCH_PATTERNS[name] || [] };
    } else this.pattern = { name: pattern.name.toUpperCase(), lines: pattern.lines };
    this.scale = scale; this.angle = angle;
  }
  get solid() { return this.pattern.name === 'SOLID'; }
  _pts() { return this.paths.flatMap(([pts]) => pts); }
  _transformExtra(info) {
    if (info.mirror) this.paths = this.paths.map(([p, b]) => [p, b && b.map(x => -x)]);
    this.angle = _normAngle(info.angle(this.angle)); this.scale *= info.s;
  }
  toString() {
    const lines = ['0','HATCH',this._common(),'100','AcDbHatch','10','0','20','0','30','0',
                   ...(this.extrusion ? this._extr() : ['210','0','220','0','230','1']),
                   '2',this.pattern.name,'70',this.solid ? 1 : 0,'71','0','91',this.paths.length];
    this.paths.forEach(([pts, bulges], i) => {
      const hasBulge = !!bulges && bulges.some(b => b);
      lines.push('92', i === 0 ? 3 : 2, '72', hasBulge ? 1 : 0, '73', '1', '93', pts.length);  // 1 external | 2 polyline
      pts.forEach((p, k) => { lines.push('10', p[0], '20', p[1]); if (hasBulge) lines.push('42', bulges[k] || 0); });
      lines.push('97', '0');
    });
    lines.push('75', '0', '76', '1');   // normal island style, predefined pattern
    if (!this.solid) {
      lines.push('52', this.angle, '41', this.scale, '77', '0', '78', this.pattern.lines.length);
      for (const [a, bx, by, dx, dy, ...dashes] of this.pattern.lines) {
        const base = _rot([bx * this.scale, by * this.scale], this.angle);
        const off = _rot([dx * this.scale, dy * this.scale], a + this.angle);
        lines.push('53', a + this.angle, '43', _num(base[0]), '44', _num(base[1]),
                   '45', _num(off[0]), '46', _num(off[1]), '79', dashes.length);
        dashes.forEach(d => lines.push('49', _num(d * this.scale)));
      }
    }
    lines.push('98', '0');
    return [...lines, ...this._xdata()].join(NL);
  }
}

// ── Ellipse / Spline ──────────────────────────────────────────────────────────
/**
 * Ellipse: majorAxis is the vector from the centre to the end of the major axis,
 * ratio = minor/major. start/end are parameters in radians (0..2π = full ellipse).
 */
class Ellipse extends Entity {
  constructor(center = [0,0,0], majorAxis = [1,0,0], ratio = 1, { start = 0, end = 2 * Math.PI, ...common } = {}) {
    super(common);
    if (!(ratio > 0)) throw new Error('Ellipse ratio must be > 0');
    if (ratio > 1) {   // DXF requires ratio <= 1: swap the axes
      majorAxis = _rot(majorAxis, 90).map(v => v * ratio); ratio = 1 / ratio;
      start -= Math.PI / 2; end -= Math.PI / 2;
    }
    this.center = center; this.majorAxis = [majorAxis[0], majorAxis[1]]; this.ratio = ratio;
    this.start = start; this.end = end;
  }
  _pts() { return [this.center]; }
  _bbox() {
    const [ax, ay] = this.majorAxis, bx = -ay * this.ratio, by = ax * this.ratio;
    const hx = Math.hypot(ax, bx), hy = Math.hypot(ay, by), [x, y] = this.center;
    return [[x - hx, y - hy], [x + hx, y + hy]];
  }
  _transformExtra(info) {
    const [a, b, c, d] = info.m, [x, y] = this.majorAxis;
    this.majorAxis = [_num(a * x + c * y), _num(b * x + d * y)];
    if (info.mirror) [this.start, this.end] = [2 * Math.PI - this.end, 2 * Math.PI - this.start];
  }
  toString() {
    return ['0','ELLIPSE',this._common(),'100','AcDbEllipse',_point(_xyz(this.center)),_point([...this.majorAxis, 0], 1),
            ...this._extr(),'40',this.ratio,'41',this.start,'42',this.end,...this._xdata()].join(NL);
  }
}

/**
 * B-spline through control points (clamped, so it starts and ends on the first
 * and last point). Spline.fromFitPoints(points) makes one that passes through
 * every point.
 */
class Spline extends Entity {
  constructor(controlPoints, { degree = 3, knots = null, ...common } = {}) {
    super(common);
    this.controlPoints = controlPoints.map(p => [p[0], p[1]]);
    const n = this.controlPoints.length;
    if (n < 2) throw new Error('Spline needs at least 2 control points');
    this.degree = Math.min(degree, n - 1);
    this.knots = knots || _clampedKnots(n, this.degree);
    if (this.knots.length !== n + this.degree + 1) throw new Error(`Spline: expected ${n + this.degree + 1} knots, got ${this.knots.length}`);
  }
  /** Global interpolation (The NURBS Book, A9.1) with chord-length parameters. */
  static fromFitPoints(points, { degree = 3, ...options } = {}) {
    const Q = points.map(p => [p[0], p[1]]), n = Q.length;
    if (n < 2) throw new Error('Spline needs at least 2 fit points');
    const p = Math.min(degree, n - 1);
    const d = Q.slice(1).map((q, i) => Math.hypot(q[0] - Q[i][0], q[1] - Q[i][1]));
    const total = d.reduce((a, b) => a + b, 0);
    if (!total) throw new Error('Spline fit points are all the same point');
    const u = [0]; d.forEach(di => u.push(u[u.length - 1] + di / total)); u[n - 1] = 1;
    const U = [...Array(p + 1).fill(0)];
    for (let j = 1; j < n - p; j++) U.push(u.slice(j, j + p).reduce((a, b) => a + b, 0) / p);
    U.push(...Array(p + 1).fill(1));
    const A = u.map(uk => Array.from({ length: n }, (_, i) => _basis(i, p, uk, U)));
    const P = _solve(A, Q);
    return new Spline(P, { degree: p, knots: U, ...options });
  }
  _pts() { return this.controlPoints; }
  toString() {
    const lines = ['0','SPLINE',this._common(),'100','AcDbSpline',
                   ...(this.extrusion ? this._extr() : ['210','0','220','0','230','1']),
                   '70','8','71',this.degree,'72',this.knots.length,'73',this.controlPoints.length,'74','0',
                   '42','0.0000000001','43','0.0000000001'];
    this.knots.forEach(k => lines.push('40', _num(k)));
    this.controlPoints.forEach(c => lines.push(_point([c[0], c[1], 0])));
    return [...lines, ...this._xdata()].join(NL);
  }
}
function _clampedKnots(n, p) {
  const inner = Array.from({ length: n - p - 1 }, (_, i) => i + 1);
  return [...Array(p + 1).fill(0), ...inner, ...Array(p + 1).fill(n - p)];
}
// Cox–de Boor basis function N(i,p) at u
function _basis(i, p, u, U) {
  if (p === 0) {
    // u at the very end belongs to the last non-empty span
    if (u === U[U.length - 1]) return U[i] < U[i + 1] && U[i + 1] === u ? 1 : 0;
    return U[i] <= u && u < U[i + 1] ? 1 : 0;
  }
  let a = 0, b = 0;
  if (U[i + p] !== U[i]) a = (u - U[i]) / (U[i + p] - U[i]) * _basis(i, p - 1, u, U);
  if (U[i + p + 1] !== U[i + 1]) b = (U[i + p + 1] - u) / (U[i + p + 1] - U[i + 1]) * _basis(i + 1, p - 1, u, U);
  return a + b;
}
// Solve A·X = B (B has 2 columns) by Gaussian elimination with partial pivoting
function _solve(A, B) {
  const n = A.length, M = A.map((r, i) => [...r, ...B[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    if (Math.abs(M[c][c]) < 1e-14) throw new Error('Spline interpolation failed (repeated fit points?)');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < n + 2; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => [_num(r[n] / r[i]), _num(r[n + 1] / r[i])]);
}

// ── Dimensions ────────────────────────────────────────────────────────────────
/**
 * Dimension style. Sizes are paper sizes; `scale` (DIMSCALE) multiplies them,
 * e.g. scale: 50 for a 1:50 drawing in mm. `measureScale` (DIMLFAC) multiplies
 * the measured value. tickSize > 0 draws oblique ticks instead of arrows.
 */
class DimStyle {
  constructor({ name = 'Standard', textHeight = 2.5, arrowSize = 2.5, tickSize = 0, extOffset = 0.625,
                extBeyond = 1.25, gap = 0.625, decimals = 0, angleDecimals = 0, scale = 1, measureScale = 1, suffix = '' } = {}) {
    Object.assign(this, { name, textHeight, arrowSize, tickSize, extOffset, extBeyond, gap, decimals, angleDecimals, scale, measureScale, suffix });
  }
  format(value) {
    return Number(value * this.measureScale).toFixed(this.decimals) + this.suffix;
  }
  toString() {
    const lines = ['0','DIMSTYLE','105',_nextHandle(),'330',_H_DIM_TBL,
                   '100','AcDbSymbolTableRecord','100','AcDbDimStyleTableRecord','2',this.name,'70','0'];
    if (this.suffix) lines.push('3', `<>${this.suffix}`);
    lines.push('40', this.scale, '41', this.arrowSize, '42', this.extOffset, '44', this.extBeyond,
               '73', '0', '74', '0', '77', '1', '140', this.textHeight, '142', this.tickSize,
               '144', this.measureScale, '147', this.gap, '172', '1', '179', this.angleDecimals, '271', this.decimals);
    return lines.join(NL);
  }
}

const _sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const _add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const _mul = (a, k) => [a[0] * k, a[1] * k];
const _dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const _unit = v => { const l = Math.hypot(v[0], v[1]); return l > 1e-12 ? [v[0] / l, v[1] / l] : [1, 0]; };
const _xyz = p => [p[0], p[1], p[2] || 0];
const _BYBLOCK = { layer: '0', color: 0 };   // dimension geometry follows the DIMENSION's layer/colour

/** Arrowhead (or oblique tick) with its tip at `tip`; `dir` points from the tip into the dimension. */
function _arrow(tip, dir, style) {
  const s = style.scale;
  if (style.tickSize > 0) {
    const w = _mul(_rot(dir, 45), style.tickSize * s / 2);
    return new Line([_xyz(_sub(tip, w)), _xyz(_add(tip, w))], _BYBLOCK);
  }
  const a = style.arrowSize * s, n = _rot(dir, 90), back = _add(tip, _mul(dir, a));
  const b1 = _add(back, _mul(n, a / 6)), b2 = _sub(back, _mul(n, a / 6));
  return new Solid([_xyz(tip), _xyz(b1), _xyz(b2), _xyz(b2)], _BYBLOCK);
}
/** Text above a line at angle `ang` through `pt`, rotated to read left→right / bottom→top. */
function _dimText(txt, pt, ang, style) {
  let ta = _normAngle(ang);
  if (ta > 90 && ta <= 270) ta -= 180;
  const pos = _add(pt, _mul(_rot([0, 1], ta), (style.gap + style.textHeight / 2) * style.scale));
  return { ent: new Text(txt, _xyz(pos), { height: style.textHeight * style.scale, rotation: ta, align: 'MIDDLE_CENTER', ..._BYBLOCK }), pos };
}

/** Base class: subclasses implement _render(style) → { ents, defpoint, textPt, measurement, type, sub }. */
class Dimension extends Entity {
  constructor({ text = null, dimstyle = 'Standard', ...common } = {}) {
    super(common); this.text = text; this.dimstyle = dimstyle; this._block = null;
  }
  _bbox() { return this._block ? this._block._bbox() : _bboxOf(this._pts()); }
  _label(value) { return this.text === null ? value : String(this.text).replace('<>', value); }
  /** Build the anonymous *D block that holds what AutoCAD displays. */
  _buildBlock(name, style) {
    this._r = this._render(style);
    this._block = new Block(name, { flag: 1, entities: this._r.ents });   // flag 1 = anonymous
    this._styleName = style.name;
    return this._block;
  }
  toString() {
    if (!this._block) throw new Error('Dimensions must be written through a Drawing (it builds their *D blocks)');
    const r = this._r;
    const lines = ['0','DIMENSION',this._common(),'100','AcDbDimension','2',this._block.name,
                   _point(_xyz(r.defpoint)),_point(_xyz(r.textPt), 1),'70',r.type | 32,'71','5','42',r.measurement];
    if (this.text !== null) lines.push('1', this.text);
    lines.push('3', this._styleName, ...r.sub);
    return [...lines, ...this._xdata()].join(NL);
  }
}

/**
 * Linear (rotated) dimension between p1 and p2 measured along `angle`
 * (0 = horizontal, 90 = vertical); the dimension line passes through `base`.
 * Same argument order idea as ezdxf's add_linear_dim(base, p1, p2, angle).
 *   new LinearDimension([0,0], [2350,0], [0,-400], { dimstyle: 'S50' })
 * `text`: override, '<>' is replaced by the measurement.
 */
class LinearDimension extends Dimension {
  constructor(p1, p2, base, { angle = 0, ...options } = {}) {
    super(options); this.p1 = p1; this.p2 = p2; this.base = base; this.angle = angle;
  }
  get aligned() { return false; }
  _pts() { return [this.p1, this.p2, this.base]; }
  _transformExtra(info) { this.angle = _normAngle(info.angle(this.angle)); }
  _dir() { return this.angle; }
  _basePoint() { return this.base; }
  _render(style) {
    const ang = this._dir(), u = _rot([1, 0], ang), base = this._basePoint(), s = style.scale;
    const d1 = _add(base, _mul(u, _dot(_sub(this.p1, base), u)));
    const d2 = _add(base, _mul(u, _dot(_sub(this.p2, base), u)));
    const measurement = Math.abs(_dot(_sub(this.p2, this.p1), u));
    const ents = [];
    for (const [p, d] of [[this.p1, d1], [this.p2, d2]]) {   // extension lines
      const v = _sub(d, p);
      if (Math.hypot(...v) < 1e-9) continue;
      const n = _unit(v);
      ents.push(new Line([_xyz(_add(p, _mul(n, style.extOffset * s))), _xyz(_add(d, _mul(n, style.extBeyond * s)))], _BYBLOCK));
    }
    ents.push(new Line([_xyz(d1), _xyz(d2)], _BYBLOCK));
    const v = Math.hypot(..._sub(d2, d1)) > 1e-9 ? _unit(_sub(d2, d1)) : u;
    ents.push(_arrow(d1, v, style), _arrow(d2, _mul(v, -1), style));
    const t = _dimText(this._label(style.format(measurement)), _mul(_add(d1, d2), 0.5), ang, style);
    ents.push(t.ent);
    const sub = ['100', 'AcDbAlignedDimension', _point(_xyz(this.p1), 3), _point(_xyz(this.p2), 4)];
    if (!this.aligned) sub.push('50', this.angle, '100', 'AcDbRotatedDimension');
    return { ents, defpoint: d2, textPt: t.pos, measurement, type: this.aligned ? 1 : 0, sub };
  }
}
/**
 * Dimension parallel to p1→p2, offset `distance` to the left of p1→p2
 * (negative = right). Same as ezdxf's add_aligned_dim(p1, p2, distance).
 */
class AlignedDimension extends LinearDimension {
  constructor(p1, p2, distance, options = {}) {
    super(p1, p2, null, options); this.distance = distance;
  }
  get aligned() { return true; }
  _pts() { return [this.p1, this.p2]; }
  _transformExtra(info) { this.distance *= info.mirror ? -info.s : info.s; }
  _dir() { return Math.atan2(this.p2[1] - this.p1[1], this.p2[0] - this.p1[0]) * 180 / Math.PI; }
  _basePoint() { return _add(this.p1, _mul(_rot([0, 1], this._dir()), this.distance)); }
}
/** Radius of an arc/circle at `center`, drawn at `angle` degrees: R250. */
class RadiusDimension extends Dimension {
  constructor(center, radius, { angle = 45, ...options } = {}) {
    super(options); this.center = center; this.point = _add(center, _rot([radius, 0], angle));
  }
  _pts() { return [this.center, this.point]; }
  _render(style) {
    const r = Math.hypot(..._sub(this.point, this.center)), u = _unit(_sub(this.point, this.center));
    const ents = [new Line([_xyz(this.center), _xyz(this.point)], _BYBLOCK), _arrow(this.point, _mul(u, -1), style)];
    const t = _dimText(this._label('R' + style.format(r)), _mul(_add(this.center, this.point), 0.5), Math.atan2(u[1], u[0]) * 180 / Math.PI, style);
    ents.push(t.ent);
    return { ents, defpoint: this.center, textPt: t.pos, measurement: r, type: 4,
             sub: ['100', 'AcDbRadialDimension', _point(_xyz(this.point), 5), '40', '0'] };
  }
}
/** Diameter of a circle at `center`, across the circle at `angle` degrees: Ø500 (%%c). */
class DiameterDimension extends Dimension {
  constructor(center, radius, { angle = 45, ...options } = {}) {
    super(options); this.center = center; this.point = _add(center, _rot([radius, 0], angle));
  }
  _pts() { return [this.center, this.point]; }
  _render(style) {
    const far = _sub(_mul(this.center, 2), this.point), u = _unit(_sub(this.point, this.center));
    const dia = 2 * Math.hypot(..._sub(this.point, this.center));
    const ents = [new Line([_xyz(far), _xyz(this.point)], _BYBLOCK), _arrow(this.point, _mul(u, -1), style), _arrow(far, u, style)];
    const t = _dimText(this._label('%%c' + style.format(dia)), this.center, Math.atan2(u[1], u[0]) * 180 / Math.PI, style);
    ents.push(t.ent);
    return { ents, defpoint: far, textPt: t.pos, measurement: dia, type: 3,
             sub: ['100', 'AcDbDiametricDimension', _point(_xyz(this.point), 5), '40', '0'] };
  }
}
/**
 * Angle at `vertex` measured anticlockwise from the line vertex→p1 to vertex→p2,
 * drawn as an arc of `radius` (default: 60 % of the shorter line).
 */
class AngularDimension extends Dimension {
  constructor(vertex, p1, p2, { radius = null, ...options } = {}) {
    super(options); this.vertex = vertex; this.p1 = p1; this.p2 = p2;
    this.radius = radius ?? 0.6 * Math.min(Math.hypot(..._sub(p1, vertex)), Math.hypot(..._sub(p2, vertex)));
  }
  _pts() { return [this.vertex, this.p1, this.p2]; }
  _transformExtra(info) {
    this.radius *= info.s;
    if (info.mirror) [this.p1, this.p2] = [this.p2, this.p1];   // keep it anticlockwise
  }
  _render(style) {
    const v = this.vertex, R = this.radius, s = style.scale;
    const a1 = Math.atan2(this.p1[1] - v[1], this.p1[0] - v[0]) * 180 / Math.PI;
    const a2 = Math.atan2(this.p2[1] - v[1], this.p2[0] - v[0]) * 180 / Math.PI;
    const sweep = _normAngle(a2 - a1);
    const ents = [new Arc(_xyz(v), R, _normAngle(a1), _normAngle(a2), _BYBLOCK)];
    for (const [p, a] of [[this.p1, a1], [this.p2, a2]]) {   // extension lines when the arc is beyond the lines
      const d = Math.hypot(..._sub(p, v)), u = _rot([1, 0], a);
      if (d < R) ents.push(new Line([_xyz(_add(v, _mul(u, d + style.extOffset * s))), _xyz(_add(v, _mul(u, R + style.extBeyond * s)))], _BYBLOCK));
    }
    const e1 = _add(v, _rot([R, 0], a1)), e2 = _add(v, _rot([R, 0], a2));
    ents.push(_arrow(e1, _rot([1, 0], a1 + 90), style), _arrow(e2, _rot([1, 0], a2 - 90), style));
    const am = a1 + sweep / 2, mid = _add(v, _rot([R, 0], am));
    const t = _dimText(this._label(sweep.toFixed(style.angleDecimals) + '%%d'), mid, am - 90, style);
    ents.push(t.ent);
    return { ents, defpoint: mid, textPt: t.pos, measurement: sweep * Math.PI / 180, type: 5,
             sub: ['100', 'AcDb3PointAngularDimension', _point(_xyz(this.p1), 3), _point(_xyz(this.p2), 4), _point(_xyz(v), 5)] };
  }
}

// ── Leader ────────────────────────────────────────────────────────────────────
/**
 * Leader line with an arrow at the first point and optional MText at the last.
 *   new Leader([[100,100],[250,250],[400,250]], 'T16 @ 200 B1', { dimstyle: 'S50' })
 * Arrow size and text height come from the dimstyle (× its scale) unless `height` is given.
 */
class Leader extends Entity {
  constructor(points, text = null, { dimstyle = 'Standard', height = null, ...common } = {}) {
    super(common);
    if (!points || points.length < 2) throw new Error('Leader needs at least 2 points');
    this.points = points; this.text = text; this.dimstyle = dimstyle; this.height = height; this._style = null;
  }
  _pts() { return this.points; }
  _transformExtra(info) { if (this.height !== null) this.height *= info.s; }
  _mtext() {
    if (this.text === null || this.text === '') return null;
    const style = this._style || (this.dimstyle instanceof DimStyle ? this.dimstyle : new DimStyle());
    const n = this.points.length, last = this.points[n - 1], prev = this.points[n - 2];
    const right = last[0] >= prev[0];
    const off = style.gap * style.scale * (right ? 1 : -1);
    return new MText(this.text, [last[0] + off, last[1], 0], {
      height: this.height ?? style.textHeight * style.scale, attach: right ? 'MIDDLE_LEFT' : 'MIDDLE_RIGHT',
      layer: this.layer, color: this.color, parent: this.parent });
  }
  _bbox() { return _union([_bboxOf(this.points), this._mtext()?._bbox()]); }
  toString() {
    const style = this._style || (this.dimstyle instanceof DimStyle ? this.dimstyle : new DimStyle());
    const mt = this._mtext();
    const lines = ['0','LEADER',this._common(),'100','AcDbLeader','3',style.name,'71','1','72','0','73','3',
                   '74','0','75','0','40',mt ? mt.height : 0,'41','0','76',this.points.length];
    this.points.forEach(p => lines.push(_point(_xyz(p))));
    lines.push(...this._extr(), ...this._xdata());
    if (mt) lines.push(mt.toString());
    return lines.join(NL);
  }
}

// ── Main Drawing class ────────────────────────────────────────────────────────
class Drawing extends Collection {
  /**
   * units: 'mm' | 'cm' | 'm' | 'km' | 'in' | 'ft' | null (unitless)
   * extmin/extmax: null = calculated from the entities (also zooms the *ACTIVE viewport)
   */
  constructor({ insbase = [0,0,0], extmin = null, extmax = null,
                layers = [new Layer()], linetypes = [new LineType()], styles = [new Style()],
                dimstyles = [new DimStyle()], views = [], blocks = [], entities = [],
                units = null, ltscale = 1 } = {}) {
    super(entities);
    this.insbase = insbase; this.extmin = extmin; this.extmax = extmax;
    this.layers = [...layers]; this.linetypes = [...linetypes]; this.styles = [...styles];
    this.dimstyles = [...dimstyles]; this.views = [...views]; this.blocks = [...blocks];
    this.units = units; this.ltscale = ltscale;
    if (!this.dimstyles.some(s => s.name.toUpperCase() === 'STANDARD')) this.dimstyles.unshift(new DimStyle());
  }
  /** Approximate [[xmin,ymin],[xmax,ymax]] of model space (call after adding entities). */
  extents() {
    this._collectBlocks();   // dimensions need their geometry for an accurate box
    return _union(this.entities.map(e => e._bbox())) || [[0, 0], [0, 0]];
  }
  _dimstyle(ref) {
    if (ref instanceof DimStyle) return ref;
    const s = this.dimstyles.find(d => d.name.toUpperCase() === String(ref).toUpperCase());
    if (!s) throw new Error(`Unknown dimstyle '${ref}'. Defined: ${this.dimstyles.map(d => d.name).join(', ')}`);
    return s;
  }
  // Add mandatory table records, presets and layers that entities reference.
  _resolveTables(blocks) {
    const ents = [...this.entities, ...blocks.flatMap(b => b.entities)];
    const has = (list, n) => list.some(x => x.name.toUpperCase() === String(n).toUpperCase());
    if (!has(this.layers, '0')) this.layers.unshift(new Layer({ name: '0', color: 7 }));
    for (const e of ents) {
      const l = (e.parent || e).layer;
      if (l && !has(this.layers, l)) this.layers.push(new Layer({ name: String(l), color: 7 }));
    }
    const lts = this.linetypes.filter(t => !['BYBLOCK', 'BYLAYER', 'CONTINUOUS'].includes(t.name));
    const fixed = ['BYBLOCK', 'BYLAYER'].map(n => new LineType({ name: n, description: '' }));
    fixed.push(this.linetypes.find(t => t.name === 'CONTINUOUS') || new LineType());
    for (const n of [...this.layers.map(l => l.lineType), ...ents.map(e => (e.parent || e).lineType)]) {
      if (n === null || n === undefined || has(fixed, n) || has(lts, n)) continue;
      if (!LINETYPE_PRESETS[String(n).toUpperCase()])
        throw new Error(`Linetype '${n}' is used but not defined. Add a LineType or use a preset: ${Object.keys(LINETYPE_PRESETS).join(', ')}`);
      lts.push(LineType.preset(n));
    }
    this.linetypes = [...fixed, ...lts];
  }
  _unitVars() {
    if (this.units === null) return [];
    const codes = { in: 1, ft: 2, mi: 3, mm: 4, cm: 5, m: 6, km: 7 };
    const u = codes[String(this.units).toLowerCase()];
    if (!u) throw new Error(`Unknown units '${this.units}'. Use one of: ${Object.keys(codes).join(', ')}`);
    return [['9','$INSUNITS','70',u].join(NL), ['9','$MEASUREMENT','70',u <= 3 ? 0 : 1].join(NL)];
  }
  _section(name, items) {
    const f = (items || []).filter(s => s && s.trim());
    const x = f.length > 0 ? NL + f.join(NL) : '';
    return ['0','SECTION','2',name.toUpperCase()+x,'0','ENDSEC'].join(NL);
  }
  _table(name, handle, parentHandle, items) {
    const f = (items || []).filter(s => s && s.trim());
    const x = f.length > 0 ? NL + f.join(NL) : '';
    return ['0','TABLE','2',name.toUpperCase(),'5',handle,'330',parentHandle,
            '100','AcDbSymbolTable','70',f.length+x,'0','ENDTAB'].join(NL);
  }
  // Every block definition the drawing needs: this.blocks plus anything an
  // Insert references (recursively), with dynamic block variants expanded.
  _collectBlocks() {
    const out = [], seen = new Set(), names = new Map();
    let dimCount = 0;
    const add = b => {
      if (!(b instanceof Block) || seen.has(b)) return;
      seen.add(b);
      for (const d of b._definitions()) {
        if (d !== b) { if (seen.has(d)) continue; seen.add(d); }
        const n = d.name.toUpperCase();
        if (names.has(n) && names.get(n) !== d) throw new Error(`Two different blocks are named '${n}'`);
        names.set(n, d); out.push(d);
        for (const e of d.entities) visit(e);
      }
    };
    const visit = e => {
      if (e instanceof Insert) { add(e.source); add(e.block); }
      if (e instanceof Leader) e._style = this._dimstyle(e.dimstyle);
      if (e instanceof Dimension && !seen.has(e)) {
        seen.add(e);
        out.push(e._buildBlock(`*D${++dimCount}`, this._dimstyle(e.dimstyle)));
      }
    };
    this.blocks.forEach(add);
    this.entities.forEach(visit);
    return out;
  }
  _appids(blocks) {
    const ids = new Set(['ACAD']);
    const scan = e => {
      if (e.xdata) Object.keys(e.xdata).forEach(k => ids.add(k.toUpperCase()));
      if (e instanceof Insert && e.params) ids.add(DYN_APPID);
    };
    this.entities.forEach(scan);
    blocks.forEach(b => b.entities.forEach(scan));
    return [...ids];
  }
  toString() {
    _resetHandles();
    _preAllocHandles();
    _owner = null;
    const userBlocks = this._collectBlocks();
    for (const b of userBlocks) b._btrHandle = _nextHandle();
    this._resolveTables(userBlocks);
    const auto = _union(this.entities.map(e => e._bbox())) || [[0, 0], [0, 0]];
    const extmin = this.extmin || auto[0], extmax = this.extmax || auto[1];
    const H_ROOTDICT = _nextHandle(), H_GROUPDICT = _nextHandle();

    // ── TABLES ──────────────────────────────────────────────────
    const btr = (h, name) => ['0','BLOCK_RECORD','5',h,'330',_H_BLOCKTABLE,
       '100','AcDbSymbolTableRecord','100','AcDbBlockTableRecord',
       '2',name,'70','0','280','1','281','0'].join(NL);
    const brDefs = [
      btr(_H_MODEL_BTR, '*Model_Space'),
      btr(_H_PAPER_BTR, '*Paper_Space'),
      ...userBlocks.map(b => btr(b._btrHandle, b.name.toUpperCase())),
    ];
    const brTable = ['0','TABLE','2','BLOCK_RECORD','5',_H_BLOCKTABLE,'330','0',
                     '100','AcDbSymbolTable','70',
                     brDefs.length+NL+brDefs.join(NL),   // count+content as one element — no leading blank line
                     '0','ENDTAB'].join(NL);

    const appidDefs = this._appids(userBlocks).map(name =>
                      ['0','APPID','5',_nextHandle(),'330',_H_APPID_TBL,
                       '100','AcDbSymbolTableRecord','100','AcDbRegAppTableRecord',
                       '2',name,'70','0'].join(NL));
    // *ACTIVE viewport zoomed to the extents (assumes a ~16:10 window)
    const [cx, cy] = [(extmin[0] + extmax[0]) / 2, (extmin[1] + extmax[1]) / 2];
    const aspect = 1.6;
    const viewH = Math.max(extmax[1] - extmin[1], (extmax[0] - extmin[0]) / aspect, 1) * 1.1;
    const vport = ['0','VPORT','5',_nextHandle(),'330',_H_VPORT_TBL,
                   '100','AcDbSymbolTableRecord','100','AcDbViewportTableRecord',
                   '2','*ACTIVE','70','0','10','0','20','0','11','1','21','1','12',cx,'22',cy,
                   '13','0','23','0','14','10','24','10','15','10','25','10','16','0','26','0','36','1',
                   '17','0','27','0','37','0','40',viewH,'41',aspect,'42','50','43','0','44','0',
                   '50','0','51','0','71','0','72','1000','73','1','74','3','75','0','76','0','77','0','78','0'].join(NL);

    const tables = this._section('tables', [
      this._table('VPORT',    _H_VPORT_TBL, '0', [vport]),
      this._table('LTYPE',    _H_LTYPE_TBL, '0', this.linetypes.map(x => x.toString())),
      this._table('LAYER',    _H_LAYER_TBL, '0', this.layers.map(x => x.toString())),
      this._table('STYLE',    _H_STYLE_TBL, '0', this.styles.map(x => x.toString())),
      this._table('VIEW',     _H_VIEW_TBL,  '0', this.views.map(x => x.toString())),
      this._table('UCS',      _H_UCS_TBL,   '0', []),
      this._table('APPID',    _H_APPID_TBL, '0', appidDefs),
      this._table('DIMSTYLE', _H_DIM_TBL,   '0', this.dimstyles.map(x => x.toString())),
      brTable,
    ]);

    // ── BLOCKS — mandatory *Model_Space and *Paper_Space ─────────
    const modelBlock = [
      '0','BLOCK','5',_nextHandle(),'330',_H_MODEL_BTR,'100','AcDbEntity','8','0',
      '100','AcDbBlockBegin','2','*Model_Space','70','0',_point([0,0,0]),'3','*Model_Space','1','',
      '0','ENDBLK','5',_nextHandle(),'330',_H_MODEL_BTR,'100','AcDbEntity','8','0','100','AcDbBlockEnd',
    ].join(NL);
    const paperBlock = [
      '0','BLOCK','5',_nextHandle(),'330',_H_PAPER_BTR,'100','AcDbEntity','8','0',
      '100','AcDbBlockBegin','2','*Paper_Space','70','0',_point([0,0,0]),'3','*Paper_Space','1','',
      '0','ENDBLK','5',_nextHandle(),'330',_H_PAPER_BTR,'100','AcDbEntity','8','0','100','AcDbBlockEnd',
    ].join(NL);
    const blocks = this._section('blocks', [modelBlock, paperBlock, ...userBlocks.map(x => x.toString())]);

    // ── ENTITIES ─────────────────────────────────────────────────
    _owner = _H_MODEL_BTR;
    const entities = this._section('entities', this.entities.map(x => x.toString()));
    _owner = null;

    // ── OBJECTS — root dictionary required for AC1015 ────────────
    const objects = this._section('objects', [
      ['0','DICTIONARY','5',H_ROOTDICT,'330','0','100','AcDbDictionary','281','1',
       '3','ACAD_GROUP','350',H_GROUPDICT].join(NL),
      ['0','DICTIONARY','5',H_GROUPDICT,'330',H_ROOTDICT,'100','AcDbDictionary','281','1'].join(NL),
    ]);

    // ── HEADER — written last so $HANDSEED is above every handle used ──
    const header = this._section('header', [
      ['9','$ACADVER','1','AC1015'].join(NL),
      ['9','$DWGCODEPAGE','3','ANSI_1252'].join(NL),
      ['9','$HANDSEED','5',_nextHandle()].join(NL),
      ['9','$INSBASE',  _point(this.insbase)].join(NL),
      ['9','$EXTMIN',   _point(_xyz(extmin))].join(NL),
      ['9','$EXTMAX',   _point(_xyz(extmax))].join(NL),
      ['9','$LTSCALE','40',this.ltscale].join(NL),
      ...this._unitVars(),
    ]);

    // R2000 DXF is not UTF-8: write non-ASCII characters (², °, Ø, …) as \U+XXXX escapes.
    return [header, tables, blocks, entities, objects, '0', 'EOF', ''].join(NL)
      .replace(/[^\x00-\x7F]/gu, ch => {
        const cp = ch.codePointAt(0);
        return cp > 0xFFFF ? '?' : '\\U+' + cp.toString(16).toUpperCase().padStart(4, '0');
      });
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Drawing, Layer, LineType, Style, DimStyle, Block, DynamicBlock, Insert, AttDef, Attrib,
    LinearParameter, FlipParameter, VisibilityParameter,
    Line, LwPolyLine, Circle, Arc, Ellipse, Spline, Point, Text, MText, Solid, Hatch, Leader,
    Dimension, LinearDimension, AlignedDimension, RadiusDimension, DiameterDimension, AngularDimension,
    Collection, Entity, arrayRect, arrayPolar, calculate_end_point, HATCH_PATTERNS, LINETYPE_PRESETS,
  };
}
