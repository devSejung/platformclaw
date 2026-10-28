#!/usr/bin/env python3
"""Configure only the synthetic SafeConnect user's recovery scenario."""
import json
from pathlib import Path
import sys

allocations = json.loads(Path("/fixture/allocations.json").read_text(encoding="utf-8"))["allocations"]
allocation = next(row for row in allocations if row["linuxAccount"] == "person_one")
username = "{adDomain}\\{adAccount}+{linuxAccount}+{targetAddress}".format(**allocation)
path = Path("/state/auth-behavior.json")
mode = sys.argv[1]
if mode == "rotate":
    behavior = {"password": allocation["password"] + "-rotated", "finalRejection": True}
elif mode in ("command-failure", "command-failure-255"):
    behavior = {
        "password": allocation["password"] + "-rotated",
        "finalRejection": True,
        "commandExit": 5 if mode == "command-failure" else 255,
    }
elif mode == "restore":
    behavior = {}
else:
    raise ValueError("unknown recovery scenario mode")
path.write_text(json.dumps({username: behavior}), encoding="utf-8")
print(json.dumps({"configured": mode}))
