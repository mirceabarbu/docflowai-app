#!/usr/bin/env python3
"""
DocFlowAI — Import adrese email reale primării România
======================================================

Descarcă și procesează emailurile reale din:
  1. GitHub: github.com/baditaflorin/adrese-email-primarii  (XLSX per județ)
  2. data.gov.ro: dataset oficial MCPDC (XLSX combinat)

Output: tools/primarii-romania.json  (înlocuiește fișierul generat anterior)

Utilizare:
  python3 tools/import-primarii-emails.py
  python3 tools/import-primarii-emails.py --source datagov   # doar data.gov.ro
  python3 tools/import-primarii-emails.py --source github    # doar GitHub
  python3 tools/import-primarii-emails.py --source local --file ~/Downloads/contacte.xlsx
  python3 tools/import-primarii-emails.py --dry-run          # doar afișează, nu scrie

Cerințe:
  pip install requests openpyxl
"""

import sys
import os
import re
import json
import time
import argparse
import unicodedata
import urllib.request
from pathlib import Path

try:
    import requests
except ImportError:
    print("❌ Lipsă: pip install requests")
    sys.exit(1)

try:
    import openpyxl
except ImportError:
    print("❌ Lipsă: pip install openpyxl")
    sys.exit(1)

# ── Configurare ───────────────────────────────────────────────────────────

GITHUB_API   = "https://api.github.com/repos/baditaflorin/adrese-email-primarii/contents/"
GITHUB_RAW   = "https://raw.githubusercontent.com/baditaflorin/adrese-email-primarii/master/"
DATAGOV_URL  = "https://data.gov.ro/dataset/805f2f40-c191-4357-a8c2-3a001c751d97/resource/3f4ee077-324e-45b3-8e48-e73197f75be6/download/date-de-contact-institui-i-autoriti-publice.xlsx"

OUTPUT_FILE  = Path(__file__).parent / "prim