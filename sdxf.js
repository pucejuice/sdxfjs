/**
 * SDXF JavaScript Translation - Complete & Array Optimized
 * Translated from the Python library sdxf.py
 * Uses String.fromCharCode(10) and Array.join() for maximum performance and inline worker safety.
 *
 * Updated: Added bulge support to PolyLine and LwPolyLine classes.
 *          Pass { bulge: -1 } to apply arc bulge to all vertices (e.g. for donut/filled circles).
 *          Pass an array of bulge values to apply per-vertex bulge.
 *
 * Fixed (2026-03):
 *   1. LwPolyLine.toString() — removed erroneous trailing lines.push('0').
 *      The bare group-code 0 with no value caused "invalid group code" errors in all
 *      DXF readers when two or more LwPolyLine entities appeared in the same drawing.
 *      Entity boundaries are delimited by each entity's own leading '0\nTYPE' header;
 *      no explicit terminator is needed.
 *
 *   2. LwPolyLine.toString() — now emits only group codes 10/20 (X/Y) per vertex.
 *      The original _point() helper emits 10/20/30 for 3-element arrays, but
 *      LWPOLYLINE does not support per-vertex Z via group code 30. Passing [x,y,z]
 *      coordinates produced an invalid group-code sequence. Vertices are now always
 *      written as 2-D pairs regardless of the input array length.
 *
 *   3. LwPolyLine.toString() — added required group codes 90 (vertex count) and
 *      70 (closed flag) before the vertex list, as mandated by the DXF R2000+ spec.
 *      Strict parsers (BricsCAD, recent AutoCAD) reject LWPOLYLINE without group 90.
 *
 *   4. Drawing constructor — ACADVER bumped from AC1006 (R10, 1988) to AC1015 (R2000).
 *      LWPOLYLINE was introduced in R14 (AC1012); declaring AC1006 is therefore invalid
 *      for any drawing that contains LWPOLYLINE entities.
 */

const NL = String.fromCharCode(10);

// --- Helper Functions ---
function _point(x, index = 0) {
    return x.map((val, i) => `${(i + 1) * 10 + index}${NL}${val}`).join(NL);
}

function _points(p) {
    return p.map((pt, i) => _point(pt, i));
}

function calculate_end_point(start_point, angle_degrees, length) {
    const [x_start, y_start] = start_point;
    const angle_radians = angle_degrees * (Math.PI / 180);
    return [
        x_start + length * Math.cos(angle_radians),
        y_start + length * Math.sin(angle_radians)
    ];
}

// --- Base Classes ---
class Entity {
    constructor({ color = 256, extrusion = null, layer = '0', lineType = null, lineTypeScale = null, lineWeight = null, thickness = null, parent = null } = {}) {
        this.color = color;
        this.extrusion = extrusion;
        this.layer = layer;
        this.lineType = lineType;
        this.lineTypeScale = lineTypeScale;
        this.lineWeight = lineWeight;
        this.thickness = thickness;
        this.parent = parent;
    }

    _common() {
        const parent = this.parent || this;
        const lines = ['5', '1', '8', parent.layer];

        if (parent.extrusion !== null) lines.push(_point(parent.extrusion, 200));
        if (parent.lineType !== null) lines.push('6', parent.lineType);
        if (parent.lineWeight !== null) lines.push('370', parent.lineWeight);
        if (parent.lineTypeScale !== null) lines.push('48', parent.lineTypeScale);
        if (parent.thickness !== null) lines.push('39', parent.thickness);
        if (parent.color !== null) lines.push('62', parent.color);

        return lines.join(NL);
    }
}

class Collection {
    constructor(entities = []) {
        this.entities = [...entities];
    }

    append(entity) {
        this.entities.push(entity);
    }

    toString() {
        return this.entities.map(e => e.toString()).join(NL);
    }
}

// --- Table Definitions ---
class Layer {
    constructor({ name = 'pydxf', color = 7, lineType = 'continuous', flag = 64 } = {}) {
        this.name = name.toUpperCase();
        this.color = color;
        this.lineType = lineType;
        this.flag = flag;
    }

    toString() {
        return ['0', 'LAYER', '2', this.name, '70', this.flag, '62', this.color, '6', this.lineType].join(NL);
    }
}

class LineType {
    constructor({ name = 'continuous', description = 'Solid line', elements = [], flag = 64 } = {}) {
        this.name = name.toUpperCase();
        this.description = description;
        this.elements = [...elements];
        this.flag = flag;
    }

    toString() {
        return ['0', 'LTYPE', '2', this.name, '70', this.flag, '3', this.description, '72', '65', '73', this.elements.length, '40', '0.0'].join(NL);
    }
}

class TextLineType {
    constructor({ name = 'continuous', description = 'Solid line', elements = [], flag = 64, height = 2.5, string = 'S' } = {}) {
        this.name = name.toUpperCase();
        this.description = description;
        this.elements = [...elements];
        this.flag = flag;
        this.height = height;
        this.string = string.toUpperCase();
    }

    toString() {
        return [
            '0', 'LTYPE', '2', this.name, '70', this.flag, '3', this.description,
            '72', '65', '73', '3', '40', this.height * 6,
            '49', this.height * 4, '74', '0',
            '49', this.height, '74', '2', '46', -0.5 * this.height,
            '50', '0', '44', '0', '45', -0.5 * this.height, '9', this.string,
            '49', -0.5 * this.height, '74', '0'
        ].join(NL);
    }
}

class Style {
    constructor({ name = 'standard', flag = 0, height = 0, widthFactor = 40, obliqueAngle = 50, mirror = 0, lastHeight = 1, font = 'arial.ttf', bigFont = '' } = {}) {
        this.name = name.toUpperCase();
        this.flag = flag;
        this.height = height;
        this.widthFactor = widthFactor;
        this.obliqueAngle = obliqueAngle;
        this.mirror = mirror;
        this.lastHeight = lastHeight;
        this.font = font.toUpperCase();
        this.bigFont = bigFont.toUpperCase();
    }

    toString() {
        return ['0', 'STYLE', '2', this.name, '70', this.flag, '40', this.flag, '41', this.widthFactor, '50', this.obliqueAngle, '71', this.mirror, '42', this.lastHeight, '3', this.font, '4', this.bigFont].join(NL);
    }
}

class View {
    constructor(name, { flag = 0, width = 1, height = 1, center = [0.5, 0.5], direction = [0, 0, 1], target = [0, 0, 0], lens = 50, frontClipping = 0, backClipping = 0, twist = 0, mode = 0 } = {}) {
        this.name = name;
        this.flag = flag;
        this.width = width;
        this.height = height;
        this.center = center;
        this.direction = direction;
        this.target = target;
        this.lens = lens;
        this.frontClipping = frontClipping;
        this.backClipping = backClipping;
        this.twist = twist;
        this.mode = mode;
    }

    toString() {
        return ['0', 'VIEW', '2', this.name, '70', this.flag, '40', this.height, _point(this.center), '41', this.width, _point(this.direction, 1), _point(this.target, 2), '42', this.lens, '43', this.frontClipping, '44', this.backClipping, '50', this.twist, '71', this.mode].join(NL);
    }
}

function ViewByWindow(name, { leftBottom = [0, 0], rightTop = [1, 1], ...options } = {}) {
    const width = Math.abs(rightTop[0] - leftBottom[0]);
    const height = Math.abs(rightTop[1] - leftBottom[1]);
    const center = [(rightTop[0] + leftBottom[0]) * 0.5, (rightTop[1] + leftBottom[1]) * 0.5];
    return new View(name, { width, height, center, ...options });
}

// --- Blocks & Inserts ---
class Block extends Collection {
    constructor(name, { layer = '0', flag = 0, base = [0, 0, 0], entities = [] } = {}) {
        super(entities);
        this.name = name;
        this.layer = layer;
        this.flag = flag;
        this.base = base;
    }

    toString() {
        const upperName = this.name.toUpperCase();
        return ['0', 'BLOCK', '8', this.layer, '2', upperName, '70', this.flag, _point(this.base), '3', upperName, super.toString(), '0', 'ENDBLK'].join(NL);
    }
}

class Insert extends Entity {
    constructor(name, { point = [0, 0, 0], xscale = null, yscale = null, zscale = null, cols = null, colspacing = null, rows = null, rowspacing = null, rotation = null, ...common } = {}) {
        super(common);
        this.name = name;
        this.point = point;
        this.xscale = xscale;
        this.yscale = yscale;
        this.zscale = zscale;
        this.cols = cols;
        this.colspacing = colspacing;
        this.rows = rows;
        this.rowspacing = rowspacing;
        this.rotation = rotation;
    }

    toString() {
        const lines = ['0', 'INSERT', '2', this.name, this._common(), _point(this.point)];

        if (this.xscale !== null) lines.push('41', this.xscale);
        if (this.yscale !== null) lines.push('42', this.yscale);
        if (this.zscale !== null) lines.push('43', this.zscale);
        if (this.rotation !== null) lines.push('50', this.rotation);
        if (this.cols !== null) lines.push('70', this.cols);
        if (this.colspacing !== null) lines.push('44', this.colspacing);
        if (this.rows !== null) lines.push('71', this.rows);
        if (this.rowspacing !== null) lines.push('45', this.rowspacing);

        return lines.join(NL);
    }
}

// --- Geometry Entities ---
class Line extends Entity {
    constructor(points, commonOptions = {}) {
        super(commonOptions);
        this.points = points;
    }

    toString() {
        return ['0', 'LINE', this._common(), _points(this.points).join(NL)].join(NL);
    }
}

/**
 * PolyLine entity with optional per-vertex bulge.
 *
 * @param {Array} points - Array of [x, y, z] coordinate arrays.
 * @param {Object} options
 * @param {number|null} options.bulge   - Bulge value applied to ALL vertices.
 * @param {Array|null}  options.bulges  - Array of per-vertex bulge values (overrides bulge if set).
 * @param {number|null} options.width   - Constant width for all segments.
 * @param {number}      options.closed  - 1 to close the polyline, 0 for open.
 *
 * Note: PolyLine (old-style POLYLINE/VERTEX) supports 3D coordinates and is valid
 * in all DXF versions. Prefer LwPolyLine for 2D-only data in R2000+ files.
 */
class PolyLine extends Entity {
    constructor(points, { flag = 0, width = null, elevation = null, closed = 0, bulge = null, bulges = null, ...commonOptions } = {}) {
        super(commonOptions);
        this.points = points;
        this.flag = flag;
        this.width = width;
        this.elevation = elevation;
        this.closed = closed;
        this.bulge = bulge;
        this.bulges = bulges;
    }

    toString() {
        const lines = ['0', 'POLYLINE', this._common()];

        if (this.elevation !== null) lines.push('66', '1', '10', '0', '20', '0', '30', this.elevation);
        else lines.push('66', '1', '10', '0', '20', '0', '30', '0');

        if (this.closed) lines.push('70', '1');
        if (this.width !== null) lines.push('40', this.width, '41', this.width);

        for (let idx = 0; idx < this.points.length; idx++) {
            const point = this.points[idx];
            lines.push('0', 'VERTEX', '5', '2', _point(point), '8', '0');

            if (this.bulges !== null && idx < this.bulges.length) {
                lines.push('42', this.bulges[idx]);
            } else if (this.bulge !== null) {
                lines.push('42', this.bulge);
            }
        }
        lines.push('0', 'SEQEND');

        return lines.join(NL);
    }
}

/**
 * LwPolyLine entity — 2D lightweight polyline (R14 / AC1012 and later).
 *
 * @param {Array} points - Array of [x, y] or [x, y, z] coordinate arrays.
 *                         Z values are ignored; LWPOLYLINE is strictly 2D.
 * @param {Object} options
 * @param {number}      options.flag    - Polyline flag: 1 = closed, 0 = open (default 0).
 * @param {number|null} options.width   - Constant width applied to all segments.
 * @param {number|null} options.elevation - Elevation (group code 38).
 * @param {number|null} options.bulge   - Bulge value applied to ALL vertices.
 * @param {Array|null}  options.bulges  - Per-vertex bulge values (overrides bulge).
 *
 * Fixes applied vs original sdxf.js:
 *   - Added group 90 (vertex count) and group 70 (flag) before vertices — required by spec.
 *   - Vertices emit only group codes 10/20 (X/Y); group 30 (Z) is invalid for LWPOLYLINE.
 *   - Removed erroneous trailing lines.push('0') that caused "invalid group code" parse errors.
 */
class LwPolyLine extends Entity {
    constructor(points, { flag = 0, width = null, elevation = null, bulge = null, bulges = null, ...commonOptions } = {}) {
        super(commonOptions);
        this.points = points;
        this.flag = flag;
        this.width = width;
        this.elevation = elevation;
        this.bulge = bulge;
        this.bulges = bulges;
    }

    toString() {
        const lines = ['0', 'LWPOLYLINE', this._common()];

        // Group 90: vertex count — required by DXF R2000+ spec before vertex list
        lines.push('90', this.points.length);
        // Group 70: polyline flag (1 = closed)
        lines.push('70', this.flag || 0);

        if (this.width !== null) lines.push('43', this.width);
        if (this.elevation !== null) lines.push('38', this.elevation);

        for (let idx = 0; idx < this.points.length; idx++) {
            const point = this.points[idx];
            // Emit only X (10) and Y (20) — LWPOLYLINE does not support per-vertex Z (30)
            lines.push(`10${NL}${point[0]}`, `20${NL}${point[1]}`);

            if (this.bulges !== null && idx < this.bulges.length) {
                lines.push('42', this.bulges[idx]);
            } else if (this.bulge !== null) {
                lines.push('42', this.bulge);
            }
        }

        // No trailing '0' — entity boundary is delimited by the next entity's own '0\nTYPE' header.
        // Adding a bare '0' here causes the join with the next entity to produce:
        //   ...last vertex...\n0\n0\nNEXT_TYPE  →  parser sees 'NEXT_TYPE' as a group code → error.
        return lines.join(NL);
    }
}

class Circle extends Entity {
    constructor(center = [0, 0, 0], radius = 1, commonOptions = {}) {
        super(commonOptions);
        this.center = center;
        this.radius = radius;
    }

    toString() {
        return ['0', 'CIRCLE', this._common(), _point(this.center), '40', this.radius].join(NL);
    }
}

class Arc extends Entity {
    constructor(center = [0, 0, 0], radius = 1, startAngle = 0.0, endAngle = 90.0, commonOptions = {}) {
        super(commonOptions);
        this.center = center;
        this.radius = radius;
        this.startAngle = startAngle;
        this.endAngle = endAngle;
    }

    toString() {
        return ['0', 'ARC', this._common(), _point(this.center), '40', this.radius, '50', this.startAngle, '51', this.endAngle].join(NL);
    }
}

class Point extends Entity {
    constructor(point = [0, 0, 0], commonOptions = {}) {
        super(commonOptions);
        this.point = point;
    }

    toString() {
        return ['0', 'POINT', this._common(), _point(this.point)].join(NL);
    }
}

class Solid extends Entity {
    constructor(points = [], commonOptions = {}) {
        super(commonOptions);
        this.points = points;
    }

    toString() {
        const p = this.points;
        const reorderedPoints = [p[0], p[1], p[3], p[2]];
        return ['0', 'SOLID', this._common(), _points(reorderedPoints).join(NL)].join(NL);
    }
}

class Face extends Entity {
    constructor(points, commonOptions = {}) {
        super(commonOptions);
        this.points = points;
    }

    toString() {
        return ['0', '3DFACE', this._common(), _points(this.points).join(NL)].join(NL);
    }
}

class Dimension extends Entity {
    constructor(startPoint, endPoint, dimLinePoint, { text = '', textPoint = null, type = 1, angle = null, ...commonOptions } = {}) {
        super(commonOptions);
        this.startPoint = startPoint;
        this.endPoint = endPoint;
        this.dimLinePoint = dimLinePoint;
        this.text = text;
        this.textPoint = textPoint || dimLinePoint;
        this.type = type;
        this.angle = angle;
    }

    toString() {
        const lines = [
            '0', 'DIMENSION',
            this._common(),
            '2', '*D1',
            _point(this.dimLinePoint, 10),
            _point(this.textPoint, 11),
            '70', this.type,
            '1', this.text,
            _point(this.startPoint, 13),
            _point(this.endPoint, 14)
        ];

        if (this.type === 0 && this.angle !== null) lines.push('50', this.angle);
        return lines.join(NL);
    }
}

// --- Text Entities ---
class Text extends Entity {
    constructor(text = '', point = [0, 0, 0], { alignment = null, flag = null, height = 1, justifyhor = null, justifyver = null, rotation = null, obliqueAngle = null, style = null, xscale = null, ...common } = {}) {
        super(common);
        this.text = text;
        this.point = point;
        this.alignment = alignment;
        this.flag = flag;
        this.height = height;
        this.justifyhor = justifyhor;
        this.justifyver = justifyver;
        this.rotation = rotation;
        this.obliqueAngle = obliqueAngle;
        this.style = style;
        this.xscale = xscale;
    }

    toString() {
        const lines = [];

        if (this.justifyhor !== null) {
            const rot = this.rotation || 0;
            const justifiedpoint = calculate_end_point(this.point, rot + 90, this.text.length * 0.75 * this.height);
            lines.push('0', 'TEXT', this._common(), _point(justifiedpoint), '40', this.height, '1', this.text);
        } else {
            lines.push('0', 'TEXT', this._common(), _point(this.point), '40', this.height, '1', this.text);
        }

        if (this.rotation !== null) lines.push('50', this.rotation);
        if (this.xscale !== null) lines.push('41', this.xscale);
        if (this.obliqueAngle !== null) lines.push('51', this.obliqueAngle);
        if (this.style !== null) lines.push('7', this.style);
        if (this.flag !== null) lines.push('71', this.flag);

        if (this.justifyhor !== null) {
            lines.push('72', `\t${this.justifyhor}`, '11', this.point[0], '21', this.point[1], '31', '0');
        }
        if (this.alignment !== null) lines.push(_point(this.alignment, 1));
        if (this.justifyver !== null) lines.push('73', this.justifyver);

        return lines.join(NL);
    }
}

class Mtext extends Text {
    constructor(text = '', point = [0, 0, 0], { width = 250, spacingFactor = 1.5, down = 0, spacingWidth = null, ...options } = {}) {
        super(text, point, options);
        this.width = width;
        this.down = down;
        this.spacingFactor = down ? spacingFactor * -1 : spacingFactor;
        this.spacingWidth = spacingWidth;
    }

    toString() {
        const texts = this.text.replace(/\r\n/g, NL).split(NL);
        if (!this.down) texts.reverse();

        const lines = [];
        let x = 0;
        let y = 0;
        const spcWidth = this.spacingWidth !== null ? this.spacingWidth : this.height * this.spacingFactor;

        for (let textLine of texts) {
            let remainingText = textLine;
            while (remainingText) {
                const chunk = remainingText.substring(0, this.width);
                const pt = [this.point[0] + x * spcWidth, this.point[1] + y * spcWidth, this.point[2] || 0];

                const t = new Text(chunk, pt, {
                    alignment: this.alignment, flag: this.flag, height: this.height,
                    justifyhor: this.justifyhor, justifyver: this.justifyver,
                    rotation: this.rotation, obliqueAngle: this.obliqueAngle,
                    style: this.style, xscale: this.xscale, parent: this
                });

                lines.push(t.toString());
                remainingText = remainingText.substring(this.width);

                if (this.rotation) x++; else y++;
            }
        }
        return lines.join(NL);
    }
}

// --- Composed Geometries ---
class Rectangle extends Entity {
    constructor({ point = [0, 0, 0], width = 1, height = 1, solid = null, line = 1, ...commonOptions } = {}) {
        super(commonOptions);
        this.point = point;
        this.width = width;
        this.height = height;
        this.solid = solid;
        this.line = line;
    }

    toString() {
        const lines = [];
        const p0 = this.point;
        const p1 = [p0[0] + this.width, p0[1], p0[2] || 0];
        const p2 = [p0[0] + this.width, p0[1] + this.height, p0[2] || 0];
        const p3 = [p0[0], p0[1] + this.height, p0[2] || 0];
        const points = [p0, p1, p2, p3, p0];

        if (this.solid) {
            const solidEnt = new Solid(points.slice(0, 4), { parent: this.solid });
            lines.push(solidEnt.toString());
        }

        if (this.line) {
            for (let i = 0; i < 4; i++) {
                const lineEnt = new Line([points[i], points[i + 1]], { parent: this });
                lines.push(lineEnt.toString());
            }
        }

        return lines.join(NL);
    }
}

class LineList extends Entity {
    constructor(points = [], { closed = 0, ...commonOptions } = {}) {
        super(commonOptions);
        this.points = [...points];
        this.closed = closed;
    }

    toString() {
        const lines = [];
        const points = this.closed ? [...this.points, this.points[0]] : this.points;

        for (let i = 0; i < points.length - 1; i++) {
            const lineEnt = new Line([points[i], points[i + 1]], { parent: this });
            lines.push(lineEnt.toString());
        }

        return lines.join(NL);
    }
}

// --- Main Drawing Wrapper ---
class Drawing extends Collection {
    constructor({
        insbase = [0.0, 0.0, 0.0],
        extmin = [0.0, 0.0],
        extmax = [0.0, 0.0],
        layers = [new Layer()],
        linetypes = [new LineType()],
        styles = [new Style()],
        views = [],
        blocks = [],
        entities = []
    } = {}) {
        super(entities);
        this.insbase = insbase;
        this.extmin = extmin;
        this.extmax = extmax;
        this.layers = [...layers];
        this.linetypes = [...linetypes];
        this.styles = [...styles];
        this.views = [...views];
        this.blocks = [...blocks];

        // AC1015 = R2000. LWPOLYLINE was introduced in R14 (AC1012); AC1006 (R10) is invalid
        // for drawings containing LWPOLYLINE entities.
        this._acadver = ['9', '$ACADVER', '1', 'AC1015'].join(NL);
        this._HEADER_POINTS = ['insbase', 'extmin', 'extmax'];
    }

    _name(x) {
        return ['9', `$${x.toUpperCase()}`].join(NL);
    }

    _drawingPoint(name, x) {
        return [this._name(name), _point(x)].join(NL);
    }

    _section(name, items) {
        const xstr = items && items.length > 0 ? NL + items.join(NL) : '';
        return ['0', 'SECTION', '2', name.toUpperCase() + xstr, '0', 'ENDSEC'].join(NL);
    }

    _table(name, items) {
        const xstr = items && items.length > 0 ? NL + items.join(NL) : '';
        return ['0', 'TABLE', '2', name.toUpperCase(), '70', items.length.toString() + xstr, '0', 'ENDTAB'].join(NL);
    }

    toString() {
        const headerItems = [this._acadver];
        for (const attr of this._HEADER_POINTS) {
            headerItems.push(this._drawingPoint(attr, this[attr]));
        }
        const header = this._section('header', headerItems);

        const tablesItems = [
            this._table('ltype', this.linetypes.map(x => x.toString())),
            this._table('layer', this.layers.map(x => x.toString())),
            this._table('style', this.styles.map(x => x.toString())),
            this._table('view', this.views.map(x => x.toString()))
        ];
        const tables = this._section('tables', tablesItems);

        const blocks = this._section('blocks', this.blocks.map(x => x.toString()));

        const entities = this._section('entities', this.entities.map(x => x.toString()));

        return [header, tables, blocks, entities, '0', 'EOF', ''].join(NL);
    }
    }
