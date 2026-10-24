from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
output = root / "build" / "site"
if output.exists():
    shutil.rmtree(output)
shutil.copytree(root / "dist", output / "seiko", ignore=shutil.ignore_patterns("*.test.mjs"))
