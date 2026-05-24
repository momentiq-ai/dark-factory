"""Add the bundled cycle-tracker-sync script directory to sys.path."""

from __future__ import annotations

import sys
from pathlib import Path

SCRIPT_DIR = (
    Path(__file__).resolve().parents[2] / "src" / "cycle-tracker-sync"
)
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))
