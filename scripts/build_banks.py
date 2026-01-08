#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import hashlib
import json
from pathlib import Path
from typing import Dict, List

from extract_questions import parse_pdf  # type: ignore


def make_bank_id(filename: str) -> str:
    # Use a stable short hash so paths are ASCII-safe (works well on GitHub Pages)
    h = hashlib.sha1(filename.encode("utf-8")).hexdigest()[:10]
    return f"b{h}"


def build_bank(pdf_path: Path, out_dir: Path) -> Dict:
    display_name = pdf_path.stem
    bank_id = make_bank_id(pdf_path.name)
    questions = parse_pdf(pdf_path)

    bank_dir = out_dir / bank_id
    bank_dir.mkdir(parents=True, exist_ok=True)

    payload = {
        "meta": {
            "bankId": bank_id,
            "bankName": display_name,
            "source": pdf_path.name,
            "count": len(questions),
        },
        "questions": [q.__dict__ for q in questions],
    }

    (bank_dir / "questions.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    return {
        "id": bank_id,
        "name": display_name,
        "sourceFile": pdf_path.name,
        "questionsPath": f"banks/{bank_id}/questions.json",
        "count": len(questions),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="Build multiple banks for the web app")
    ap.add_argument("--bankDir", default="bank", help="Folder containing bank files (PDFs)")
    ap.add_argument("--outDir", default="web/banks", help="Output folder under web")
    args = ap.parse_args()

    bank_dir = Path(args.bankDir)
    out_dir = Path(args.outDir)
    out_dir.mkdir(parents=True, exist_ok=True)

    pdfs = sorted([p for p in bank_dir.iterdir() if p.is_file() and p.suffix.lower() == ".pdf"] , key=lambda p: p.name)
    banks: List[Dict] = []

    for pdf in pdfs:
        banks.append(build_bank(pdf, out_dir))

    index = {
        "meta": {"count": len(banks)},
        "banks": banks,
    }

    (out_dir / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"Built {len(banks)} bank(s) into {out_dir}")


if __name__ == "__main__":
    main()
