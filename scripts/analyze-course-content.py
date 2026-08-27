from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import subprocess
import tempfile
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image
from pypdf import PdfReader


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKD", value or "")
    value = "".join(character for character in value if not unicodedata.combining(character))
    value = value.lower()
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def text_fingerprint(value: str) -> tuple[str | None, int]:
    normalized = normalize_text(value)[:2_000_000]
    if len(normalized) < 80:
        return None, len(normalized)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest(), len(normalized)


def pdf_details(path: Path) -> tuple[int, str | None, int, list[list[dict]]]:
    reader = PdfReader(str(path), strict=False)
    text = []
    widgets: list[list[dict]] = []
    for page in reader.pages:
        try:
            text.append(page.extract_text() or "")
        except Exception:
            text.append("")
        page_widgets = []
        width = float(page.mediabox.width)
        height = float(page.mediabox.height)
        for reference in page.get("/Annots", []) or []:
            try:
                annotation = reference.get_object()
                parent = annotation.get("/Parent")
                parent = parent.get_object() if parent else {}
                field_type = annotation.get("/FT") or parent.get("/FT")
                if str(annotation.get("/Subtype")) != "/Widget" or str(field_type) != "/Tx":
                    continue
                x0, y0, x1, y1 = map(float, annotation["/Rect"])
                left, right = sorted((x0, x1))
                bottom, top = sorted((y0, y1))
                page_widgets.append({
                    "x": round(left / width, 5),
                    "y": round((height - top) / height, 5),
                    "w": round((right - left) / width, 5),
                    "h": round((top - bottom) / height, 5),
                    "kind": "widget",
                })
            except Exception:
                continue
        widgets.append(page_widgets)
    fingerprint, characters = text_fingerprint(" ".join(text))
    return len(reader.pages), fingerprint, characters, widgets


def presentation_details(path: Path) -> tuple[str | None, int]:
    text = []
    with zipfile.ZipFile(path) as archive:
        names = [name for name in archive.namelist() if re.fullmatch(r"ppt/slides/slide\d+\.xml", name, re.I)]
        names.sort(key=lambda name: int(re.search(r"\d+", name).group()))
        for name in names:
            xml = archive.read(name).decode("utf-8", "ignore")
            xml = re.sub(r"<[^>]+>", " ", xml)
            text.append(html.unescape(xml))
    return text_fingerprint(" ".join(text))


def lesson_number(lesson: dict) -> int | None:
    for value in (lesson.get("legacyNumber"), lesson.get("originalName"), lesson.get("title")):
        match = re.search(r"(?:^|lecci[oó]n\s*)(\d{1,3})(?:\D|$)", str(value or ""), re.I)
        if match:
            return int(match.group(1))
    return None


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "CursosBiblicosContentAudit/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def download(url: str, destination: Path) -> Path:
    if destination.exists() and destination.stat().st_size > 0:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": "CursosBiblicosContentAudit/1.0"})
    temporary = destination.with_suffix(destination.suffix + ".downloading")
    with urllib.request.urlopen(request, timeout=180) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    temporary.replace(destination)
    return destination


def safe_name(value: str) -> str:
    value = normalize_text(value).replace(" ", "-")
    return value[:80] or "archivo"


def local_course_folders(source_root: Path) -> dict[int, Path]:
    result = {}
    for folder in source_root.iterdir():
        if not folder.is_dir() or "(anterior)" in folder.name.lower():
            continue
        match = re.match(r"(\d{2})\s", folder.name)
        if match:
            result[int(match.group(1))] = folder
    return result


def resolve_lesson_path(course: dict, lesson: dict, source_root: Path, cache: Path) -> Path:
    course_id = str(course["id"])
    if course_id.isdigit() and 1 <= int(course_id) <= 12:
        number = lesson_number(lesson)
        folder = local_course_folders(source_root).get(int(course_id))
        candidate = folder / f"Lección {number:02d}.pdf" if folder and number is not None else None
        if candidate and candidate.exists():
            return candidate
    extension = lesson.get("type", "bin")
    name = f"{safe_name(course['name'])}-{safe_name(lesson['title'])}-{hashlib.sha1(lesson['url'].encode()).hexdigest()[:10]}.{extension}"
    return download(lesson["url"], cache / "downloads" / name)


def row_segments(mask: np.ndarray, max_gap: int = 4):
    indices = np.flatnonzero(mask)
    if not len(indices):
        return []
    segments = []
    start = previous = int(indices[0])
    count = 1
    for value in map(int, indices[1:]):
        if value - previous <= max_gap + 1:
            count += 1
            previous = value
            continue
        segments.append((start, previous, count))
        start = previous = value
        count = 1
    segments.append((start, previous, count))
    return segments


def merge_fields(fields: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for field in sorted(fields, key=lambda item: (item["y"], item["x"])):
        duplicate = False
        for current in merged:
            x_overlap = max(0, min(current["x"] + current["w"], field["x"] + field["w"]) - max(current["x"], field["x"]))
            y_overlap = max(0, min(current["y"] + current["h"], field["y"] + field["h"]) - max(current["y"], field["y"]))
            if x_overlap * y_overlap > min(current["w"] * current["h"], field["w"] * field["h"]) * 0.55:
                duplicate = True
                break
        if not duplicate:
            merged.append(field)
    grouped: list[dict] = []
    for field in merged:
        previous = grouped[-1] if grouped else None
        gap = field["x"] - (previous["x"] + previous["w"]) if previous else 1
        same_row = previous and abs(field["y"] - previous["y"]) <= max(0.004, min(field["h"], previous["h"]) * 0.25)
        small_widgets = previous and previous.get("_smallWidgetRun") and field.get("kind") == "widget" and field["w"] <= 0.08
        if small_widgets and same_row and -0.002 <= gap <= 0.014:
            right = max(previous["x"] + previous["w"], field["x"] + field["w"])
            previous["y"] = min(previous["y"], field["y"])
            previous["h"] = max(previous["h"], field["h"])
            previous["w"] = round(right - previous["x"], 5)
        else:
            grouped.append({**field, "_smallWidgetRun": field.get("kind") == "widget" and field["w"] <= 0.08})
    for index, field in enumerate(grouped, 1):
        field.pop("_smallWidgetRun", None)
        field["id"] = f"field-{index}"
    return grouped


def detect_fields(image_path: Path, widgets: list[dict]) -> list[dict]:
    if widgets:
        return merge_fields(widgets)
    image = np.asarray(Image.open(image_path).convert("RGB"))
    height, width, _ = image.shape
    gray = image.mean(axis=2)
    spread = image.max(axis=2) - image.min(axis=2)
    dark_neutral = (gray < 220) & (spread < 34)
    candidates = []
    for y in range(max(1, int(height * 0.06)), min(height - 1, int(height * 0.92))):
        for x0, x1, dark in row_segments(dark_neutral[y]):
            span = x1 - x0 + 1
            density = dark / span
            if span < width * 0.14 or density < 0.62:
                continue
            if span > width * 0.88 and (x0 < width * 0.08 or x1 > width * 0.92):
                continue
            candidates.append({"x0": x0, "x1": x1, "y0": y, "y1": y, "density": density})

    groups = []
    for candidate in candidates:
        match = None
        for group in reversed(groups[-24:]):
            overlap = min(group["x1"], candidate["x1"]) - max(group["x0"], candidate["x0"])
            base = min(group["x1"] - group["x0"], candidate["x1"] - candidate["x0"])
            if candidate["y0"] - group["y1"] <= 3 and overlap >= base * 0.72:
                match = group
                break
        if match:
            match["x0"] = min(match["x0"], candidate["x0"])
            match["x1"] = max(match["x1"], candidate["x1"])
            match["y1"] = candidate["y1"]
        else:
            groups.append(candidate)

    fields = []
    for group in groups:
        span = group["x1"] - group["x0"] + 1
        thickness = group["y1"] - group["y0"] + 1
        if thickness > max(4, height * 0.004):
            continue
        top = max(0, group["y0"] - round(height * 0.03))
        bottom = max(top, group["y0"] - round(height * 0.006))
        ink_above = float((gray[top:bottom:2, group["x0"]:group["x1"] + 1:2] < 185).mean()) if bottom > top else 0
        if ink_above > 0.085:
            continue
        field_height = max(0.032, min(0.055, (group["y0"] - top) / height))
        fields.append({
            "x": round(group["x0"] / width, 5),
            "y": round(max(0, group["y0"] / height - field_height), 5),
            "w": round(span / width, 5),
            "h": round(field_height, 5),
            "kind": "line",
        })

    neutral = (spread <= 12) & (gray >= 190) & (gray <= 240)
    rectangle_rows = []
    for y in range(max(1, int(height * 0.06)), min(height - 1, int(height * 0.88))):
        for x0, x1, filled in row_segments(neutral[y], max_gap=1):
            span = x1 - x0 + 1
            if span < width * 0.06 or span > width * 0.65 or filled / span < 0.95:
                continue
            if x0 < width * 0.07 or x1 > width * 0.96:
                continue
            rectangle_rows.append({"x0": x0, "x1": x1, "y0": y, "y1": y})

    rectangles = []
    for row in rectangle_rows:
        match = None
        for group in reversed(rectangles[-36:]):
            if row["y0"] - group["y1"] <= 2 and abs(group["x0"] - row["x0"]) <= 4 and abs(group["x1"] - row["x1"]) <= 4:
                match = group
                break
        if match:
            match["y1"] = row["y1"]
        else:
            rectangles.append(row)
    rectangles = [rectangle for rectangle in rectangles if max(7, height * 0.008) <= rectangle["y1"] - rectangle["y0"] + 1 <= height * 0.09]
    if len(rectangles) >= 2:
        for rectangle in rectangles:
            fields.append({
                "x": round(rectangle["x0"] / width, 5),
                "y": round(rectangle["y0"] / height, 5),
                "w": round((rectangle["x1"] - rectangle["x0"] + 1) / width, 5),
                "h": round((rectangle["y1"] - rectangle["y0"] + 1) / height, 5),
                "kind": "box",
            })
    return merge_fields([*widgets, *fields])


def render_and_detect(pdf: Path, pages: int, widgets: list[list[dict]], pdftoppm: str) -> dict[str, list[dict]]:
    result = {}
    with tempfile.TemporaryDirectory(prefix="cursos-fields-") as directory:
        prefix = str(Path(directory) / "page")
        completed = subprocess.run(
            [pdftoppm, "-r", "120", "-png", str(pdf), prefix],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=240,
        )
        if completed.returncode:
            raise RuntimeError(completed.stderr.strip() or "pdftoppm failed")
        images = sorted(Path(directory).glob("page-*.png"), key=lambda path: int(re.search(r"(\d+)$", path.stem).group()))
        if len(images) != pages:
            raise RuntimeError(f"Expected {pages} pages, rendered {len(images)}")
        for index, image in enumerate(images, 1):
            result[str(index)] = detect_fields(image, widgets[index - 1] if index <= len(widgets) else [])
    return result


def duplicate_groups(records: list[dict], field: str) -> list[list[dict]]:
    groups = defaultdict(list)
    for record in records:
        if record.get(field):
            groups[record[field]].append(record)
    return [items for items in groups.values() if len(items) > 1]


def analyze_library(source_root: Path) -> dict:
    records = []
    invalid = []
    for path in sorted(source_root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in {".pdf", ".ppt", ".pptx", ".ppsx", ".pages"}:
            continue
        relative = path.relative_to(source_root).as_posix()
        record = {"name": relative, "sha256": sha256(path), "contentHash": None}
        try:
            if path.suffix.lower() == ".pdf":
                if path.read_bytes()[:5] != b"%PDF-":
                    raise ValueError("La extensión dice PDF, pero el contenido no es PDF")
                _, record["contentHash"], _, _ = pdf_details(path)
            elif path.suffix.lower() in {".pptx", ".ppsx"}:
                record["contentHash"], _ = presentation_details(path)
            elif path.suffix.lower() == ".pages":
                with zipfile.ZipFile(path) as archive:
                    if not any(name in archive.namelist() for name in ("Index/Document.iwa", "index.xml")):
                        raise ValueError("El paquete no contiene un documento Pages")
        except Exception as error:
            invalid.append({"name": relative, "reason": str(error)[:180]})
        records.append(record)
    exact = duplicate_groups(records, "sha256")
    semantic = duplicate_groups(records, "contentHash")
    return {
        "files": len(records),
        "exactDuplicateGroups": [[item["name"] for item in group] for group in exact],
        "contentDuplicateGroups": [[item["name"] for item in group] for group in semantic],
        "invalidFiles": invalid,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze the Cursos Bíblicos catalog and answer fields.")
    parser.add_argument("--catalog-url", default="https://cursos-biblicos-web.vercel.app/api/catalog")
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--known-output", type=Path, required=True)
    parser.add_argument("--fields-output", type=Path, required=True)
    parser.add_argument("--report-output", type=Path, required=True)
    parser.add_argument("--pdftoppm", default="pdftoppm")
    parser.add_argument("--skip-fields", action="store_true")
    parser.add_argument("--reuse-fields", action="store_true", help="Reuse the existing map on pages without PDF text widgets.")
    parser.add_argument("--skip-library", action="store_true", help="Keep the previous archive report and analyze only the live catalog.")
    args = parser.parse_args()

    args.work_dir.mkdir(parents=True, exist_ok=True)
    catalog = fetch_json(args.catalog_url)
    documents = []
    fields_documents = {}
    previous_fields = {}
    if args.reuse_fields and args.fields_output.exists():
        previous_fields = json.loads(args.fields_output.read_text(encoding="utf-8")).get("documents", {})
    errors = []
    total = sum(len(course.get("lessons", [])) for course in catalog["courses"])
    processed = 0
    for course in catalog["courses"]:
        for lesson in course.get("lessons", []):
            processed += 1
            try:
                path = resolve_lesson_path(course, lesson, args.source_root, args.work_dir)
                digest = sha256(path)
                pages = None
                content_hash = None
                characters = 0
                widgets = []
                if lesson["type"] == "pdf":
                    pages, content_hash, characters, widgets = pdf_details(path)
                elif lesson["type"] in {"pptx", "ppsx"}:
                    content_hash, characters = presentation_details(path)
                record = {
                    "courseId": str(course["id"]),
                    "courseName": course["name"],
                    "lessonId": str(lesson["id"]),
                    "title": lesson["title"],
                    "originalName": lesson.get("originalName"),
                    "type": lesson["type"],
                    "url": lesson["url"],
                    "size": path.stat().st_size,
                    "pages": pages,
                    "sha256": digest,
                    "contentHash": content_hash,
                    "contentCharacters": characters,
                }
                documents.append(record)
                if lesson["type"] == "pdf" and not args.skip_fields:
                    document_key = f"{course['id']}|{lesson['id']}"
                    if args.reuse_fields and document_key in previous_fields:
                        page_fields = dict(previous_fields[document_key].get("pages", {}))
                        for page_index, page_widgets in enumerate(widgets, 1):
                            if page_widgets:
                                page_fields[str(page_index)] = merge_fields(page_widgets)
                    else:
                        page_fields = render_and_detect(path, pages, widgets, args.pdftoppm)
                    fields_documents[f"{course['id']}|{lesson['id']}"] = {
                        "url": lesson["url"],
                        "pages": page_fields,
                    }
            except Exception as error:
                errors.append({"course": course["name"], "lesson": lesson["title"], "reason": str(error)[:300]})
            if processed % 10 == 0 or processed == total:
                print(f"Analyzed {processed}/{total} current lessons", flush=True)

    if args.skip_library and args.known_output.exists():
        library = json.loads(args.known_output.read_text(encoding="utf-8")).get("libraryFindings", {})
    else:
        library = analyze_library(args.source_root)
    ordering = []
    for course in catalog["courses"]:
        numbered = [(lesson_number(lesson), lesson) for lesson in course.get("lessons", [])]
        comparable = [(number, lesson) for number, lesson in numbered if number is not None]
        sorted_lessons = sorted(comparable, key=lambda item: item[0])
        if [lesson["id"] for _, lesson in comparable] != [lesson["id"] for _, lesson in sorted_lessons]:
            ordering.append({
                "courseId": str(course["id"]),
                "courseName": course["name"],
                "current": [number for number, _ in comparable],
                "suggested": [number for number, _ in sorted_lessons],
            })

    current_exact = duplicate_groups(documents, "sha256")
    current_content = duplicate_groups(documents, "contentHash")
    generated_at = datetime.now(timezone.utc).isoformat()
    known = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "documents": documents,
        "libraryFindings": library,
    }
    fields = {
        "schemaVersion": 1,
        "generatedAt": generated_at,
        "documents": fields_documents,
    }
    report = {
        "generatedAt": generated_at,
        "catalogRevision": catalog.get("revision"),
        "current": {
            "courses": len(catalog["courses"]),
            "lessons": total,
            "analyzed": len(documents),
            "pdfPages": sum(record.get("pages") or 0 for record in documents),
            "exactDuplicateGroups": [[f"{item['courseName']}: {item['title']}" for item in group] for group in current_exact],
            "contentDuplicateGroups": [[f"{item['courseName']}: {item['title']}" for item in group] for group in current_content],
            "ordering": ordering,
            "errors": errors,
        },
        "sourceLibrary": library,
        "answerFields": {
            "documents": len(fields_documents),
            "pages": sum(len(document["pages"]) for document in fields_documents.values()),
            "fields": sum(len(page) for document in fields_documents.values() for page in document["pages"].values()),
        },
    }
    for destination, value in ((args.known_output, known), (args.fields_output, fields), (args.report_output, report)):
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)


if __name__ == "__main__":
    main()
