from __future__ import annotations

import csv
import io
import json
import re
import uuid
import zipfile
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pdfplumber
import pymupdf
from bs4 import BeautifulSoup
from docx import Document as DocxDocument
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph
from pypdf import PdfReader

CODE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx", ".css", ".sql", ".yaml", ".yml", ".toml"}
SUPPORTED_EXTENSIONS = {
    ".pdf", ".docx", ".md", ".markdown", ".txt", ".csv",
    ".json", ".html", ".htm", ".pptx", ".xlsx",
} | CODE_EXTENSIONS

ZIP_BASED_EXTENSIONS = {".docx", ".pptx", ".xlsx"}
DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES = 200 * 1024 * 1024


@dataclass
class StructuredBlock:
    page_number: int
    section_header: str
    text: str
    is_table: bool = False


def sanitize_filename(raw_name: str) -> str:
    """Normalize uploaded filename to a safe basename without control characters or traversal."""
    base = Path(raw_name or "untitled.txt").name
    cleaned = re.sub(r"[\x00-\x1f\x7f<>:\"/\\|?*]+", "_", base).strip(" .")
    return cleaned or "untitled.txt"


def _validate_zip_archive(
    file_path: Path, max_uncompressed_bytes: int = DEFAULT_MAX_ARCHIVE_UNCOMPRESSED_BYTES
) -> None:
    """Guard against zip-bomb payloads in Office OpenXML archives (.docx, .pptx, .xlsx)."""
    if not zipfile.is_zipfile(file_path):
        raise ValueError(f"Invalid or corrupted archive file '{file_path.name}'.")
    total_size = 0
    with zipfile.ZipFile(file_path, "r") as zf:
        for info in zf.infolist():
            total_size += max(0, info.file_size)
            if total_size > max_uncompressed_bytes:
                raise ValueError(
                    f"Archive '{file_path.name}' exceeds maximum uncompressed safety limit ({max_uncompressed_bytes // (1024 * 1024)} MB)."
                )


def _detect_encoding(file_path: Path) -> str:
    """Try charset-normalizer first; fall back through common Windows encodings."""
    try:
        from charset_normalizer import from_path

        result = from_path(str(file_path)).best()
        if result is not None:
            enc = str(result.encoding)
            return enc if enc != "ascii" else "utf-8"
    except Exception:
        pass
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            file_path.read_text(encoding=enc)
            return enc
        except (UnicodeDecodeError, LookupError):
            pass
    return "latin-1"


def _read_text_file(file_path: Path) -> str:
    """Read a text file with auto encoding detection; strip BOM."""
    enc = _detect_encoding(file_path)
    text = file_path.read_text(encoding=enc, errors="replace")
    return text.lstrip("\ufeff")


def _table_to_markdown(rows: Sequence[Sequence[str | None]]) -> str:
    cleaned = [
        [re.sub(r"\s+", " ", (cell or "")).strip().replace("|", "\\|") for cell in row]
        for row in rows
        if any((cell or "").strip() for cell in row)
    ]
    if not cleaned:
        return ""
    col_count = max(len(r) for r in cleaned)
    normalized = [r + [""] * (col_count - len(r)) for r in cleaned]
    header = "| " + " | ".join(normalized[0]) + " |"
    sep = "| " + " | ".join("---" for _ in range(col_count)) + " |"
    body = ["| " + " | ".join(r) + " |" for r in normalized[1:]]
    return "\n".join([header, sep] + body)


def _try_ocr_pil_image(pil_img: Any) -> str:
    """Optional OCR fallback for scanned PDF pages when rapidocr or pytesseract is installed."""
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore

        ocr = RapidOCR()
        result, _ = ocr(pil_img)
        if result:
            return "\n".join(item[1] for item in result if len(item) >= 2).strip()
    except Exception:
        pass
    try:
        import pytesseract  # type: ignore

        return (pytesseract.image_to_string(pil_img) or "").strip()
    except Exception:
        pass
    return ""


def _try_ocr_pymupdf_page(page: pymupdf.Page) -> str:
    try:
        import io as _io

        from PIL import Image

        pix = page.get_pixmap(dpi=180)
        pil_img = Image.open(_io.BytesIO(pix.tobytes("png")))
        return _try_ocr_pil_image(pil_img)
    except Exception:
        return ""


def _try_ocr_page(page: Any) -> str:
    try:
        pil_img = page.to_image(resolution=180).original
        return _try_ocr_pil_image(pil_img)
    except Exception:
        return ""


def _is_heading_line(line: str) -> bool:
    return (
        3 <= len(line) <= 85
        and not line.endswith((".", ",", ";"))
        and bool(line.isupper() or re.match(r"^(\d+(\.\d+)*\s+|[A-Z][A-Za-z0-9\s\-:]+)$", line))
    )


def _extract_pdf_pymupdf(file_path: Path) -> list[StructuredBlock]:
    blocks: list[StructuredBlock] = []
    current_heading = "Document Overview"
    with pymupdf.open(str(file_path)) as doc:
        if doc.is_encrypted:
            raise ValueError("PDF is password-protected/encrypted.")
        if doc.page_count == 0:
            raise ValueError("PDF contains zero readable pages.")
        for idx in range(doc.page_count):
            page_idx = idx + 1
            page = doc.load_page(idx)
            try:
                finder = page.find_tables()
                if finder is not None:
                    for tbl in finder.tables:
                        rows = [[("" if c is None else str(c)) for c in row] for row in tbl.extract()]
                        md_table = _table_to_markdown(rows)
                        if md_table:
                            blocks.append(
                                StructuredBlock(
                                    page_number=page_idx,
                                    section_header=current_heading,
                                    text=md_table,
                                    is_table=True,
                                )
                            )
            except Exception:
                pass

            raw_text = str(page.get_text("text", sort=True) or "").strip()
            if not raw_text:
                raw_text = _try_ocr_pymupdf_page(page)
            if not raw_text:
                continue

            for para in re.split(r"\n{2,}", raw_text):
                para = para.strip()
                if not para:
                    continue
                lines = [ln.strip() for ln in para.splitlines() if ln.strip()]
                if len(lines) == 1 and _is_heading_line(lines[0]):
                    current_heading = lines[0]
                blocks.append(
                    StructuredBlock(
                        page_number=page_idx,
                        section_header=current_heading,
                        text=para,
                        is_table=False,
                    )
                )
    return blocks


def _extract_pdf(file_path: Path) -> list[StructuredBlock]:
    blocks: list[StructuredBlock] = []
    primary_err: Exception | None = None

    try:
        blocks = _extract_pdf_pymupdf(file_path)
    except Exception as exc:
        primary_err = exc

    if not blocks:
        current_heading = "Document Overview"
        try:
            with pdfplumber.open(str(file_path)) as pdf:
                if not pdf.pages:
                    raise ValueError("PDF contains zero readable pages.")
                for page_idx, page in enumerate(pdf.pages, start=1):
                    tables = page.extract_tables() or []
                    for tbl in tables:
                        md_table = _table_to_markdown(tbl)
                        if md_table:
                            blocks.append(
                                StructuredBlock(
                                    page_number=page_idx,
                                    section_header=current_heading,
                                    text=md_table,
                                    is_table=True,
                                )
                            )

                    raw_text = (page.extract_text(layout=False) or "").strip()
                    if not raw_text:
                        raw_text = _try_ocr_page(page)
                    if not raw_text:
                        continue

                    for para in re.split(r"\n{2,}", raw_text):
                        para = para.strip()
                        if not para:
                            continue
                        lines = [ln.strip() for ln in para.splitlines() if ln.strip()]
                        if len(lines) == 1 and _is_heading_line(lines[0]):
                            current_heading = lines[0]
                        blocks.append(
                            StructuredBlock(
                                page_number=page_idx,
                                section_header=current_heading,
                                text=para,
                                is_table=False,
                            )
                        )
        except Exception as secondary_err:
            try:
                reader = PdfReader(str(file_path))
                if reader.is_encrypted:
                    raise ValueError("PDF is password-protected/encrypted.")
                for page_idx, page in enumerate(reader.pages, start=1):
                    txt = (page.extract_text() or "").strip()
                    if txt:
                        blocks.append(
                            StructuredBlock(
                                page_number=page_idx,
                                section_header=f"Page {page_idx}",
                                text=txt,
                            )
                        )
            except Exception as fallback_err:
                raise ValueError(
                    f"Corrupted or unreadable PDF ({primary_err or secondary_err}; fallback failed: {fallback_err})"
                ) from fallback_err

    if not blocks:
        raise ValueError("No extractable text found in PDF (it may be a scanned image without OCR).")
    return blocks


def _extract_docx(file_path: Path) -> list[StructuredBlock]:
    _validate_zip_archive(file_path)
    try:
        doc = DocxDocument(str(file_path))
    except Exception as exc:
        raise ValueError(f"Corrupted or invalid DOCX file: {exc}") from exc

    blocks: list[StructuredBlock] = []
    current_heading = "Document Overview"
    approx_page = 1
    chars_on_page = 0

    for child in doc.element.body.iterchildren():
        if isinstance(child, CT_P):
            para = Paragraph(child, doc)
            text = para.text.strip()
            if not text:
                continue
            style_name = (para.style.name or "").lower() if para.style else ""
            if "heading" in style_name or style_name == "title":
                current_heading = text
            blocks.append(
                StructuredBlock(
                    page_number=approx_page,
                    section_header=current_heading,
                    text=text,
                )
            )
            chars_on_page += len(text)
        elif isinstance(child, CT_Tbl):
            tbl = Table(child, doc)
            rows = [[cell.text.strip() for cell in row.cells] for row in tbl.rows]
            md_table = _table_to_markdown(rows)
            if md_table:
                blocks.append(
                    StructuredBlock(
                        page_number=approx_page,
                        section_header=current_heading,
                        text=md_table,
                        is_table=True,
                    )
                )
                chars_on_page += len(md_table)

        if chars_on_page >= 2800:
            approx_page += 1
            chars_on_page = 0

    if not blocks:
        raise ValueError("DOCX file contains no readable text or tables.")
    return blocks


def _extract_markdown(file_path: Path) -> list[StructuredBlock]:
    text = _read_text_file(file_path)
    blocks: list[StructuredBlock] = []
    current_heading = "Introduction"
    buffer: list[str] = []

    def flush() -> None:
        joined = "\n".join(buffer).strip()
        if joined:
            is_tbl = joined.startswith("|") and "| ---" in joined
            blocks.append(
                StructuredBlock(
                    page_number=1,
                    section_header=current_heading,
                    text=joined,
                    is_table=is_tbl,
                )
            )
        buffer.clear()

    for line in text.splitlines():
        heading_match = re.match(r"^(#{1,6})\s+(.*)$", line.strip())
        if heading_match:
            flush()
            current_heading = heading_match.group(2).strip()
            buffer.append(line)
        elif line.strip() == "":
            flush()
        else:
            buffer.append(line)
    flush()

    if not blocks:
        raise ValueError("Markdown file is empty.")
    return blocks


def _extract_csv(file_path: Path) -> list[StructuredBlock]:
    raw = _read_text_file(file_path)
    reader = list(csv.reader(io.StringIO(raw)))
    if not reader:
        raise ValueError("CSV file is empty.")
    header = reader[0]
    rows = reader[1:]
    blocks: list[StructuredBlock] = []
    batch_size = 20
    for idx in range(0, max(1, len(rows)), batch_size):
        chunk_rows = [header] + rows[idx : idx + batch_size]
        md_tbl = _table_to_markdown(chunk_rows)
        if md_tbl:
            blocks.append(
                StructuredBlock(
                    page_number=(idx // batch_size) + 1,
                    section_header=f"Rows {idx + 1}–{min(idx + batch_size, len(rows))}",
                    text=md_tbl,
                    is_table=True,
                )
            )
    return blocks


def _extract_xlsx(file_path: Path) -> list[StructuredBlock]:
    _validate_zip_archive(file_path)
    import openpyxl

    wb = openpyxl.load_workbook(str(file_path), read_only=True, data_only=True)
    blocks: list[StructuredBlock] = []
    try:
        for sheet_idx, sheet_name in enumerate(wb.sheetnames, start=1):
            ws = wb[sheet_name]
            rows = [
                ["" if v is None else str(v) for v in row]
                for row in ws.iter_rows(values_only=True)
            ]
            rows = [r for r in rows if any(c.strip() for c in r)]
            if not rows:
                continue
            header = rows[0]
            body = rows[1:]
            batch_size = 25
            for idx in range(0, max(1, len(body)), batch_size):
                chunk_rows = [header] + body[idx : idx + batch_size]
                md_tbl = _table_to_markdown(chunk_rows)
                if md_tbl:
                    blocks.append(
                        StructuredBlock(
                            page_number=sheet_idx,
                            section_header=f"Sheet: {sheet_name}",
                            text=md_tbl,
                            is_table=True,
                        )
                    )
    finally:
        wb.close()
    if not blocks:
        raise ValueError("Excel workbook contains no readable rows.")
    return blocks


def _extract_pptx(file_path: Path) -> list[StructuredBlock]:
    _validate_zip_archive(file_path)
    from pptx import Presentation

    prs = Presentation(str(file_path))
    blocks: list[StructuredBlock] = []
    for slide_idx, slide in enumerate(prs.slides, start=1):
        title = f"Slide {slide_idx}"
        if slide.shapes.title and slide.shapes.title.text.strip():
            title = slide.shapes.title.text.strip()
        texts: list[str] = []
        shape: Any
        for shape in slide.shapes:
            if shape.has_text_frame:
                txt = "\n".join(p.text.strip() for p in shape.text_frame.paragraphs if p.text.strip())
                if txt and txt != title:
                    texts.append(txt)
            if shape.has_table:
                tbl_rows = [[cell.text.strip() for cell in row.cells] for row in shape.table.rows]
                md_tbl = _table_to_markdown(tbl_rows)
                if md_tbl:
                    blocks.append(
                        StructuredBlock(page_number=slide_idx, section_header=title, text=md_tbl, is_table=True)
                    )
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                texts.append(f"Speaker Notes: {notes}")
        joined = "\n\n".join(texts).strip()
        if joined:
            blocks.append(StructuredBlock(page_number=slide_idx, section_header=title, text=joined))
    if not blocks:
        raise ValueError("PowerPoint file contains no readable slide text.")
    return blocks


def _extract_html(file_path: Path) -> list[StructuredBlock]:
    raw = _read_text_file(file_path)
    soup = BeautifulSoup(raw, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "nav", "footer"]):
        tag.decompose()
    title = soup.title.string.strip() if soup.title and soup.title.string else "Web Document"
    blocks: list[StructuredBlock] = []
    current_heading = title
    for el in soup.find_all(["h1", "h2", "h3", "h4", "p", "li", "pre", "table"]):
        if el.name in {"h1", "h2", "h3", "h4"}:
            heading_txt = el.get_text(" ", strip=True)
            if heading_txt:
                current_heading = heading_txt
        elif el.name == "table":
            rows = [
                [cell.get_text(" ", strip=True) for cell in tr.find_all(["th", "td"])]
                for tr in el.find_all("tr")
            ]
            md_tbl = _table_to_markdown(rows)
            if md_tbl:
                blocks.append(StructuredBlock(page_number=1, section_header=current_heading, text=md_tbl, is_table=True))
        else:
            txt = el.get_text(" ", strip=True)
            if txt and len(txt) > 1:
                blocks.append(StructuredBlock(page_number=1, section_header=current_heading, text=txt))
    if not blocks:
        plain = soup.get_text("\n", strip=True)
        if not plain:
            raise ValueError("HTML file contains no readable content.")
        blocks.append(StructuredBlock(page_number=1, section_header=title, text=plain))
    return blocks


def _extract_json(file_path: Path) -> list[StructuredBlock]:
    raw = _read_text_file(file_path).strip()
    if not raw:
        raise ValueError("JSON file is empty.")
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return [StructuredBlock(page_number=1, section_header="JSON Content", text=raw)]
    blocks: list[StructuredBlock] = []
    if isinstance(data, dict):
        for k, v in data.items():
            pretty = json.dumps(v, indent=2, ensure_ascii=False)
            blocks.append(StructuredBlock(page_number=1, section_header=str(k), text=f"{k}:\n{pretty}"))
    elif isinstance(data, list):
        batch_size = 10
        for idx in range(0, len(data), batch_size):
            slice_items = data[idx : idx + batch_size]
            pretty = json.dumps(slice_items, indent=2, ensure_ascii=False)
            blocks.append(
                StructuredBlock(
                    page_number=(idx // batch_size) + 1,
                    section_header=f"Items {idx + 1}–{idx + len(slice_items)}",
                    text=pretty,
                )
            )
    else:
        blocks.append(StructuredBlock(page_number=1, section_header="JSON Value", text=str(data)))
    return blocks or [StructuredBlock(page_number=1, section_header="JSON Content", text=raw)]


def _extract_code(file_path: Path) -> list[StructuredBlock]:
    raw = _read_text_file(file_path).strip()
    if not raw:
        raise ValueError("Code file is empty.")
    lines = raw.splitlines()
    blocks: list[StructuredBlock] = []
    current_header = file_path.name
    buf: list[str] = []
    sym_re = re.compile(
        r"^\s*(?:async\s+def|def|class|export\s+(?:async\s+)?function|export\s+class|function|CREATE\s+TABLE)\s+([A-Za-z0-9_]+)"
    )

    def flush() -> None:
        txt = "\n".join(buf).strip()
        if txt:
            blocks.append(StructuredBlock(page_number=1, section_header=current_header, text=txt))
        buf.clear()

    for line in lines:
        m = sym_re.match(line)
        if m:
            if buf:
                flush()
            current_header = m.group(1)
        buf.append(line)
    flush()
    return blocks


def _extract_txt(file_path: Path) -> list[StructuredBlock]:
    raw = _read_text_file(file_path).strip()
    if not raw:
        raise ValueError("Text file is empty.")
    blocks: list[StructuredBlock] = []
    approx_page = 1
    chars = 0
    for para in re.split(r"\n{2,}", raw):
        para = para.strip()
        if not para:
            continue
        blocks.append(StructuredBlock(page_number=approx_page, section_header="Text Body", text=para))
        chars += len(para)
        if chars >= 2800:
            approx_page += 1
            chars = 0
    return blocks


def _estimate_tokens(text: str) -> int:
    """Fast token-count approximation calibrated for BGE/WordPiece (avoids exceeding 512-token windows)."""
    return max(1, len(re.findall(r"\w+|[^\w\s]", text)))


def _split_text_with_overlap(
    text: str,
    max_chars: int,
    overlap: int,
    max_tokens: int = 440,
) -> list[str]:
    if len(text) <= max_chars and _estimate_tokens(text) <= max_tokens:
        return [text]
    chunks: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + max_chars)
        # Shrink window if dense code/punctuation exceeds token budget
        while end > start + 40 and _estimate_tokens(text[start:end]) > max_tokens:
            end = start + int((end - start) * 0.8)
        if end < len(text):
            split_at = max(text.rfind("\n", start, end), text.rfind(". ", start, end))
            if split_at > start + int((end - start) * 0.5):
                end = split_at + 1
        segment = text[start:end].strip()
        if segment:
            chunks.append(segment)
        if end >= len(text):
            break
        start = max(end - overlap, start + 1)
    return chunks


def parse_and_chunk_document(
    file_path: Path,
    doc_id: str,
    filename: str,
    parent_size: int,
    child_size: int,
    child_overlap: int,
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    ext = file_path.suffix.lower()
    if ext not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"Unsupported file type '{ext}'. Supported: {sorted(SUPPORTED_EXTENSIONS)}")

    if ext == ".pdf":
        blocks = _extract_pdf(file_path)
    elif ext == ".docx":
        blocks = _extract_docx(file_path)
    elif ext in {".md", ".markdown"}:
        blocks = _extract_markdown(file_path)
    elif ext == ".csv":
        blocks = _extract_csv(file_path)
    elif ext == ".xlsx":
        blocks = _extract_xlsx(file_path)
    elif ext == ".pptx":
        blocks = _extract_pptx(file_path)
    elif ext in {".html", ".htm"}:
        blocks = _extract_html(file_path)
    elif ext == ".json":
        blocks = _extract_json(file_path)
    elif ext in CODE_EXTENSIONS:
        blocks = _extract_code(file_path)
    else:
        blocks = _extract_txt(file_path)

    now = datetime.now(UTC).isoformat()
    parents: list[dict[str, object]] = []
    children: list[dict[str, object]] = []

    buf_texts: list[str] = []
    buf_page = blocks[0].page_number
    buf_section = blocks[0].section_header

    def commit_parent() -> None:
        if not buf_texts:
            return
        combined = "\n\n".join(buf_texts).strip()
        if not combined:
            buf_texts.clear()
            return
        for part in _split_text_with_overlap(combined, parent_size, overlap=120, max_tokens=1800):
            p_id = str(uuid.uuid4())
            parents.append(
                {
                    "parent_id": p_id,
                    "doc_id": doc_id,
                    "filename": filename,
                    "page_number": buf_page,
                    "section_header": buf_section,
                    "text": part,
                    "created_at": now,
                }
            )
            for child_text in _split_text_with_overlap(part, child_size, child_overlap, max_tokens=440):
                children.append(
                    {
                        "child_id": str(uuid.uuid4()),
                        "parent_id": p_id,
                        "doc_id": doc_id,
                        "filename": filename,
                        "page_number": buf_page,
                        "section_header": buf_section,
                        "text": child_text,
                        "embed_text": f"[Document: {filename} | Section: {buf_section}]\n{child_text}",
                    }
                )
        buf_texts.clear()

    for blk in blocks:
        current_len = sum(len(t) for t in buf_texts)
        section_changed = blk.section_header != buf_section and current_len > parent_size * 0.4
        would_overflow = current_len + len(blk.text) > parent_size
        if buf_texts and (section_changed or would_overflow or blk.is_table):
            commit_parent()
            buf_page = blk.page_number
            buf_section = blk.section_header
        if not buf_texts:
            buf_page = blk.page_number
            buf_section = blk.section_header
        buf_texts.append(blk.text)
        if blk.is_table:
            commit_parent()

    commit_parent()
    return parents, children
