#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import json
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import fitz  # pymupdf


QUESTION_START_RE = re.compile(r"^(?P<num>\d+)[\.．。]\s*【(?P<type>单选题|多选题|判断题|填空题)】(?P<rest>.*)$")
# Plain numbering: 1. / 1． / 1、
PLAIN_QUESTION_START_RE = re.compile(r"^(?P<num>\d+)[\.．。、]\s*(?P<rest>.*)$")
# Options: A. / A． / A、 / A: / A：
OPTION_RE = re.compile(r"^(?P<label>[A-H])[\.．。、:：]\s*(?P<text>.*)$")
ANSWER_RE = re.compile(r"^答案[:：]\s*(?P<ans>.*)$")
ANSWER_EXPL_RE = re.compile(r"^答案解释[:：]\s*(?P<expl>.*)$")
DIFF_RE = re.compile(r"^难易度[:：](?P<diff>.*)$")
PAREN_ANSWER_INLINE_RE = re.compile(r"[（(]\s*([A-H]{1,8})\s*[)）]")
PAREN_ANSWER_STANDALONE_RE = re.compile(r"^[（(]\s*([A-H]{1,8})\s*[)）]\s*$")
INLINE_OPTION_MARK_RE = re.compile(r"(?P<label>[A-H])[\.．。、]\s*")


@dataclass
class Question:
    id: str
    type: str  # single|multiple|judge|blank
    stem: str
    options: Optional[Dict[str, str]] = None
    answer: Optional[str] = None  # e.g. "A" / "ABD" / "伟大建党精神"
    explanation: Optional[str] = None
    difficulty: Optional[str] = None
    source: Optional[Dict[str, int]] = None  # {page: 58}


def normalize_line(line: str) -> str:
    # Remove common invisible chars that break regex anchors
    line = line.replace("\ufeff", "").replace("\u200b", "")
    line = line.replace("\u3000", " ")
    line = re.sub(r"\s+", " ", line).strip()
    return line


def extract_inline_options(line: str) -> Tuple[str, Optional[Dict[str, str]]]:
    """Extract options embedded in a single line.

    Examples:
      "... 根基是。 A、师德建设 B、提高教育质量 C、... D、..."
      "A.接力跑B.持久战C.耐力赛D.持续跑"
    """
    matches = list(INLINE_OPTION_MARK_RE.finditer(line))
    if not matches:
        return line, None

    # Heuristic: treat as inline options if there are at least 2 markers,
    # or if the line starts with an option marker.
    starts_with_marker = bool(OPTION_RE.match(line))
    if len(matches) < 2 and not starts_with_marker:
        return line, None

    prefix = normalize_line(line[: matches[0].start()])
    opts: Dict[str, str] = {}
    for idx, m in enumerate(matches):
        label = m.group("label")
        start = m.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(line)
        text = normalize_line(line[start:end])
        if text:
            opts[label] = text

    if len(opts) >= 2 or (starts_with_marker and len(opts) >= 1):
        return prefix, opts
    return line, None


def question_type_map(t: str) -> str:
    return {
        "单选题": "single",
        "多选题": "multiple",
        "判断题": "judge",
        "填空题": "blank",
    }[t]


def is_noise_line(line: str) -> bool:
    if not line:
        return True
    # Page numbers like "56", "57" etc.
    if line.isdigit() and len(line) <= 3:
        return True
    # Table of contents leftovers etc.
    return False


def join_parts(parts: List[str]) -> str:
    text = " ".join(p for p in parts if p)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _is_letter_answer(ans: str) -> bool:
    return bool(re.fullmatch(r"[A-H]{1,8}", ans.strip().upper()))


def _infer_judge_from_options(options: Dict[str, str]) -> bool:
    if set(options.keys()) != {"A", "B"}:
        return False
    a = normalize_line(options.get("A", ""))
    b = normalize_line(options.get("B", ""))
    pairs = {
        ("对", "错"),
        ("正确", "错误"),
        ("是", "否"),
    }
    return (a, b) in pairs


def _map_answer_to_letters(answer_raw: str, options: Dict[str, str]) -> str:
    """Try to map an answer text to option letters.

    Supports:
    - Already-letter answers: "ABCD"
    - Answer equals an option text: "8" -> label with text "8"
    - Answer contains multiple option texts separated by commas
    - Answer line contains letters somewhere: "答案: A ... ,B ..." -> "AB"
    """

    ans = normalize_line(answer_raw)
    if not ans:
        return ans

    # If letters are explicitly present, prefer that.
    letters = re.findall(r"[A-H]", ans.upper())
    if letters:
        uniq = "".join(sorted(set(letters)))
        if _is_letter_answer(uniq):
            return uniq

    if not options:
        return ans

    # Normalize option texts
    opt_norm = {k: normalize_line(v) for k, v in options.items()}
    opt_norm_lower = {k: opt_norm[k].lower() for k in opt_norm}

    # Split answer by common separators to match multiple items
    parts = [p.strip() for p in re.split(r"[，,;；]\s*", ans) if p.strip()]
    candidates = parts if len(parts) > 1 else [ans]

    matched: List[str] = []
    for part in candidates:
        part_n = normalize_line(part)
        part_l = part_n.lower()

        # Exact match first
        for label, text in opt_norm_lower.items():
            if part_l == text:
                matched.append(label)
                break
        else:
            # Contains match (for long phrases)
            for label, text in opt_norm_lower.items():
                if text and text in part_l:
                    matched.append(label)
            # If nothing, try reverse contains (answer contains option)
            if not matched:
                for label, text in opt_norm_lower.items():
                    if part_l and part_l in text:
                        matched.append(label)

    if matched:
        uniq = "".join(sorted(set(matched)))
        return uniq

    return ans


def parse_pdf(pdf_path: Path) -> List[Question]:
    doc = fitz.open(str(pdf_path))

    questions: List[Question] = []
    current: Optional[Question] = None
    stem_parts: List[str] = []

    current_option_label: Optional[str] = None
    option_parts: Dict[str, List[str]] = {}

    explanation_parts: List[str] = []

    skipped_unanswered = 0

    def finalize_current():
        nonlocal skipped_unanswered
        nonlocal current, stem_parts, current_option_label, option_parts, explanation_parts
        if not current:
            return

        current.stem = join_parts(stem_parts)

        if option_parts:
            current.options = {k: join_parts(v) for k, v in option_parts.items()}

        # Normalize answers for choice/judge questions where the PDF provides answer text.
        if current.answer and current.options and current.type in {"single", "multiple", "judge"}:
            mapped = _map_answer_to_letters(current.answer, current.options)
            if mapped and _is_letter_answer(mapped):
                current.answer = mapped
                current.type = "multiple" if len(mapped) > 1 else "single"
                if _infer_judge_from_options(current.options):
                    current.type = "judge"

        if explanation_parts:
            current.explanation = join_parts(explanation_parts)

        if current.stem and current.answer:
            questions.append(current)
        else:
            skipped_unanswered += 1

        current = None
        stem_parts = []
        current_option_label = None
        option_parts = {}
        explanation_parts = []

    for page_index in range(doc.page_count):
        page = doc.load_page(page_index)
        text = str(page.get_text("text") or "")
        raw_lines = text.splitlines()

        for raw in raw_lines:
            line = normalize_line(raw)
            if is_noise_line(line):
                continue

            m_start = QUESTION_START_RE.match(line)
            if m_start:
                # New question starts; finalize previous
                finalize_current()

                qnum = m_start.group("num")
                qtype_cn = m_start.group("type")
                rest = normalize_line(m_start.group("rest"))

                current = Question(
                    id=f"p{page_index + 1}-{qnum}",
                    type=question_type_map(qtype_cn),
                    stem="",
                    options=None,
                    answer=None,
                    explanation=None,
                    difficulty=None,
                    source={"page": page_index + 1, "number": int(qnum)},
                )
                if rest:
                    stem_parts.append(rest)
                continue

            # Plain format: "12. ..." with options below and answer like "( C )" either inline or standalone line.
            m_plain = PLAIN_QUESTION_START_RE.match(line)
            if m_plain and not line.startswith("答案"):
                # Avoid treating option lines or other dotted items as question starts
                if OPTION_RE.match(line):
                    pass
                else:
                    # If it's actually the bracket style, it would have matched earlier.
                    finalize_current()
                    qnum = m_plain.group("num")
                    rest = normalize_line(m_plain.group("rest"))

                    current = Question(
                        id=f"p{page_index + 1}-{qnum}",
                        type="single",  # will adjust to multiple if needed
                        stem="",
                        options=None,
                        answer=None,
                        explanation=None,
                        difficulty=None,
                        source={"page": page_index + 1, "number": int(qnum)},
                    )

                    # Extract inline answer if present in the rest
                    if rest:
                        m_inline = PAREN_ANSWER_INLINE_RE.search(rest)
                        if m_inline:
                            ans = normalize_line(m_inline.group(1)).upper()
                            current.answer = ans
                            # Remove the answer token from the stem text
                            rest = normalize_line(PAREN_ANSWER_INLINE_RE.sub("", rest))
                            current.type = "multiple" if len(ans) > 1 else "single"
                        if rest:
                            stem_parts.append(rest)
                    continue

            if not current:
                continue

            # Plain format answer can be on a standalone line like "( C )"
            m_standalone = PAREN_ANSWER_STANDALONE_RE.match(line)
            if m_standalone and not current.answer:
                ans = normalize_line(m_standalone.group(1)).upper()
                current.answer = ans
                current.type = "multiple" if len(ans) > 1 else "single"
                current_option_label = None
                continue

            # Plain format answer can also be inline on a continuation line like "...。( C )"
            if not current.answer:
                m_inline_any = PAREN_ANSWER_INLINE_RE.search(line)
                if m_inline_any:
                    ans = normalize_line(m_inline_any.group(1)).upper()
                    current.answer = ans
                    current.type = "multiple" if len(ans) > 1 else "single"
                    line = normalize_line(PAREN_ANSWER_INLINE_RE.sub("", line))
                    if not line:
                        continue

            m_ans = ANSWER_RE.match(line)
            if m_ans:
                current.answer = normalize_line(m_ans.group("ans"))
                current_option_label = None
                continue

            m_expl = ANSWER_EXPL_RE.match(line)
            if m_expl:
                explanation_parts.append(normalize_line(m_expl.group("expl")))
                current_option_label = None
                continue

            m_diff = DIFF_RE.match(line)
            if m_diff:
                current.difficulty = normalize_line(m_diff.group("diff"))
                current_option_label = None
                continue

            # If we are already in explanation, keep collecting until difficulty/new question
            if explanation_parts and not OPTION_RE.match(line) and not ANSWER_RE.match(line):
                explanation_parts.append(line)
                continue

            # Inline options embedded in the same line as stem
            prefix, inline_opts = extract_inline_options(line)
            if inline_opts:
                if prefix:
                    if current_option_label and current_option_label in option_parts:
                        option_parts[current_option_label].append(prefix)
                    else:
                        stem_parts.append(prefix)

                for label, text_part in inline_opts.items():
                    current_option_label = label
                    option_parts.setdefault(label, [])
                    if text_part:
                        option_parts[label].append(text_part)
                continue

            m_opt = OPTION_RE.match(line)
            if m_opt:
                label = m_opt.group("label")
                text_part = normalize_line(m_opt.group("text"))
                current_option_label = label
                option_parts.setdefault(label, [])
                if text_part:
                    option_parts[label].append(text_part)
                continue

            # Continuation line: belongs to option if last option exists, else stem
            if current_option_label and current_option_label in option_parts:
                option_parts[current_option_label].append(line)
            else:
                stem_parts.append(line)

    finalize_current()

    # De-duplicate by (type, stem, answer) if repeated due to PDF artifacts
    seen: set[Tuple[str, str, str]] = set()
    uniq: List[Question] = []
    for q in questions:
        key = (q.type, q.stem, q.answer or "")
        if key in seen:
            continue
        seen.add(key)
        uniq.append(q)

    if skipped_unanswered:
        print(f"[extract_questions] Skipped {skipped_unanswered} entries without both stem+answer")

    return uniq


def main():
    ap = argparse.ArgumentParser(description="Extract structured questions from a PDF into JSON")
    ap.add_argument("--pdf", required=True, help="Path to the source PDF")
    ap.add_argument("--out", required=True, help="Output JSON path")
    args = ap.parse_args()

    pdf_path = Path(args.pdf)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    questions = parse_pdf(pdf_path)

    payload = {
        "meta": {
            "source": str(pdf_path.name),
            "count": len(questions),
        },
        "questions": [asdict(q) for q in questions],
    }

    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {len(questions)} questions to {out_path}")


if __name__ == "__main__":
    main()
