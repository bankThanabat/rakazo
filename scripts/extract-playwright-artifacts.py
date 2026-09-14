#!/usr/bin/env python3
"""Extract untrusted CI reports into a fresh directory outside the checkout."""
import pathlib
import shutil
import stat
import sys
import zipfile


def extract(archive_path, destination):
    destination = pathlib.Path(destination)
    if destination.exists() or destination.is_symlink():
        raise ValueError("Artifact destination already exists")
    with zipfile.ZipFile(archive_path) as archive:
        entries = archive.infolist()
        if len(entries) > 100_000 or sum(entry.file_size for entry in entries) > 5_000_000_000:
            raise ValueError("Artifact exceeds extraction limit")
        names = set()
        for entry in entries:
            name = pathlib.PurePosixPath(entry.filename)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            if (name.is_absolute() or ".." in name.parts or "\\" in entry.filename
                    or not name.parts or ":" in name.parts[0]
                    or mode not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or name in names):
                raise ValueError("Unsafe artifact entry")
            names.add(name)
        destination.mkdir(parents=True, exist_ok=False)
        try:
            for entry in entries:
                target = destination / entry.filename
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(entry) as source, target.open("xb") as output:
                        shutil.copyfileobj(source, output)
        except Exception:
            shutil.rmtree(destination)
            raise


if __name__ == "__main__":
    extract(*sys.argv[1:])
