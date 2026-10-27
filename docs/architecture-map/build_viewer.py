"""Build this project's viewer without changing the global Skill template."""
import importlib.util
from pathlib import Path

builder_path = Path.home() / ".agents/skills/project-architecture-map/scripts/build_map.py"
spec = importlib.util.spec_from_file_location("architecture_builder", builder_path)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
builder.ASSETS = Path(__file__).resolve().parent / "viewer"

if __name__ == "__main__":
    raise SystemExit(builder.main())
