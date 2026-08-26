#!/usr/bin/env python3
"""Extract organization names from a Word document into a JSON array.

Usage:
    python scripts/data-pipeline/extract_organizations.py input.docx
    python scripts/data-pipeline/extract_organizations.py input.docx --output data/raw_organizations.json

The script reads .docx files with python-docx.  For legacy binary .doc files it
uses LibreOffice (soffice) to make a temporary .docx conversion first.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tempfile
from collections.abc import Iterable
from pathlib import Path

try:
    from docx import Document
except ImportError as error:
    raise SystemExit(
        "Missing dependency: install python-docx with 'python -m pip install python-docx'."
    ) from error


# Chinese organization names normally end with one of these terms.  The longer
# suffixes must appear first so, for example, "委员会" is not reduced to "会".
CHINESE_ORGANIZATION_SUFFIXES = (
    "有限责任公司",
    "股份有限公司",
    "集团有限公司",
    "科技有限公司",
    "委员会",
    "研究院",
    "研究所",
    "实验室",
    "大学",
    "学院",
    "医院",
    "中心",
    "基金会",
    "协会",
    "学会",
    "联盟",
    "组织",
    "平台",
    "园区",
    "公司",
    "集团",
    "银行",
    "政府",
    "部门",
    "部",
    "厅",
    "局",
    "院",
    "署",
    "办",
)

ENGLISH_ORGANIZATION_SUFFIXES = (
    "University",
    "College",
    "Institute",
    "Laboratory",
    "Lab",
    "Centre",
    "Center",
    "Foundation",
    "Association",
    "Society",
    "Alliance",
    "Corporation",
    "Company",
    "Group",
    "Holdings",
    "Government",
    "Ministry",
    "Department",
    "Commission",
    "Agency",
    "Council",
    "Inc.",
    "Ltd.",
    "LLC",
    "PLC",
)

NAME_HEADER_RE = re.compile(
    r"(?:机构|单位|企业|公司|学校|高校|大学|院校|科研机构|实验室|医院|协会|学会|联盟|平台)"
    r"(?:名称|名单|名录|全称)?",
    re.IGNORECASE,
)

CHINESE_NAME_RE = re.compile(
    r"[\u4e00-\u9fffA-Za-z0-9& .()（）\-]{2,60}"
    + "(?:"
    + "|".join(map(re.escape, CHINESE_ORGANIZATION_SUFFIXES))
    + r")"
)
ENGLISH_NAME_RE = re.compile(
    r"\b([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,8}\s+(?:"
    + "|".join(map(re.escape, ENGLISH_ORGANIZATION_SUFFIXES))
    + r"))(?=$|[^\w])"
)

# Chinese organisation names very rarely include these separators.  Splitting
# on them prevents an entire sentence ending in "公司" or "中心" from becoming
# one false candidate.
SEPARATOR_RE = re.compile(r"[\n\r\t,，;；、|。！？:：()（）\[\]【】]+")
LEADING_LABEL_RE = re.compile(
    r"^\s*(?:机构|单位|企业|公司|学校|高校|大学|院校|科研机构|实验室|医院|协会|学会|联盟|平台)"
    r"(?:名称|名单|名录|全称)?\s*[：:]\s*",
    re.IGNORECASE,
)
LEADING_NUMBER_RE = re.compile(r"^\s*(?:[（(]?\d+[）).、]|[一二三四五六七八九十]+[、.])\s*")

# Phrases that commonly precede a name in prose, but are not part of it.
CONTEXT_PREFIX_RE = re.compile(
    r"^(?:由|与|和|及|以及|包括|例如|如|在|向|联合|依托|支持|来自|面向|位于|通过|针对|"
    r"其中|本项目|该项目|合作方|合作单位|代表企业|代表机构|主要有|主要包括|名单包括|"
    r"partners?\s+(?:with|include)\s+)",
    re.IGNORECASE,
)

GENERIC_NAME_RE = re.compile(
    r"^(?:\d|[一二三四五六七八九十]+(?:个|家|所|项|部)|(?:一个|一些|多个|许多|很多|几家|数家|"
    r"各类|各级|不同|相关|主要|部分|所有|整个|该|本|这|其))"
)
GENERIC_NAMES = {
    "大学", "学院", "研究院", "研究所", "实验室", "中心", "基金会", "协会", "学会", "联盟",
    "组织", "平台", "园区", "公司", "集团", "银行", "政府", "部门", "部", "厅", "局", "院", "署", "办",
}

# These signals are used only after the regular-expression match.  They catch
# prose such as "清华大学负责..." while allowing a complete table-cell value.
SENTENCE_FRAGMENT_RE = re.compile(
    r"(?:是一|是由|的是|的特点|的典范|的模式|的作用|的核心|的主要|的[一二三四五六七八九十]"
    r"|的(?:大多数|少数|员工|开放|传统|典型|国际|本地)"
    r"|成立|设立|负责|推动|支持|依托|位于|拥有|包括|提供|开展|通过|成为|作为|建立|联合"
    r"|合作|运营|实施|下设|正式|源自|需要|可以|能够|应该|如何|已经|正在|形成|围绕|量身|"
    r"(?:是|由|等|则|将|会|已|需|应|被|从|向).{1,})"
)


def normalize_text(value: str) -> str:
    """Remove control characters and make whitespace/punctuation consistent."""
    value = value.replace("\u00a0", " ").replace("\u3000", " ")
    value = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    value = re.sub(r"\s+", " ", value)
    return value.strip()


def normalize_name(value: str) -> str:
    """Return a display-safe name without list markers or surrounding symbols."""
    value = normalize_text(value)
    value = LEADING_LABEL_RE.sub("", value)
    value = LEADING_NUMBER_RE.sub("", value)
    value = CONTEXT_PREFIX_RE.sub("", value)
    value = value.strip(" \t,，;；:：.。·-—–_()（）[]【】{}'\"“”‘’")
    value = re.sub(r"\s+", " ", value)
    return value


def name_key(value: str) -> str:
    """Create a comparison key while preserving the first spelling for output."""
    return re.sub(r"[\s\-—–_()（）\[\]【】{}'\"“”‘’.,，;；:：]", "", value).casefold()


def is_plausible_name(value: str) -> bool:
    if not 2 <= len(value) <= 100:
        return False
    if re.fullmatch(r"[\W_]+", value):
        return False
    if value in GENERIC_NAMES or GENERIC_NAME_RE.search(value):
        return False
    if re.search(r"(?:本研究|本报告|本项目|数据来源|表\s*\d|图\s*\d)", value):
        return False
    return bool(CHINESE_NAME_RE.fullmatch(value) or ENGLISH_NAME_RE.fullmatch(value))


def split_values(value: str) -> list[str]:
    """Split list-like cell text, retaining punctuation that can be in a name."""
    return [normalize_name(part) for part in SEPARATOR_RE.split(value) if normalize_name(part)]


def names_from_text(value: str) -> list[str]:
    """Find Chinese and English organization-like spans in arbitrary document text."""
    candidates: list[str] = []

    for part in split_values(value):
        # A complete list/table cell is the most reliable candidate.
        if is_plausible_name(part) and not SENTENCE_FRAGMENT_RE.search(part):
            candidates.append(part)

        # Capitalised English names remain recognisable inside prose without
        # accepting the surrounding Chinese sentence as part of the candidate.
        for match in ENGLISH_NAME_RE.finditer(part):
            candidate = normalize_name(match.group(1))
            if is_plausible_name(candidate):
                candidates.append(candidate)

    return candidates


def iter_document_text(document: Document) -> Iterable[str]:
    """Yield all paragraph and table-cell text, including text in nested tables."""
    for paragraph in document.paragraphs:
        if paragraph.text:
            yield paragraph.text

    seen_cells: set[int] = set()
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                # Merged cells are repeated by python-docx.  Use the XML object
                # identity to avoid processing the same cell multiple times.
                cell_id = id(cell._tc)
                if cell_id in seen_cells:
                    continue
                seen_cells.add(cell_id)
                if cell.text:
                    yield cell.text
                for nested_table in cell.tables:
                    for nested_row in nested_table.rows:
                        for nested_cell in nested_row.cells:
                            if nested_cell.text:
                                yield nested_cell.text


def names_from_tables(document: Document) -> list[str]:
    """Extract complete values from columns whose header identifies an organization."""
    candidates: list[str] = []

    for table in document.tables:
        if not table.rows:
            continue
        header_cells = [normalize_text(cell.text) for cell in table.rows[0].cells]
        name_columns = [index for index, header in enumerate(header_cells) if NAME_HEADER_RE.search(header)]
        if not name_columns:
            continue

        for row in table.rows[1:]:
            for column in name_columns:
                if column >= len(row.cells):
                    continue
                for value in split_values(row.cells[column].text):
                    if is_plausible_name(value) and not SENTENCE_FRAGMENT_RE.search(value):
                        candidates.append(value)
                    else:
                        candidates.extend(names_from_text(value))

    return candidates


def convert_doc_to_docx(source: Path, temporary_dir: Path) -> Path:
    """Convert an old binary .doc file with LibreOffice, if it is installed."""
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        raise RuntimeError(
            "Cannot read .doc directly. Install LibreOffice so 'soffice' is on PATH, "
            "or save the document as .docx and run the script again."
        )

    command = [
        soffice,
        "--headless",
        "--convert-to",
        "docx",
        "--outdir",
        str(temporary_dir),
        str(source),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    converted = temporary_dir / f"{source.stem}.docx"
    if completed.returncode != 0 or not converted.exists():
        details = (completed.stderr or completed.stdout).strip()
        raise RuntimeError(f"LibreOffice could not convert '{source}': {details}")
    return converted


def read_document(source: Path) -> Document:
    suffix = source.suffix.casefold()
    if suffix == ".docx":
        return Document(source)
    if suffix != ".doc":
        raise ValueError("Input must be a .docx or .doc file.")

    with tempfile.TemporaryDirectory(prefix="organization-extract-") as directory:
        converted = convert_doc_to_docx(source, Path(directory))
        # Document loads all content before the temporary conversion is deleted.
        return Document(converted)


def extract_organizations(source: Path) -> list[str]:
    document = read_document(source)
    candidates = names_from_tables(document)
    for text in iter_document_text(document):
        candidates.extend(names_from_text(text))

    unique: dict[str, str] = {}
    for candidate in candidates:
        cleaned = normalize_name(candidate)
        key = name_key(cleaned)
        if key and is_plausible_name(cleaned) and key not in unique:
            unique[key] = cleaned

    return sorted(unique.values(), key=lambda name: (name.casefold(), name))


def parse_arguments() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(
        description="Extract unique organization names from a .docx or .doc file."
    )
    parser.add_argument("source", type=Path, help="Path to the Word document (.docx or .doc)")
    parser.add_argument(
        "--output",
        type=Path,
        default=project_root / "data" / "raw_organizations.json",
        help="Destination JSON file (default: data/raw_organizations.json)",
    )
    return parser.parse_args()


def main() -> None:
    arguments = parse_arguments()
    source = arguments.source.expanduser().resolve()
    output = arguments.output.expanduser().resolve()
    if not source.is_file():
        raise SystemExit(f"Input file not found: {source}")

    try:
        organizations = extract_organizations(source)
    except (RuntimeError, ValueError, OSError) as error:
        raise SystemExit(f"Extraction failed: {error}") from error

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(organizations, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Extracted {len(organizations)} unique organization names.")
    print(f"Wrote: {output}")


if __name__ == "__main__":
    main()
