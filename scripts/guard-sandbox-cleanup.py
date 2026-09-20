"""Idempotently guard concrete sandbox cleanup and reconnection by provider kind."""
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent
for kind in ("docker", "e2b", "daytona", "box", "desktop", "fake"):
    file = root / f"packages/adapters/src/{kind}-sandbox.ts"
    source = file.read_text()
    pattern = r'import \{([^{}]*)\} from "\./computer-support.js";'
    for symbol in ("assertComputerKind", "assertProvisionKind"):
        match = re.search(pattern, source)
        assert match, file
        if symbol not in match[1]:
            source = source[:match.start(1)] + f" {symbol}," + source[match.start(1):]
    expected = "this.kind" if kind == "fake" else f'"{kind}"'
    for operation in ("stop", "destroy"):
        pattern = rf'async {operation}\(computer: ComputerRef,[^)]*\): Promise<void> \{{\n'
        match = re.search(pattern, source)
        assert match, (file, operation)
        guard = f"    assertComputerKind(computer, {expected});\n"
        if not source[match.end():].startswith(guard):
            assert not source[match.end():].lstrip().startswith("assertComputerKind"), file
            source = source[:match.end()] + guard + source[match.end():]
    signature = r'async provision\(\n    request: (\{[^{}]*\}|Parameters<SandboxProvider\["provision"\]>\[0\])'
    match = re.search(signature, source)
    assert match, file
    source = source[:match.start(1)] + 'Parameters<SandboxProvider["provision"]>[0]' + source[match.end(1):]
    match = re.search(r'async provision\([\s\S]*?\): Promise<ComputerRef> \{\n', source)
    assert match, file
    guard = f"    assertProvisionKind(request, {expected});\n"
    if not source[match.end():].startswith(guard):
        assert not source[match.end():].lstrip().startswith("assertProvisionKind"), file
        source = source[:match.end()] + guard + source[match.end():]
    if source != file.read_text():
        file.write_text(source)
