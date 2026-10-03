"""Validate DXF files written by sdxf.js.

    python3 tests/check_dxf.py tests/out/*.dxf [--render]

Checks, per file:
  * unique handles, every owner (330) handle exists, $HANDSEED above all handles
  * every BLOCK has a BLOCK_RECORD
  * ezdxf loads it and its audit reports no errors and no fixes
  * --render: draws model space with ezdxf's drawing add-on (PNG next to the DXF)
Exit code 1 if any file fails.
"""
import sys
import ezdxf
from ezdxf.lldxf.tagger import ascii_tags_loader


def structure(path):
    tags = list(ascii_tags_loader(open(path, encoding="cp1252")))
    handles, owners, blocks, records = [], [], [], []
    kind, section = None, None
    for i, t in enumerate(tags):
        if t.code == 0:
            kind = t.value
        if kind == "SECTION" and t.code == 2:
            section = t.value
        if section == "HEADER":
            continue
        if t.code == 5 or (t.code == 105 and kind == "DIMSTYLE"):
            handles.append(t.value)
        if t.code == 330 and t.value != "0":
            owners.append((kind, t.value))
        if t.code == 2 and kind == "BLOCK":
            blocks.append(t.value.upper())
        if t.code == 2 and kind == "BLOCK_RECORD":
            records.append(t.value.upper())
    errors = []
    if len(handles) != len(set(handles)):
        errors.append("duplicate handles")
    known = set(handles)
    missing = sorted({f"{k}->{h}" for k, h in owners if h not in known})
    if missing:
        errors.append(f"unknown owner handles: {missing[:5]}")
    no_record = sorted(set(blocks) - set(records))
    if no_record:
        errors.append(f"blocks without BLOCK_RECORD: {no_record}")
    seed = next(tags[i + 1].value for i, t in enumerate(tags) if t.code == 9 and t.value == "$HANDSEED")
    if int(seed, 16) <= max(int(h, 16) for h in handles):
        errors.append("$HANDSEED not above all handles")
    return errors


def main(argv):
    render = "--render" in argv
    files = [a for a in argv if not a.startswith("--")]
    failed = 0
    for path in files:
        errors = structure(path)
        doc = ezdxf.readfile(path)
        auditor = doc.audit()
        errors += [f"audit: {e.message}" for e in auditor.errors]
        errors += [f"audit fix: {e.message}" for e in auditor.fixes]
        if render:
            import matplotlib
            matplotlib.use("Agg")
            from ezdxf.addons.drawing import matplotlib as mpl
            mpl.qsave(doc.modelspace(), path[:-4] + ".png", bg="#FFFFFF", dpi=90)
        counts = {}
        for e in doc.modelspace():
            counts[e.dxftype()] = counts.get(e.dxftype(), 0) + 1
        status = "FAIL" if errors else "ok  "
        print(f"{status} {path}  {dict(sorted(counts.items()))}")
        for e in errors:
            print(f"       {e}")
        failed += bool(errors)
    print(f"{len(files) - failed}/{len(files)} DXF files valid")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
