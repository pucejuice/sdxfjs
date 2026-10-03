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
let _H_UCS_TBL, _H_APPID_TBL, _H_DIM_TBL;
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
}

// Handle of the BLOCK_RECORD that owns the entities currently being written.
let _owner = null;
const DYN_APPID = 'SDXF_DYNBLOCK';

function _point(x, index = 0) { return x.map((val, i) => `${(i + 1) * 10 + index}${NL}${val}`).join(NL); }
function _points(p) { return p.map((pt, i) => _point(pt, i)); }
function calculate_end_point(start_point, angle_degrees, length) {
  const [x_start, y_start] = start_point;
  const angle_radians = angle_degrees * (Math.PI / 180);
  return [x_start + length * Math.cos(angle_radians), y_start + length * Math.sin(angle_radians)];
}

class Entity {
  constructor({ color = 256, extrusion = null, layer = '0', lineType = null, lineTypeScale = null, lineWeight = null, thickness = null, parent = null, xdata = null } = {}) {
    this.color = color; this.extrusion = extrusion; this.layer = layer; this.lineType = lineType;
    this.lineTypeScale = lineTypeScale; this.lineWeight = lineWeight; this.thickness = thickness; this.parent = parent;
    this.xdata = xdata;
  }
  _common(handle = _nextHandle(), owner = _owner || _H_MODEL_BTR) {
    const parent = this.parent || this;
    // Group 5: unique handle. Group 330: owner = block table record of the
    // block being written (*Model_Space for the ENTITIES section).
    const lines = ['5', handle, '330', owner, '100', 'AcDbEntity', '8', parent.layer];
    if (parent.lineType !== null) lines.push('6', parent.lineType);
    if (parent.lineWeight !== null) lines.push('370', parent.lineWeight);
    if (parent.color !== null && parent.color !== 256) lines.push('62', parent.color);
    return lines.join(NL);
  }
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
  // Mutable references to every defining point — used by dynamic block actions.
  _pts() { return []; }
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
  constructor({ name = 'pydxf', color = 7, lineType = 'continuous', flag = 64 } = {}) {
    this.name = name.toUpperCase(); this.color = color; this.lineType = lineType; this.flag = flag;
  }
  toString() {
    return ['0','LAYER','5',_nextHandle(),'330',_H_LAYER_TBL,
            '100','AcDbSymbolTableRecord','100','AcDbLayerTableRecord',
            '2',this.name,'70',this.flag,'62',this.color,'6',this.lineType].join(NL);
  }
}
class LineType {
  constructor({ name = 'continuous', description = 'Solid line', elements = [], flag = 64 } = {}) {
    this.name = name.toUpperCase(); this.description = description; this.elements = [...elements]; this.flag = flag;
  }
  toString() {
    return ['0','LTYPE','5',_nextHandle(),'330',_H_LTYPE_TBL,
            '100','AcDbSymbolTableRecord','100','AcDbLinetypeTableRecord',
            '2',this.name,'70',this.flag,'3',this.description,'72','65','73',this.elements.length,'40','0.0'].join(NL);
  }
}
class Style {
  constructor({ name = 'standard', flag = 0, height = 0, widthFactor = 40, obliqueAngle = 50, mirror = 0, lastHeight = 1, font = 'arial.ttf', bigFont = '' } = {}) {
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
 *                                params: { LENGTH: 1500 } })       // DynamicBlock only
 * `block` may be a Block / DynamicBlock object or a block name string
 * (attributes and params need the object).
 */
class Insert extends Entity {
  constructor(block, insert = [0,0,0], { xscale = 1, yscale = 1, zscale = 1, rotation = 0,
                                        attributes = {}, params = null, ...common } = {}) {
    super(common);
    this.insert = insert; this.xscale = xscale; this.yscale = yscale; this.zscale = zscale; this.rotation = rotation;
    this.attributes = Object.fromEntries(Object.entries(attributes || {}).map(([k, v]) => [_tag(k), v]));
    this.params = null;
    if (block instanceof DynamicBlock) {
      this.params = block.resolveParams(params || {});
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
  get blockName() { return (typeof this.block === 'string' ? this.block : this.block.name).toUpperCase(); }
  _pts() { return [this.insert]; }
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
  _dynXdata() {
    if (!this.params) return [];
    const pairs = [[1000, this.source.name.toUpperCase()]];
    for (const [k, v] of Object.entries(this.params)) pairs.push([1000, k], [1040, v]);
    return ['1001', DYN_APPID, ...pairs.flatMap(([c, v]) => [String(c), v])];
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
    lines.push(...this._dynXdata(), ...this._xdata());
    if (attribs.length) {
      for (const a of attribs) lines.push(a._toString(h));
      lines.push('0','SEQEND','5',_nextHandle(),'330',h,'100','AcDbEntity','8',(this.parent || this).layer);
    }
    return lines.join(NL);
  }
}

// ── Dynamic blocks ────────────────────────────────────────────────────────────
const _fmt = v => String(Number(Number(v).toFixed(6)));

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
 */
class DynamicBlock extends Block {
  constructor(name, options = {}) {
    super(name, options);
    this.parameters = {}; this.actions = []; this._variants = new Map();
  }
  addLinearParameter(name, base, end, options = {}) {
    const p = new LinearParameter(name, base, end, options);
    this.parameters[p.name] = p;
    return p;
  }
  _action(type, param, { entities = null, grip = 'end', multiplier = 1, angleOffset = 0, frame = null }) {
    const p = this.parameters[_tag(param)];
    if (!p) throw new Error(`DynamicBlock '${this.name}': no parameter '${param}'`);
    if (!['start', 'end'].includes(grip)) throw new Error(`grip must be 'start' or 'end'`);
    const sel = entities || this.entities;
    for (const e of sel) if (!this.entities.includes(e)) throw new Error(`Action entity is not part of block '${this.name}'`);
    this.actions.push({ type, param: p, entities: sel, grip, multiplier, angleOffset, frame });
    return this;
  }
  /** Points of the selected entities that lie inside `frame` move; everything else stays. */
  addStretchAction(param, { frame, ...options }) {
    if (!frame || frame.length < 2) throw new Error('Stretch action needs a frame: [[x1,y1],[x2,y2]] or a polygon');
    return this._action('stretch', param, { ...options, frame });
  }
  /** The selected entities move as a whole with the grip. */
  addMoveAction(param, { entities, ...options }) {
    if (!entities || !entities.length) throw new Error('Move action needs an entities list');
    return this._action('move', param, { ...options, entities });
  }
  /** Fill in defaults and snap every value to its parameter's value set. */
  resolveParams(params) {
    const out = {};
    const given = Object.fromEntries(Object.entries(params).map(([k, v]) => [_tag(k), v]));
    for (const k of Object.keys(given))
      if (!this.parameters[k]) throw new Error(`DynamicBlock '${this.name}' has no parameter '${k}'. Valid: ${Object.keys(this.parameters).join(', ')}`);
    for (const [k, p] of Object.entries(this.parameters)) out[k] = k in given ? p.resolve(given[k]) : p.resolve(p.distance);
    return out;
  }
  /** Concrete Block for a set of parameter values (cached; the base block for defaults). */
  variant(params = {}) {
    const values = this.resolveParams(params);
    const changed = Object.entries(values).filter(([k, v]) => Math.abs(v - this.parameters[k].distance) > 1e-9);
    if (!changed.length) return this;
    const name = this.name.toUpperCase() + Object.entries(values).map(([k, v]) => `__${k}-${_fmt(v)}`).join('');
    if (this._variants.has(name)) return this._variants.get(name);

    const clones = new Map(this.entities.map(e => [e, _cloneEntity(e)]));
    // Test frames against the ORIGINAL geometry and sum the shifts, so actions
    // from different parameters (e.g. length + width) are independent of order.
    const shifts = new Map();  // point array → [dx, dy]
    for (const a of this.actions) {
      const p = a.param;
      const s = p._gripShift(a.grip, values[p.name] - p.distance) * a.multiplier;
      if (!s) continue;
      const ang = (p.angle + a.angleOffset) * Math.PI / 180;
      const dx = Number((s * Math.cos(ang)).toFixed(9)), dy = Number((s * Math.sin(ang)).toFixed(9));
      for (const e of a.entities) {
        const orig = e._pts(), copy = clones.get(e)._pts();
        orig.forEach((pt, i) => {
          if (a.type === 'stretch' && !_insideFrame(pt, a.frame)) return;
          const acc = shifts.get(copy[i]) || [0, 0];
          shifts.set(copy[i], [acc[0] + dx, acc[1] + dy]);
        });
      }
    }
    for (const [pt, [dx, dy]] of shifts) { pt[0] += dx; pt[1] += dy; }

    const blk = new Block(name, { layer: this.layer, flag: this.flag, base: this.base, entities: [...clones.values()] });
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
  toString() { return ['0','LINE',this._common(),'100','AcDbLine',_points(this.points).join(NL),...this._xdata()].join(NL); }
}
class LwPolyLine extends Entity {
  constructor(points, { flag = 0, width = null, elevation = null, bulge = null, bulges = null, ...commonOptions } = {}) {
    super(commonOptions); this.points = points; this.flag = flag; this.width = width;
    this.elevation = elevation; this.bulge = bulge; this.bulges = bulges;
  }
  _pts() { return this.points; }
  toString() {
    if (!this.points || this.points.length < 2) return '';
    const lines = ['0','LWPOLYLINE',this._common(),'100','AcDbPolyline',
                   '90',this.points.length,'70',this.flag || 0];
    if (this.width !== null) lines.push('43', this.width);
    if (this.elevation !== null) lines.push('38', this.elevation);
    for (let idx = 0; idx < this.points.length; idx++) {
      const pt = this.points[idx];
      lines.push(`10${NL}${pt[0]}`, `20${NL}${pt[1]}`);
      if (this.bulges !== null && idx < this.bulges.length) lines.push('42', this.bulges[idx]);
      else if (this.bulge !== null) lines.push('42', this.bulge);
    }
    return [...lines, ...this._xdata()].join(NL);
  }
}
class Circle extends Entity {
  constructor(center = [0,0,0], radius = 1, commonOptions = {}) { super(commonOptions); this.center = center; this.radius = radius; }
  _pts() { return [this.center]; }
  toString() { return ['0','CIRCLE',this._common(),'100','AcDbCircle',_point(this.center),'40',this.radius,...this._xdata()].join(NL); }
}
class Arc extends Entity {
  constructor(center = [0,0,0], radius = 1, startAngle = 0, endAngle = 90, commonOptions = {}) {
    super(commonOptions); this.center = center; this.radius = radius; this.startAngle = startAngle; this.endAngle = endAngle;
  }
  _pts() { return [this.center]; }
  toString() { return ['0','ARC',this._common(),'100','AcDbCircle',_point(this.center),'40',this.radius,'100','AcDbArc','50',this.startAngle,'51',this.endAngle,...this._xdata()].join(NL); }
}
class Point extends Entity {
  constructor(point = [0,0,0], commonOptions = {}) { super(commonOptions); this.point = point; }
  _pts() { return [this.point]; }
  toString() { return ['0','POINT',this._common(),'100','AcDbPoint',_point(this.point),...this._xdata()].join(NL); }
}
class Text extends Entity {
  constructor(text = '', point = [0,0,0], { height = 1, rotation = null, style = null, align = 'LEFT', alignPoint = null, ...common } = {}) {
    super(common); this.text = text; this.point = point; this.height = height; this.rotation = rotation; this.style = style;
    this.align = align; this.alignPoint = alignPoint;
  }
  _pts() { return this.alignPoint ? [this.point, this.alignPoint] : [this.point]; }
  toString() {
    const t = String(this.text ?? '').trim();
    if (!t) return '';
    const [text, valign] = _textLines(this, t);
    const lines = ['0','TEXT',this._common(),...text];
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
    return ['0','SOLID',this._common(),'100','AcDbTrace',_points(rp).join(NL),...this._xdata()].join(NL);
  }
}

// ── Main Drawing class ────────────────────────────────────────────────────────
class Drawing extends Collection {
  constructor({ insbase = [0,0,0], extmin = [0,0], extmax = [0,0],
                layers = [new Layer()], linetypes = [new LineType()], styles = [new Style()],
                views = [], blocks = [], entities = [] } = {}) {
    super(entities);
    this.insbase = insbase; this.extmin = extmin; this.extmax = extmax;
    this.layers = [...layers]; this.linetypes = [...linetypes]; this.styles = [...styles];
    this.views = [...views]; this.blocks = [...blocks];
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
    const visit = e => { if (e instanceof Insert) { add(e.source); add(e.block); } };
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
    const dimDef   = ['0','DIMSTYLE','5',_nextHandle(),'330',_H_DIM_TBL,
                      '100','AcDbSymbolTableRecord','100','AcDbDimStyleTableRecord',
                      '2','Standard','70','0'].join(NL);

    const tables = this._section('tables', [
      this._table('LTYPE',    _H_LTYPE_TBL, '0', this.linetypes.map(x => x.toString())),
      this._table('LAYER',    _H_LAYER_TBL, '0', this.layers.map(x => x.toString())),
      this._table('STYLE',    _H_STYLE_TBL, '0', this.styles.map(x => x.toString())),
      this._table('VIEW',     _H_VIEW_TBL,  '0', this.views.map(x => x.toString())),
      this._table('UCS',      _H_UCS_TBL,   '0', []),
      this._table('APPID',    _H_APPID_TBL, '0', appidDefs),
      this._table('DIMSTYLE', _H_DIM_TBL,   '0', [dimDef]),
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
      ['9','$HANDSEED','5',_nextHandle()].join(NL),
      ['9','$INSBASE',  _point(this.insbase)].join(NL),
      ['9','$EXTMIN',   _point(this.extmin)].join(NL),
      ['9','$EXTMAX',   _point(this.extmax)].join(NL),
    ]);

    return [header, tables, blocks, entities, objects, '0', 'EOF', ''].join(NL);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Drawing, Layer, LineType, Style, Block, DynamicBlock, LinearParameter, Insert, AttDef, Attrib,
    Line, LwPolyLine, Circle, Arc, Point, Text, Solid, Collection, Entity, calculate_end_point,
  };
}
