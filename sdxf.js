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
 * Groups, XLine/Ray, Wipeout, OrdinateDimension, MLeader (MULTILEADER, text or
 * block content), Table, Image/ImageDef (linked raster images),
 * paper-space sheets: Drawing.addLayout + Layout.addViewport; {{field}} text
 * fields resolved per sheet at write time (layout, sheet, scale, date, properties).
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
// Groups of the top-level entity being written: its model-space pieces get
// ACAD_REACTORS to these groups and are recorded as members.
let _groupCtx = null;
// Field context while writing: resolves {{name}} / {{name:format}} in text.
let _fieldCtx = null;
const _FIELD_RE = /\{\{\s*([A-Za-z_][\w.\- ]*?)\s*(?::([^}]*))?\}\}/g;
function _fields(s) {
  if (!_fieldCtx || typeof s !== 'string' || !s.includes('{{')) return s;
  return s.replace(_FIELD_RE, (_, name, fmt) => _fieldCtx(name, fmt));
}
const _MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Date format tokens: YYYY YY MMM MM DD HH mm (anything else is literal). */
function _formatDate(d, fmt = 'YYYY-MM-DD') {
  const p = n => String(n).padStart(2, '0');
  const tokens = { YYYY: d.getFullYear(), YY: p(d.getFullYear() % 100), MMM: _MONTHS[d.getMonth()], MM: p(d.getMonth() + 1),
                   DD: p(d.getDate()), HH: p(d.getHours()), mm: p(d.getMinutes()) };
  return fmt.replace(/YYYY|YY|MMM|MM|DD|HH|mm/g, t => tokens[t]);
}
// True while writing a paper-space layout: entities get group 67 = 1.
let _paper = false;
// Handles that MULTILEADER needs (set by Drawing.toString before the entities).
let _H_MLSTYLE = null, _H_TEXTSTYLE = null, _H_LT_BYBLOCK = null;
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
    const lines = ['5', handle];
    if (_groupCtx && owner === _H_MODEL_BTR) {
      lines.push('102', '{ACAD_REACTORS', ..._groupCtx.flatMap(g => ['330', g._handle]), '102', '}');
      _groupCtx.forEach(g => g._members.push(handle));
    }
    lines.push('330', owner, '100', 'AcDbEntity');
    if (_paper) lines.push('67', '1');
    lines.push('8', parent.layer);
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
  const lines = ['100','AcDbText',_point(e.point),'40',e.height,'1',_fields(value)];
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
    const lines = ['0','LAYER','5',this._handle = _nextHandle(),'330',_H_LAYER_TBL,
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
    const lines = ['0','LTYPE','5',this._handle = _nextHandle(),'330',_H_LTYPE_TBL,
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
    return ['0','STYLE','5',this._handle = _nextHandle(),'330',_H_STYLE_TBL,
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
      lines.push('0','SEQEND','5',_nextHandle(),'330',h,'100','AcDbEntity',...(_paper ? ['67', '1'] : []),'8',(this.parent || this).layer);
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
    const t = _fields(String(this.text ?? '')).replace(/\r?\n/g, '\\P');
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
  _label(value) { return this.text === null ? value : _fields(String(this.text)).replace('<>', value); }
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

/**
 * Ordinate dimension: the X or Y distance of `feature` from `origin`, with a
 * leader to `leaderEnd`. axis: 'x' | 'y' (default: 'x' when the leader is
 * mostly vertical, as in AutoCAD).
 */
class OrdinateDimension extends Dimension {
  constructor(feature, leaderEnd, { origin = [0, 0], axis = null, ...options } = {}) {
    super(options); this.feature = feature; this.leaderEnd = leaderEnd; this.origin = origin; this.axis = axis;
    if (axis !== null && axis !== 'x' && axis !== 'y') throw new Error(`OrdinateDimension axis must be 'x' or 'y'`);
  }
  _pts() { return [this.feature, this.leaderEnd]; }
  _transformExtra(info) { this.origin = [...this.origin]; _apply(info.m, this.origin); }
  _render(style) {
    const f = this.feature, e = this.leaderEnd, s = style.scale;
    const axis = this.axis || (Math.abs(e[1] - f[1]) >= Math.abs(e[0] - f[0]) ? 'x' : 'y');
    const value = axis === 'x' ? f[0] - this.origin[0] : f[1] - this.origin[1];
    const u = _unit(_sub(e, f)), ang = Math.atan2(u[1], u[0]) * 180 / Math.PI;
    const ents = [new Line([_xyz(_add(f, _mul(u, style.extOffset * s))), _xyz(e)], _BYBLOCK)];
    const flip = _normAngle(ang) > 90 && _normAngle(ang) <= 270;   // keep the text readable
    const pos = _add(e, _mul(u, style.gap * s));
    ents.push(new Text(this._label(style.format(value)), _xyz(pos), { height: style.textHeight * s,
      rotation: _normAngle(flip ? ang - 180 : ang), align: flip ? 'MIDDLE_RIGHT' : 'MIDDLE_LEFT', ..._BYBLOCK }));
    return { ents, defpoint: this.origin, textPt: pos, measurement: value, type: 6 | (axis === 'x' ? 64 : 0),
             sub: ['100', 'AcDbOrdinateDimension', _point(_xyz(f), 3), _point(_xyz(e), 4)] };
  }
}

// ── Construction lines, wipeout ───────────────────────────────────────────────
/** Infinite construction line through `point` along `direction`. */
class XLine extends Entity {
  constructor(point, direction, common = {}) {
    super(common); this.point = point; this.direction = _unit(direction);
  }
  get _type() { return ['XLINE', 'AcDbXline']; }
  _pts() { return [this.point]; }
  _transformExtra(info) {
    const [a, b, c, d] = info.m, [x, y] = this.direction;
    this.direction = _unit([a * x + c * y, b * x + d * y]).map(_num);
  }
  toString() {
    const [type, sub] = this._type;
    return ['0', type, this._common(), '100', sub, _point(_xyz(this.point)), _point([...this.direction, 0], 1), ...this._xdata()].join(NL);
  }
}
/** Construction line starting at `point`, infinite along `direction`. */
class Ray extends XLine {
  get _type() { return ['RAY', 'AcDbRay']; }
}
/**
 * Wipeout: a polygon that masks whatever was drawn before it (draw order is file
 * order, so append the wipeout before the text that sits on top of it).
 */
class Wipeout extends Entity {
  constructor(points, common = {}) {
    super(common);
    if (!points || points.length < 3) throw new Error('Wipeout needs at least 3 points');
    this.points = points.map(p => [p[0], p[1]]);
  }
  _pts() { return this.points; }
  toString() {
    const [[x0, y0], [x1, y1]] = _bboxOf(this.points), w = x1 - x0, h = y1 - y0;
    if (!(w > 0 && h > 0)) throw new Error('Wipeout boundary has no area');
    // boundary in image pixel coordinates of a 1×1 image: x right, y down, centred on 0
    const px = [...this.points, this.points[0]].map(([x, y]) => [_num((x - x0) / w - 0.5), _num(0.5 - (y - y0) / h)]);
    const lines = ['0','WIPEOUT',this._common(),'100','AcDbWipeout','90','0',_point([x0, y0, 0]),
                   _point([w, 0, 0], 1),_point([0, h, 0], 2),_point([1, 1], 3),'340','0','70','7',
                   '280','1','281','50','282','50','283','0','360','0','71','2','91',px.length];
    px.forEach(([x, y]) => lines.push('14', x, '24', y));
    return [...lines, ...this._xdata()].join(NL);
  }
}

// ── Multileader ───────────────────────────────────────────────────────────────
/**
 * Block with its non-constant AttDefs turned into fixed Text, one block per set
 * of values (R2000 MULTILEADERs cannot carry attribute values).
 */
function _attribVariant(block, values) {
  const vals = Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [_tag(k), String(v)]));
  const tags = new Set(block.attdefs.map(a => a.tag));
  const bad = Object.keys(vals).filter(t => !tags.has(t));
  if (bad.length) throw new Error(`Block '${block.name}' has no attribute(s) ${bad.join(', ')}. Valid: ${[...tags].join(', ') || '(none)'}`);
  if (!block.attdefs.length) return block;
  const used = block.attdefs.filter(a => !(a.flags & 1)).map(a => [a.tag, vals[a.tag] ?? a.defaultValue]);
  const name = block.name.toUpperCase() + used.map(([t, v]) => `__${t}-${_key(v)}`).join('');
  block._attVariants = block._attVariants || new Map();
  if (block._attVariants.has(name)) return block._attVariants.get(name);
  const ents = block.entities.flatMap(e => {
    if (!(e instanceof AttDef)) return [e];
    if (e.flags & 1) return [];   // invisible
    const t = new Text(vals[e.tag] ?? e.defaultValue, e.point, { height: e.height, rotation: e.rotation, style: e.style,
      align: e.align, alignPoint: e.alignPoint, layer: e.layer, color: e.color });
    return [t];
  });
  const v = new Block(name, { layer: block.layer, base: block.base, entities: ents });
  block._attVariants.set(name, v);
  return v;
}

/**
 * MULTILEADER. `points` run from the arrow tip to the connection point; a
 * horizontal landing (dogleg) and the content follow, on the side the last
 * segment points to. Content is MText or a block:
 *   new MLeader([[0,0],[300,400]], 'T16 @ 200 B1', { dimstyle: 'S50' })
 *   new MLeader([[0,0],[300,400]], { block: bubble, attributes: { NUM: 'A' } }, { dimstyle: 'S50' })
 * Sizes default from the dimstyle (× its scale): text height, arrow size, gap;
 * dogleg = 2 × arrow size. Giving `height` scales arrow, gap and dogleg with it.
 * A block is drawn at its own size × the same factor (or `blockScale`), centred
 * on the end of the landing (like AutoCAD's "center extents" connection).
 */
class MLeader extends Entity {
  constructor(points, content, { dimstyle = 'Standard', height = null, arrowSize = null, dogleg = null, gap = null,
                                 blockScale = null, ...common } = {}) {
    super(common);
    if (!points || points.length < 2) throw new Error('MLeader needs at least 2 points (arrow tip … connection point)');
    if (content instanceof Block) content = { block: content };
    if (content && typeof content === 'object') {
      if (!(content.block instanceof Block)) throw new Error('MLeader block content needs { block: Block, attributes? }');
      this.block = _attribVariant(content.block, content.attributes);
      this.text = null;
    } else {
      if (content === null || content === undefined || String(content) === '') throw new Error('MLeader needs text or a block');
      this.text = String(content); this.block = null;
    }
    this.points = points; this.dimstyle = dimstyle; this.blockScale = blockScale;
    this.height = height; this.arrowSize = arrowSize; this.dogleg = dogleg; this.gap = gap; this._style = null;
  }
  _pts() { return this.points; }
  _transformExtra(info) {
    for (const k of ['height', 'arrowSize', 'dogleg', 'gap', 'blockScale']) if (this[k] !== null) this[k] *= info.s;
  }
  _layout() {
    const st = this._style || (this.dimstyle instanceof DimStyle ? this.dimstyle : new DimStyle());
    // a given text height scales the other sizes with it
    const k = this.height !== null ? this.height / st.textHeight : st.scale;
    const h = st.textHeight * k, arrow = this.arrowSize ?? st.arrowSize * k;
    const dogleg = this.dogleg ?? 2 * st.arrowSize * k, gap = this.gap ?? st.gap * k;
    const n = this.points.length, conn = this.points[n - 1], prev = this.points[n - 2];
    const right = conn[0] >= prev[0];
    const end = [conn[0] + (right ? dogleg : -dogleg), conn[1]];   // end of the landing
    const L = { h, arrow, dogleg, gap, conn, right, end };
    if (this.block) {
      const s = this.blockScale ?? k, b = this.block._bbox() || [this.block.base, this.block.base];
      const hw = (b[1][0] - b[0][0]) / 2 * s, ce = [(b[0][0] + b[1][0]) / 2, (b[0][1] + b[1][1]) / 2];
      const center = [end[0] + (right ? hw : -hw), end[1]];
      L.scale = s;
      L.position = [center[0] - (ce[0] - this.block.base[0]) * s, center[1] - (ce[1] - this.block.base[1]) * s];
      L.box = [[center[0] - hw, center[1] - (b[1][1] - b[0][1]) / 2 * s], [center[0] + hw, center[1] + (b[1][1] - b[0][1]) / 2 * s]];
    } else {
      L.rows = this.text.split('\n');
      L.w = Math.max(...L.rows.map(r => r.length)) * h * 0.9;   // estimate; AutoCAD re-measures
      L.tx = right ? end[0] + gap : end[0] - gap - L.w;
      L.top = conn[1] + h / 2;
      L.box = [[L.tx, L.top - L.rows.length * h * 1.67], [L.tx + L.w, L.top]];
    }
    return L;
  }
  _bbox() { return _union([_bboxOf(this.points), this._layout().box]); }
  toString() {
    if (!_H_MLSTYLE) throw new Error('MLeader must be written through a Drawing');
    if (this.block && !this.block._btrHandle) throw new Error('MLeader block is not part of the drawing');
    const L = this._layout(), [cx, cy] = L.conn, BYBLOCK = '-1056964608';
    const lines = ['0','MULTILEADER',this._common(),'100','AcDbMLeader','270','2',
      '300','CONTEXT_DATA{','40','1','10',_num(L.end[0]),'20',cy,'30','0','41',L.h,'140',L.arrow,'145',L.gap,
      '174','1','175','1','176','0','177','0'];
    if (this.block) {
      const s = _num(L.scale);
      lines.push('290','0','296','1','341',this.block._btrHandle,'14','0','24','0','34','1',
        '15',_num(L.position[0]),'25',_num(L.position[1]),'35','0','16',s,'26',s,'36',s,'46','0','93',BYBLOCK,
        ...[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1].flatMap(v => ['47', v]));   // matrix: unused by AutoCAD/BricsCAD
    } else {
      lines.push('290','1','304',_fields(this.text).replace(/\r?\n/g, '\\P'),
        '11','0','21','0','31','1','340',_H_TEXTSTYLE,'12',_num(L.tx),'22',_num(L.top),'32','0',
        '13','1','23','0','33','0','42','0','43','0','44','0','45','1','170','1','90',BYBLOCK,'171','1','172','1',
        '91','-939524096','141','1.5','92','0','291','0','292','0','173','0','293','0','142','0','143','0',
        '294','0','295','1','296','0');
    }
    lines.push('110','0','120','0','130','0','111','1','121','0','131','0','112','0','122','1','132','0','297','0',
      '302','LEADER{','290','1','291','1','10',cx,'20',cy,'30','0','11',L.right ? 1 : -1,'21','0','31','0',
      '90','0','40',L.dogleg,'304','LEADER_LINE{');
    this.points.slice(0, -1).forEach(p => lines.push(_point(_xyz(p))));
    lines.push('91','0','92',BYBLOCK,'305','}','303','}','301','}',
      '340',_H_MLSTYLE,'90','2147483647','170','1','91',BYBLOCK,'341',_H_LT_BYBLOCK,'171','-2',
      '290','1','291','1','41',L.dogleg,'42',L.arrow,'172',this.block ? 1 : 2,'343',_H_TEXTSTYLE,'173','1','95','1',
      '174','1','175','0','92',BYBLOCK,'292','0');
    if (this.block) lines.push('344', this.block._btrHandle, '93', BYBLOCK, '10', _num(L.scale), '20', _num(L.scale), '30', _num(L.scale));
    else lines.push('93', BYBLOCK, '10', '1', '20', '1', '30', '1');
    lines.push('43','0','176','0','293','0');
    return [...lines, ...this._xdata()].join(NL);
  }
}

// ── Raster images ─────────────────────────────────────────────────────────────
/**
 * Image file reference (the file is linked, not embedded: keep it next to the
 * DXF or give a full path). Pixel size is needed for the aspect ratio:
 *   new ImageDef('site_plan.png', [1920, 1080])
 *   ImageDef.fromFile('site_plan.png')          // Node: reads PNG/JPEG/GIF/BMP header
 *   ImageDef.fromBytes('site_plan.png', bytes)  // browser: from a Uint8Array
 */
class ImageDef {
  constructor(filename, sizePx) {
    if (!filename) throw new Error('ImageDef needs a filename');
    if (!sizePx || !(sizePx[0] > 0 && sizePx[1] > 0)) throw new Error('ImageDef needs the image size in pixels [width, height]');
    this.filename = String(filename); this.size = [sizePx[0], sizePx[1]];
  }
  static fromBytes(filename, bytes) {
    const size = _imageSize(bytes);
    if (!size) throw new Error(`${filename}: not a PNG, JPEG, GIF or BMP file (or header unreadable)`);
    return new ImageDef(filename, size);
  }
  static fromFile(path, filename = path) {
    const fs = require('fs');
    return ImageDef.fromBytes(filename, new Uint8Array(fs.readFileSync(path)));
  }
}
function _imageSize(b) {
  const u16be = i => (b[i] << 8) | b[i + 1], u32be = i => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const u16le = i => b[i] | (b[i + 1] << 8), i32le = i => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return [u32be(16), u32be(20)];
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return [u16le(6), u16le(8)];
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4D) return [Math.abs(i32le(18)), Math.abs(i32le(22))];
  if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xFF) { i++; continue; }
      const m = b[i + 1];
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [u16be(i + 7), u16be(i + 5)];
      i += 2 + u16be(i + 2);
    }
  }
  return null;
}
/**
 * Raster image placed with its lower-left corner at `insert`.
 * Give width and/or height in drawing units (the other follows the aspect
 * ratio; neither = 1 unit per pixel).
 */
class Image extends Entity {
  constructor(imageDef, insert = [0, 0, 0], { width = null, height = null, rotation = 0, ...common } = {}) {
    super(common);
    if (!(imageDef instanceof ImageDef)) throw new Error('Image needs an ImageDef');
    const [wp, hp] = imageDef.size;
    if (width === null && height === null) width = wp;
    if (width === null) width = height * wp / hp;
    if (height === null) height = width * hp / wp;
    this.imageDef = imageDef; this.insert = insert; this.width = width; this.height = height;
    this.rotation = rotation; this.flipped = false;
  }
  _pts() { return [this.insert]; }
  _transformExtra(info) {
    this.width *= info.s; this.height *= info.s;
    if (info.mirror) this.flipped = !this.flipped;
    this.rotation = _normAngle(info.angle(this.rotation));
  }
  _vectors() {
    const [wp, hp] = this.imageDef.size;
    const u = _rot([this.width / wp, 0], this.rotation);
    const v = _mul(_rot([0, this.height / hp], this.rotation), this.flipped ? -1 : 1);
    return [u, v];
  }
  _bbox() {
    const [u, v] = this._vectors(), [wp, hp] = this.imageDef.size, p = this.insert;
    const U = _mul(u, wp), V = _mul(v, hp);
    return _bboxOf([p, _add(p, U), _add(p, V), _add(_add(p, U), V)]);
  }
  toString() {
    if (!this.imageDef._handle) throw new Error('Image must be written through a Drawing');
    const [u, v] = this._vectors(), [wp, hp] = this.imageDef.size;
    const h = this._handle = _nextHandle();
    return ['0','IMAGE',this._common(h),'100','AcDbRasterImage','90','0',_point(_xyz(this.insert)),
            _point([_num(u[0]), _num(u[1]), 0], 1),_point([_num(v[0]), _num(v[1]), 0], 2),_point([wp, hp], 3),
            '340',this.imageDef._handle,'70','3','280','0','281','50','282','50','283','0','360',this._reactor,
            '71','1','91','2','14','-0.5','24','-0.5','14',wp - 0.5,'24',hp - 0.5,...this._xdata()].join(NL);
  }
}

// ── Table ─────────────────────────────────────────────────────────────────────
/**
 * Table drawn with lines, MText and optional solid fills (renders everywhere;
 * AutoCAD's own TABLE entity needs DXF 2004+).
 *   new Table([0, 0], [
 *     ['Mark', 'Type', 'Ø', 'No.', 'Length'],
 *     ['01', 'T', 16, 8, 2350],
 *   ], { title: 'BAR SCHEDULE', textHeight: 2.5, align: ['CENTER', 'CENTER', 'RIGHT', 'RIGHT', 'RIGHT'] })
 * `insert` is the top-left corner; rows run downwards.
 * A cell is a value or { text, align, colspan, rowspan, fill }.
 * Options: colWidths / rowHeights (number, array or null = fit text),
 * margin, header (number of header rows), headerFill (ACI colour),
 * borderColor, textColor, format(value, row, col), rotation.
 */
class Table extends Entity {
  constructor(insert, rows, { colWidths = null, rowHeights = null, textHeight = 2.5, margin = null, align = 'LEFT',
                              header = 1, headerFill = null, title = null, borderColor = null, textColor = null,
                              format = null, rotation = 0, ...common } = {}) {
    super(common);
    this.insert = insert; this.rows = rows; this.colWidths = colWidths; this.rowHeights = rowHeights;
    this.textHeight = textHeight; this.margin = margin ?? textHeight * 0.6; this.align = align;
    this.header = header; this.headerFill = headerFill; this.title = title;
    this.borderColor = borderColor; this.textColor = textColor; this.format = format; this.rotation = rotation;
    this._grid();   // validate early
  }
  _pts() { return [this.insert]; }
  _transformExtra(info) {
    this.rotation = _textRotation(info, this.rotation);
    this.textHeight *= info.s; this.margin *= info.s;
    if (typeof this.colWidths === 'number') this.colWidths *= info.s;
    else if (this.colWidths) this.colWidths = this.colWidths.map(w => w * info.s);
    if (typeof this.rowHeights === 'number') this.rowHeights *= info.s;
    else if (this.rowHeights) this.rowHeights = this.rowHeights.map(h => h * info.s);
  }
  // Cells placed on a grid: [{ r, c, rs, cs, text, align, fill }], plus size.
  _grid() {
    const ncolsGuess = Math.max(...this.rows.map(r => r.reduce((n, c) => n + ((c && c.colspan) || 1), 0)));
    const data = this.title !== null ? [[{ text: this.title, colspan: ncolsGuess, align: 'CENTER' }], ...this.rows] : this.rows;
    const taken = [], cells = [];
    const isTaken = (r, c) => taken[r] && taken[r][c];
    data.forEach((row, r) => {
      let c = 0;
      row.forEach(cell => {
        while (isTaken(r, c)) c++;
        const o = cell !== null && typeof cell === 'object' ? cell : { text: cell };
        const rs = o.rowspan || 1, cs = o.colspan || 1;
        for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) {
          if (isTaken(i, j)) throw new Error(`Table: cell (${i}, ${j}) is covered by two merged cells`);
          (taken[i] = taken[i] || [])[j] = true;
        }
        const dataRow = this.title !== null ? r - 1 : r;
        let text = o.text ?? '';
        if (this.format && dataRow >= 0) text = this.format(text, dataRow, c);
        const colAlign = Array.isArray(this.align) ? this.align[c] || 'LEFT' : this.align;
        cells.push({ r, c, rs, cs, text: String(text), align: String(o.align || colAlign).toUpperCase(), fill: o.fill ?? null });
        c += cs;
      });
    });
    const nrows = taken.length, ncols = Math.max(...taken.map(t => t.length));
    // short rows: fill the gaps with empty cells so every border is drawn
    for (let r = 0; r < nrows; r++) for (let c = 0; c < ncols; c++)
      if (!isTaken(r, c)) cells.push({ r, c, rs: 1, cs: 1, text: '', align: 'LEFT', fill: null });
    for (const cl of cells) if (!['LEFT', 'CENTER', 'RIGHT'].includes(cl.align)) throw new Error(`Table: align must be LEFT, CENTER or RIGHT, got '${cl.align}'`);
    const h = this.textHeight, m = this.margin;
    const lines = t => t.split('\n');
    const textW = t => Math.max(...lines(t).map(l => l.length)) * h * 0.8;
    const textH = t => (lines(t).length - 1) * h * 1.67 + h;
    const size = (spec, n, need, what) => {
      if (typeof spec === 'number') return Array(n).fill(spec);
      if (Array.isArray(spec)) { if (spec.length !== n) throw new Error(`Table: ${what} needs ${n} values`); return spec; }
      return Array.from({ length: n }, (_, i) => need(i));
    };
    const widths = size(this.colWidths, ncols, j => Math.max(h + 2 * m,
      ...cells.filter(x => x.c === j && x.cs === 1).map(x => textW(x.text) + 2 * m)), 'colWidths');
    const heights = size(this.rowHeights, nrows, i => Math.max(h + 2 * m,
      ...cells.filter(x => x.r === i && x.rs === 1).map(x => textH(x.text) + 2 * m)), 'rowHeights');
    return { cells, widths, heights, headerRows: this.header + (this.title !== null ? 1 : 0) };
  }
  /** The table as plain entities (lines, MText, solid hatches), already placed. */
  _entities() {
    const { cells, widths, heights, headerRows } = this._grid();
    const xs = [0], ys = [0];
    widths.forEach(w => xs.push(xs[xs.length - 1] + w));
    heights.forEach(h => ys.push(ys[ys.length - 1] - h));
    const base = { layer: this.layer, parent: null, lineType: this.lineType, lineWeight: this.lineWeight };
    const border = { ...base, color: this.borderColor ?? this.color };
    const txt = { ...base, color: this.textColor ?? this.color };
    const fills = [], grid = [], texts = [];
    const W = xs[xs.length - 1], H = ys[ys.length - 1];
    grid.push(new Line([[0, 0, 0], [W, 0, 0]], border), new Line([[0, 0, 0], [0, H, 0]], border));
    for (const cl of cells) {
      const x0 = xs[cl.c], x1 = xs[cl.c + cl.cs], y0 = ys[cl.r], y1 = ys[cl.r + cl.rs];
      const fill = cl.fill ?? (cl.r < headerRows ? this.headerFill : null);
      if (fill !== null) fills.push(new Hatch([[x0, y1], [x1, y1], [x1, y0], [x0, y0]], { ...base, pattern: 'SOLID', color: fill }));
      grid.push(new Line([[x1, y0, 0], [x1, y1, 0]], border), new Line([[x0, y1, 0], [x1, y1, 0]], border));
      if (cl.text === '') continue;
      const ym = (y0 + y1) / 2, m = this.margin;
      const [x, attach] = cl.align === 'LEFT' ? [x0 + m, 'MIDDLE_LEFT'] : cl.align === 'RIGHT' ? [x1 - m, 'MIDDLE_RIGHT'] : [(x0 + x1) / 2, 'MIDDLE_CENTER'];
      texts.push(new MText(cl.text, [x, ym, 0], { ...txt, height: this.textHeight, attach }));
    }
    const all = [...fills, ...grid, ...texts];
    for (const e of all) {
      if (this.rotation) e.rotate(this.rotation, [0, 0]);
      e.translate(this.insert[0], this.insert[1]);
    }
    return all;
  }
  _bbox() { return _union(this._entities().map(e => e._bbox())); }
  toString() { return this._entities().map(e => e.toString()).join(NL); }
}

// ── Paper space ───────────────────────────────────────────────────────────────
// Landscape ISO sheets and their "DWG To PDF.pc3" media names
const PAPER_SIZES = {
  A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210],
};
/**
 * Viewport on a layout: a window `size` = [w, h] (paper units) centred at
 * `center` (paper), showing model space around `viewCenter` at `scale` model
 * units per paper unit (e.g. 50 for 1:50 when both are mm).
 * freeze: layer names hidden in this viewport only. locked: display locked.
 */
class Viewport extends Entity {
  constructor({ center, size, viewCenter = [0, 0], scale = 1, freeze = [], locked = true, ...common } = {}) {
    super({ layer: 'VIEWPORTS', ...common });
    if (!center || !size) throw new Error('Viewport needs center and size');
    if (!(scale > 0)) throw new Error('Viewport scale must be > 0');
    this.center = center; this.size = size; this.viewCenter = viewCenter; this.scale = scale;
    this.freeze = freeze.map(n => String(n).toUpperCase()); this.locked = locked;
    this._id = null; this._overall = false;
  }
  _pts() { return [this.center]; }
  _bbox() {
    const [x, y] = this.center, [w, h] = this.size;
    return [[x - w / 2, y - h / 2], [x + w / 2, y + h / 2]];
  }
  /** Model-space area shown: [[xmin,ymin],[xmax,ymax]]. */
  get modelWindow() {
    const [x, y] = this.viewCenter, w = this.size[0] * this.scale / 2, h = this.size[1] * this.scale / 2;
    return [[x - w, y - h], [x + w, y + h]];
  }
  toString() {
    const viewH = this._overall ? this.size[1] : this.size[1] * this.scale;
    const lines = ['0','VIEWPORT',this._common(this._fixedHandle || _nextHandle()),'100','AcDbViewport',
      _point([...this.center.slice(0, 2), 0]),'40',this.size[0],'41',this.size[1],'68',this._overall ? 1 : 2,'69',this._id,
      '12',this.viewCenter[0],'22',this.viewCenter[1],'13','0','23','0','14','10','24','10','15','10','25','10',
      '16','0','26','0','36','1','17','0','27','0','37','0','42','50','43','0','44','0','45',_num(viewH),
      '50','0','51','0','72','100'];
    for (const n of this.freeze) lines.push('331', this._layerHandles.get(n));
    lines.push('90', this._overall ? 557088 : (this.locked ? 16384 : 0), '1', '', '281', '0', '71', '0', '74', '0',
      '110','0','120','0','130','0','111','1','121','0','131','0','112','0','122','1','132','0','79','0','146','0');
    return [...lines, ...this._xdata()].join(NL);
  }
}
/**
 * Paper-space sheet (Drawing.addLayout). Paper coordinates are in mm (or
 * inches with units: 'in') with (0, 0) at the lower-left corner of the sheet.
 *   const sheet = d.addLayout('S-101', { paper: 'A1' });
 *   sheet.append(new Insert(titleBlock, [0, 0], { attributes: { ... } }));
 *   sheet.addViewport({ center: [400, 320], size: [700, 480], viewCenter: [3000, 1500], scale: 50 });
 */
class Layout extends Collection {
  constructor(name, { paper = 'A3', size = null, units = 'mm', margins = [0, 0, 0, 0], printer = 'DWG To PDF.pc3', mediaName = null } = {}) {
    super();
    this.name = String(name);
    if (size === null) {
      size = PAPER_SIZES[String(paper).toUpperCase()];
      if (!size) throw new Error(`Unknown paper '${paper}'. Use ${Object.keys(PAPER_SIZES).join(', ')} or size: [w, h]`);
    }
    if (!['mm', 'in'].includes(units)) throw new Error(`Layout units must be 'mm' or 'in'`);
    this.size = size; this.units = units; this.margins = margins; this.printer = printer;
    const mm = units === 'in' ? 25.4 : 1, [w, h] = size.map(v => (v * mm).toFixed(2));
    const iso = size === PAPER_SIZES[String(paper).toUpperCase()] && units === 'mm';
    this.mediaName = mediaName || (iso ? `ISO_full_bleed_${String(paper).toUpperCase()}_(${w}_x_${h}_MM)` : `USER_(${w}_x_${h}_MM)`);
    this.viewports = [];
  }
  addViewport(options) {
    const v = new Viewport(options);
    this.viewports.push(v); this.append(v);
    return v;
  }
}

// ── Group ─────────────────────────────────────────────────────────────────────
/** Named selection group of model-space entities (Drawing.addGroup). */
class Group {
  constructor(name, entities = [], { description = '', selectable = true } = {}) {
    this.name = String(name); this.entities = [...entities]; this.description = description; this.selectable = selectable;
  }
  add(...entities) { this.entities.push(...entities); return this; }
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
                units = null, ltscale = 1, wipeoutFrame = false, properties = {}, filename = '', date = null } = {}) {
    super(entities);
    this.insbase = insbase; this.extmin = extmin; this.extmax = extmax;
    this.layers = [...layers]; this.linetypes = [...linetypes]; this.styles = [...styles];
    this.dimstyles = [...dimstyles]; this.views = [...views]; this.blocks = [...blocks];
    this.units = units; this.ltscale = ltscale; this.wipeoutFrame = wipeoutFrame; this.groups = []; this.layouts = [];
    // Document properties: title, subject, author, keywords, comments, revision + any custom name → value
    this.properties = { ...properties }; this.filename = filename; this.date = date;
    if (!this.dimstyles.some(s => s.name.toUpperCase() === 'STANDARD')) this.dimstyles.unshift(new DimStyle());
  }
  /** Create a named group of entities that are (or will be) in this drawing's model space. */
  addGroup(name, entities = [], options = {}) {
    if (this.groups.some(g => g.name.toUpperCase() === String(name).toUpperCase())) throw new Error(`Group '${name}' already exists`);
    const g = new Group(name, entities, options);
    this.groups.push(g);
    return g;
  }
  /** Add a paper-space sheet; the first one added is the active layout. */
  addLayout(name, options = {}) {
    if (/^model$/i.test(name) || this.layouts.some(l => l.name.toUpperCase() === String(name).toUpperCase()))
      throw new Error(`Layout '${name}' already exists`);
    const l = new Layout(name, options);
    this.layouts.push(l);
    return l;
  }
  /**
   * Field resolver for a context: layout = a Layout, 'Model', or null (inside
   * block definitions, where per-sheet fields show #### like an invalid AutoCAD field).
   */
  _fieldResolver(layout) {
    const date = this.date ? new Date(this.date) : new Date();
    const props = new Map(Object.entries(this.properties).map(([k, v]) => [k.toLowerCase(), v]));
    const sheet = layout instanceof Layout ? layout : null;
    const vp = sheet && sheet.viewports[0];
    const builtin = {
      layout: () => sheet ? sheet.name : layout === 'Model' ? 'Model' : '####',
      sheet: () => sheet ? String(this.layouts.indexOf(sheet) + 1) : '####',
      sheets: () => String(this.layouts.length),
      scale: () => vp ? `1:${_fmt(vp.scale)}` : '####',
      filename: () => this.filename || '####',
      date: fmt => _formatDate(date, fmt || undefined),
      units: () => this.units || '',
    };
    return (name, fmt) => {
      const n = name.trim().toLowerCase();
      if (builtin[n]) return builtin[n](fmt);
      if (props.has(n)) return String(props.get(n));
      throw new Error(`Unknown field {{${name}}}. Built-in: ${Object.keys(builtin).join(', ')}; ` +
                      `properties: ${[...props.keys()].join(', ') || '(none)'}`);
    };
  }
  // Model-space and paper-space top-level entities
  _top() { return [...this.entities, ...this.layouts.flatMap(l => l.entities)]; }
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
    const ents = [...this._top(), ...blocks.flatMap(b => b.entities)];
    const has = (list, n) => list.some(x => x.name.toUpperCase() === String(n).toUpperCase());
    if (!has(this.layers, '0')) this.layers.unshift(new Layer({ name: '0', color: 7 }));
    for (const v of this.layouts.flatMap(l => l.viewports))
      for (const n of v.freeze) if (!has(this.layers, n)) this.layers.push(new Layer({ name: n, color: 7 }));
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
      if (e instanceof Leader || e instanceof MLeader) e._style = this._dimstyle(e.dimstyle);
      if (e instanceof MLeader && e.block) add(e.block);
      if (e instanceof Dimension && !seen.has(e)) {
        seen.add(e);
        out.push(e._buildBlock(`*D${++dimCount}`, this._dimstyle(e.dimstyle)));
      }
    };
    this.blocks.forEach(add);
    this._top().forEach(visit);
    return out;
  }
  _appids(blocks) {
    const ids = new Set(['ACAD']);
    const scan = e => {
      if (e.xdata) Object.keys(e.xdata).forEach(k => ids.add(k.toUpperCase()));
      if (e instanceof Insert && e.params) ids.add(DYN_APPID);
    };
    this._top().forEach(scan);
    blocks.forEach(b => b.entities.forEach(scan));
    return [...ids];
  }
  toString() {
    _resetHandles();
    _preAllocHandles();
    _owner = null;
    const blockFields = this._fieldResolver(null);
    _fieldCtx = blockFields;
    const userBlocks = this._collectBlocks();
    for (const b of userBlocks) b._btrHandle = _nextHandle();
    this._resolveTables(userBlocks);
    const auto = _union(this.entities.map(e => e._bbox())) || [[0, 0], [0, 0]];
    const extmin = this.extmin || auto[0], extmax = this.extmax || auto[1];
    const H_ROOTDICT = _nextHandle(), H_GROUPDICT = _nextHandle();
    // Optional objects / classes, only when something uses them
    const used = cls => [...this._top(), ...userBlocks.flatMap(b => b.entities)].some(e => e instanceof cls);
    const hasWipeout = used(Wipeout), hasMLeader = used(MLeader);
    const images = [...this._top(), ...userBlocks.flatMap(b => b.entities)].filter(e => e instanceof Image);
    // Paper-space layouts: LAYOUT objects, block records, overall viewports (ID 1)
    const hasLayouts = this.layouts.length > 0;
    const [H_LAYOUTDICT, H_MODEL_LAYOUT] = hasLayouts ? [_nextHandle(), _nextHandle()] : [null, null];
    this.layouts.forEach((l, i) => {
      l._handle = _nextHandle();
      l._btr = i === 0 ? _H_PAPER_BTR : _nextHandle();
      l._blockName = i === 0 ? '*Paper_Space' : `*Paper_Space${i - 1}`;
      const [w, h] = l.size;
      l._overall = Object.assign(new Viewport({ center: [w / 2, h / 2], size: [w * 1.1, h * 1.1], viewCenter: [w / 2, h / 2], layer: '0' }),
                                 { _overall: true, _fixedHandle: _nextHandle(), _id: 1 });
      l.viewports.forEach((v, k) => { v._id = k + 2; });
    });
    const imageDefs = [...new Set(images.map(i => i.imageDef))];
    const [H_IMGDICT, H_RASTERVARS] = images.length ? [_nextHandle(), _nextHandle()] : [null, null];
    imageDefs.forEach(d => { d._handle = _nextHandle(); d._reactors = []; });
    images.forEach(i => { i._reactor = _nextHandle(); i.imageDef._reactors.push(i); });
    const H_WOVARS = hasWipeout ? _nextHandle() : null;
    const [H_MLSDICT, H_MLS] = hasMLeader ? [_nextHandle(), _nextHandle()] : [null, null];
    _H_MLSTYLE = H_MLS;
    const groupOf = new Map();
    for (const g of this.groups) {
      g._handle = _nextHandle(); g._members = [];
      for (const e of g.entities) {
        if (!this.entities.includes(e)) throw new Error(`Group '${g.name}': an entity is not in the drawing's model space`);
        groupOf.set(e, [...(groupOf.get(e) || []), g]);
      }
    }

    // ── TABLES ──────────────────────────────────────────────────
    const btr = (h, name, layout = null) => ['0','BLOCK_RECORD','5',h,'330',_H_BLOCKTABLE,
       '100','AcDbSymbolTableRecord','100','AcDbBlockTableRecord',
       '2',name,...(layout ? ['340', layout] : []),'70','0','280','1','281','0'].join(NL);
    const brDefs = [
      btr(_H_MODEL_BTR, '*Model_Space', H_MODEL_LAYOUT),
      btr(_H_PAPER_BTR, '*Paper_Space', hasLayouts ? this.layouts[0]._handle : null),
      ...this.layouts.slice(1).map(l => btr(l._btr, l._blockName, l._handle)),
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
    const std = this.styles.find(s => s.name === 'STANDARD') || this.styles[0];
    _H_TEXTSTYLE = std._handle;
    _H_LT_BYBLOCK = this.linetypes.find(l => l.name === 'BYBLOCK')._handle;
    const layerHandles = new Map(this.layers.map(l => [l.name, l._handle]));
    this.layouts.forEach(l => l.viewports.forEach(v => { v._layerHandles = layerHandles; }));

    // ── CLASSES — custom objects used by this drawing ────────────
    const classDefs = [
      ...(hasWipeout ? [['WIPEOUTVARIABLES', 'AcDbWipeoutVariables', 'WipeOut', 0, 0], ['WIPEOUT', 'AcDbWipeout', 'WipeOut', 127, 1]] : []),
      ...(images.length ? [['RASTERVARIABLES', 'AcDbRasterVariables', 'ISM', 0, 0], ['IMAGE', 'AcDbRasterImage', 'ISM', 2175, 1],
                           ['IMAGEDEF', 'AcDbRasterImageDef', 'ISM', 0, 0], ['IMAGEDEF_REACTOR', 'AcDbRasterImageDefReactor', 'ISM', 1, 0]] : []),
      ...(hasLayouts ? [['LAYOUT', 'AcDbLayout', 'ObjectDBX Classes', 0, 0]] : []),
      ...(hasMLeader ? [['MLEADERSTYLE', 'AcDbMLeaderStyle', 'ACDB_MLEADERSTYLE_CLASS', 4095, 0], ['MULTILEADER', 'AcDbMLeader', 'ACDB_MLEADER_CLASS', 3071, 1]] : []),
    ].map(([n, cpp, app, flags, isEnt]) => ['0','CLASS','1',n,'2',cpp,'3',app,'90',flags,'280','0','281',isEnt].join(NL));
    const classes = classDefs.length ? this._section('classes', classDefs) : null;

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
    // Paper-space entities: the first layout's go in ENTITIES, the others' in their *Paper_SpaceN block
    const writeLayout = l => {
      const prev = _owner; _owner = l._btr; _paper = true; _fieldCtx = this._fieldResolver(l);
      try { return [l._overall, ...l.entities].map(e => e.toString()).filter(s => s && s.trim()); }
      finally { _owner = prev; _paper = false; _fieldCtx = blockFields; }
    };
    const otherSheets = this.layouts.slice(1).map(l => [
      '0','BLOCK','5',_nextHandle(),'330',l._btr,'100','AcDbEntity','67','1','8','0',
      '100','AcDbBlockBegin','2',l._blockName,'70','0',_point([0,0,0]),'3',l._blockName,'1','',
      ...writeLayout(l),
      '0','ENDBLK','5',_nextHandle(),'330',l._btr,'100','AcDbEntity','67','1','8','0','100','AcDbBlockEnd',
    ].join(NL));
    _fieldCtx = blockFields;
    const blocks = this._section('blocks', [modelBlock, paperBlock, ...otherSheets, ...userBlocks.map(x => x.toString())]);

    // ── ENTITIES ─────────────────────────────────────────────────
    _owner = _H_MODEL_BTR;
    const modelFields = this._fieldResolver('Model');
    _fieldCtx = modelFields;
    const entities = this._section('entities', this.entities.map(e => {
      _groupCtx = groupOf.get(e) || null;
      try { return e.toString(); } finally { _groupCtx = null; _fieldCtx = modelFields; }
    }).concat(hasLayouts ? writeLayout(this.layouts[0]) : []));
    _owner = null; _fieldCtx = null;

    // ── OBJECTS — root dictionary required for AC1015 ────────────
    const owned = (h, owner) => ['5', h, '102', '{ACAD_REACTORS', '330', owner, '102', '}', '330', owner];
    const rootEntries = [['ACAD_GROUP', H_GROUPDICT]];
    if (hasMLeader) rootEntries.push(['ACAD_MLEADERSTYLE', H_MLSDICT]);
    if (hasWipeout) rootEntries.push(['ACAD_WIPEOUT_VARS', H_WOVARS]);
    if (images.length) rootEntries.push(['ACAD_IMAGE_DICT', H_IMGDICT], ['ACAD_IMAGE_VARS', H_RASTERVARS]);
    if (hasLayouts) rootEntries.push(['ACAD_LAYOUT', H_LAYOUTDICT]);
    const hasProps = Object.keys(this.properties).length > 0;
    const H_DWGPROPS = hasProps ? _nextHandle() : null;
    if (hasProps) rootEntries.push(['DWGPROPS', H_DWGPROPS]);
    const objectDefs = [
      ['0','DICTIONARY','5',H_ROOTDICT,'330','0','100','AcDbDictionary','281','1',
       ...rootEntries.flatMap(([k, h]) => ['3', k, '350', h])].join(NL),
      ['0','DICTIONARY','5',H_GROUPDICT,'330',H_ROOTDICT,'100','AcDbDictionary','281','1',
       ...this.groups.flatMap(g => ['3', g.name, '350', g._handle])].join(NL),
      ...this.groups.map(g => ['0','GROUP',...owned(g._handle, H_GROUPDICT),'100','AcDbGroup','300',g.description,
        '70','0','71',g.selectable ? 1 : 0,...g._members.flatMap(h => ['340', h])].join(NL)),
    ];
    if (hasMLeader) objectDefs.push(
      ['0','DICTIONARY',...owned(H_MLSDICT, H_ROOTDICT),'100','AcDbDictionary','281','1','3','Standard','350',H_MLS].join(NL),
      ['0','MLEADERSTYLE',...owned(H_MLS, H_MLSDICT),'100','AcDbMLeaderStyle','179','2','170','2','171','1','172','0',
       '90','2','40','0','41','0','173','1','91','-1056964608','92','-2','290','1','42','2','291','1','43','8',
       '3','Standard','44','4','300','','342',_H_TEXTSTYLE,'174','1','175','1','176','0','178','1',
       '93','-1056964608','45','4','292','0','297','0','46','4','94','-1056964608','47','1','49','1','140','1',
       '294','1','141','0','177','0','142','1','295','0','296','0','143','3.75','271','0','272','9','273','9'].join(NL));
    if (hasWipeout) objectDefs.push(
      ['0','WIPEOUTVARIABLES',...owned(H_WOVARS, H_ROOTDICT),'100','AcDbWipeoutVariables','70',this.wipeoutFrame ? 1 : 0].join(NL));
    if (images.length) {
      const names = new Map();
      for (const d of imageDefs) {   // dictionary key: file name without folder / extension
        let n = d.filename.split(/[\\/]/).pop().replace(/\.[^.]*$/, '').toUpperCase() || 'IMAGE', k = n, i = 1;
        while (names.has(k)) k = `${n}_${++i}`;
        names.set(k, d);
      }
      const rasterUnits = { mm: 1, cm: 2, m: 3, km: 4, in: 5, ft: 6 }[String(this.units).toLowerCase()] || 0;
      objectDefs.push(
        ['0','DICTIONARY',...owned(H_IMGDICT, H_ROOTDICT),'100','AcDbDictionary','281','1',
         ...[...names].flatMap(([k, d]) => ['3', k, '350', d._handle])].join(NL),
        ['0','RASTERVARIABLES',...owned(H_RASTERVARS, H_ROOTDICT),'100','AcDbRasterVariables','90','0','70','0','71','1','72',rasterUnits].join(NL),
        ...imageDefs.map(d => ['0','IMAGEDEF','5',d._handle,'102','{ACAD_REACTORS','330',H_IMGDICT,
          ...d._reactors.flatMap(i => ['330', i._reactor]),'102','}','330',H_IMGDICT,'100','AcDbRasterImageDef','90','0',
          '1',d.filename,'10',d.size[0],'20',d.size[1],'11','0.01','21','0.01','280','1','281','0'].join(NL)),
        ...images.map(i => ['0','IMAGEDEF_REACTOR','5',i._reactor,'330',i._handle,'100','AcDbRasterImageDefReactor','90','2','330',i._handle].join(NL)));
    }
    if (hasLayouts) {
      // PLOTSETTINGS + LAYOUT data (values as AutoCAD / ezdxf write them)
      const plot = ({ printer, media, margins, size, inch }) => ['100','AcDbPlotSettings','1','','2',printer,'4',media,'6','',
        '40',margins[0],'41',margins[1],'42',margins[2],'43',margins[3],'44',size[0],'45',size[1],
        '46','0','47','0','48','0','49','0','140','0','141','0','142','1','143','1',
        '70',printer ? 672 : 1024,'72',inch ? 0 : 1,'73','0','74','5','7','','75','16','76','0','77','2','78','300',
        '147','1','148','0','149','0'];
      const layout = (name, tab, limits, btrH, vpH) => ['100','AcDbLayout','1',name,'70','1','71',tab,
        '10',limits[0][0],'20',limits[0][1],'11',limits[1][0],'21',limits[1][1],'12','0','22','0','32','0',
        '14','1e+20','24','1e+20','34','1e+20','15','-1e+20','25','-1e+20','35','-1e+20','146','0',
        '13','0','23','0','33','0','16','1','26','0','36','0','17','0','27','1','37','0','76','1','330',btrH,
        ...(vpH ? ['331', vpH] : [])];
      objectDefs.push(
        ['0','DICTIONARY',...owned(H_LAYOUTDICT, H_ROOTDICT),'100','AcDbDictionary','281','1',
         '3','Model','350',H_MODEL_LAYOUT,...this.layouts.flatMap(l => ['3', l.name, '350', l._handle])].join(NL),
        ['0','LAYOUT',...owned(H_MODEL_LAYOUT, H_LAYOUTDICT),
         ...plot({ printer: '', media: 'ISO_full_bleed_A3_(420.00_x_297.00_MM)', margins: [0, 0, 0, 0], size: [420, 297] }),
         ...layout('Model', 0, [[0, 0], [420, 297]], _H_MODEL_BTR, null)].join(NL),
        ...this.layouts.map((l, i) => {
          const mm = l.units === 'in' ? 25.4 : 1;
          return ['0','LAYOUT',...owned(l._handle, H_LAYOUTDICT),
            ...plot({ printer: l.printer, media: l.mediaName, margins: l.margins, size: l.size.map(v => v * mm), inch: l.units === 'in' }),
            ...layout(l.name, i + 1, [[0, 0], l.size], l._btr, l._overall._fixedHandle)].join(NL);
        }));
    }
    if (hasProps) {
      // R2000 DWGPROPS: XRECORD "DWGPROPS COOKIE" (title, subject, author, comments,
      // keywords, last saved by, revision, 10 custom "name=value" slots, dates)
      const p = new Map(Object.entries(this.properties).map(([k, v]) => [k.toLowerCase(), [k, v]]));
      const std = ['title', 'subject', 'author', 'comments', 'keywords', 'lastsavedby', 'revision'];
      const get = k => p.has(k) ? String(p.get(k)[1]) : '';
      const custom = [...p.entries()].filter(([k]) => !std.includes(k)).map(([, [k, v]]) => `${k}=${v}`);
      if (custom.length > 10) throw new Error('DWGPROPS holds at most 10 custom properties in an R2000 file');
      const jd = (this.date ? new Date(this.date) : new Date()).getTime() / 86400000 + 2440587.5;
      objectDefs.push(['0','XRECORD',...owned(H_DWGPROPS, H_ROOTDICT),'100','AcDbXrecord','280','1',
        '1','DWGPROPS COOKIE','2',get('title'),'3',get('subject'),'4',get('author'),'6',get('comments'),
        '7',get('keywords'),'8',get('lastsavedby'),'9',get('revision'),
        ...Array.from({ length: 10 }, (_, i) => [String(300 + i), custom[i] || '=']).flat(),
        '40','0','41',jd,'42',jd,'1','','90','0'].join(NL));
    }
    const objects = this._section('objects', objectDefs);
    _H_MLSTYLE = null;

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
    return [header, classes, tables, blocks, entities, objects, '0', 'EOF', ''].filter(s => s !== null).join(NL)
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
    OrdinateDimension, XLine, Ray, Wipeout, MLeader, Table, Group, Image, ImageDef, Layout, Viewport, PAPER_SIZES,
    Collection, Entity, arrayRect, arrayPolar, calculate_end_point, HATCH_PATTERNS, LINETYPE_PRESETS,
  };
}
