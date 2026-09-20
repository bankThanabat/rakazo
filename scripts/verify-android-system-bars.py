#!/usr/bin/env python3
"""Check the portrait emulator's status-bar window against its cutout inset.

Consumes diagnostics from verify-android-flow.sh. This checks window geometry,
not all screenshot pixels or physical-device rendering.
"""
import argparse
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("report", type=Path)
args = parser.parse_args()
windows = re.findall(
    r"  Window #\d+ Window\{[^\n]* StatusBar\}:\n(.*?)(?=\n  Window #|\Z)",
    (args.report / "window.txt").read_text(),
    re.S,
)
displays = [line for line in (args.report / "display.txt").read_text().splitlines()
            if line.strip().startswith('DisplayDeviceInfo{"Built-in Screen"')]
assert len(windows) == len(displays) == 1, "Expected one built-in display and status-bar window"
assert "mDisplayId=0" in windows[0] and "rotation 0," in displays[0], "Expected portrait display 0"
height = re.search(r"Requested w=\d+ h=(\d+)", windows[0])
cutout = re.search(r"cutout DisplayCutout\{insets=Rect\(\d+, (\d+) -", displays[0])
assert height and cutout, "Missing status-bar height or display cutout diagnostics"
result = {"statusBarHeight": int(height[1]), "cutoutTopInset": int(cutout[1])}
# Android's SystemBarUtils uses max(safeInsetTop, defaultHeight + waterfallTop).
# A status-bar window smaller than the top cutout cannot satisfy that contract.
result["coversTopCutout"] = result["statusBarHeight"] >= result["cutoutTopInset"]
(args.report / "system-bars.json").write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
raise SystemExit(0 if result["coversTopCutout"] else 1)
