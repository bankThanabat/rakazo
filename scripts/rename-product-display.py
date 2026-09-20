#!/usr/bin/env python3
"""Rename display copy, preserving wire IDs, package names, URLs and icon sources.

Run with --write to apply, or without arguments to check. Includes consumers and
their test expectations. Historical docs and generated native projects are not
rewritten. Runtime identity is intentionally retained in desktop identity.ts.
"""
import argparse
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".json", ".html", ".astro", ".po", ".svg", ".webmanifest", ".yaml", ".yml", ".sh", ".py", ".desktop", ".menu", ".service", ".timer"}
BUILD_SCRIPTS = {
    "infra/compose/backup-prod.sh",
    "scripts/capture-ios-launch.sh",
    "scripts/verify-ios-flow.sh",
    "scripts/verify-mobile-readiness.sh",
}
NAME = re.compile(r'''(?:https?|ssh)://[^\s"'<>`]+|\bRakazo\b(?!\.icon)''')


def renamed(text: str, filename: str) -> str:
    if filename in {"apps/desktop/src/identity.ts", "apps/desktop/src/identity.test.ts", "packages/adapters/src/desktop-sandbox-paths.test.ts"}:
        return text
    # Don't churn standalone code comments or localization source references.
    result = "".join(
        line if line.lstrip().startswith(("//", "/*", "*", "#:")) else NAME.sub(lambda match: "Deskazo" if match[0] == "Rakazo" else match[0], line)
        for line in text.splitlines(keepends=True)
    )
    if filename == "apps/www/src/components/Logo.astro":
        result = result.replace('class="brand-lockup__word">rakazo<', 'class="brand-lockup__word">deskazo<')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=ROOT
    ).decode().split("\0")
    changed = []
    for filename in sorted(set(paths)):
        path = ROOT / filename
        selected = filename.startswith(("apps/", "packages/", "infra/", ".github/"))
        if not ((selected and path.suffix in SUFFIXES) or filename in BUILD_SCRIPTS):
            continue
        if not path.is_file():
            continue
        before = path.read_text()
        after = renamed(before, filename)
        if before == after:
            continue
        changed.append(filename)
        if args.write:
            path.write_text(after)
    print("\n".join(changed) if changed else "Display names are current.")
    if changed and not args.write:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
