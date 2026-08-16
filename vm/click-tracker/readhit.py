#!/usr/bin/env python3
import json, sys
from pathlib import Path

hits = json.loads(Path("/tmp/click-hits.json").read_text() or "[]")
if len(sys.argv) >= 3:
    ax, ay = int(sys.argv[1]), int(sys.argv[2])
    hit = next((r for r in reversed(hits) if r.get("screenX") == ax and r.get("screenY") == ay), None)
else:
    hit = hits[-1] if hits else None
if not hit:
    print("NONE")
    sys.exit(1)
print(f"{hit.get('screenX')},{hit.get('screenY')},{hit.get('clientX')},{hit.get('clientY')},{hit.get('ok')}")
