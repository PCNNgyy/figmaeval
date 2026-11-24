import argparse
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import struct

from PIL import Image

MAX_CANVAS_SIDE = 32768
MAX_CANVAS_PIXELS = 512 * 1024 * 1024
MAX_JUDGE_BASE64_BYTES = 5_000_000
MAX_JUDGE_TOTAL_BYTES = 24 * 1024 * 1024


def base64_size(byte_count):
    return 4 * ((byte_count + 2) // 3)


@contextmanager
def open_page_screenshot(path):
    with Path(path).open("rb") as source:
        header = source.read(24)
    if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise ValueError("Figma page screenshot is not a PNG")
    width, height = struct.unpack(">II", header[16:24])
    if min(width, height) < 1 or max(width, height) > MAX_CANVAS_SIDE or width * height > MAX_CANVAS_PIXELS:
        raise ValueError("Figma page screenshot exceeds the bounded canvas size")
    previous_limit = Image.MAX_IMAGE_PIXELS
    try:
        Image.MAX_IMAGE_PIXELS = MAX_CANVAS_PIXELS
        with Image.open(path) as image:
            yield image
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit


def prepare_judge_images(images, output, max_total_bytes=MAX_JUDGE_TOTAL_BYTES):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    limit = 2000 if len(images) > 20 else 8000
    total_source_bytes = sum(Path(item["path"]).stat().st_size for item in images)
    bounded_batch = total_source_bytes > max_total_bytes
    prepared, receipt = [], []
    for index, item in enumerate(images, 1):
        source = Path(item["path"])
        submitted = source
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        original_bytes = source.stat().st_size
        byte_limit = MAX_JUDGE_BASE64_BYTES // 4 * 3
        if bounded_batch:
            byte_limit = min(byte_limit, max(256, int(max_total_bytes * 0.96 * original_bytes / total_source_bytes)))
        with open_page_screenshot(source) as image:
            original_size = image.size
            submitted_size = original_size
            if max(image.size) > limit or original_bytes > byte_limit:
                factor = min(1, limit / max(image.size))
                if original_bytes > byte_limit:
                    factor = min(factor, math.sqrt(byte_limit / original_bytes) * 0.92)
                size = tuple(max(1, int(side * factor)) for side in image.size)
                image.thumbnail(size, Image.Resampling.LANCZOS)
                submitted = output / f"{index:02d}-{digest[:16]}-{limit}.png"
                image.save(submitted, format="PNG", compress_level=6)
                while submitted.stat().st_size > byte_limit:
                    factor = min(0.9, math.sqrt(byte_limit / submitted.stat().st_size) * 0.95)
                    size = tuple(max(1, int(side * factor)) for side in image.size)
                    if size == image.size:
                        raise ValueError("Judge image cannot fit the encoded byte limit")
                    image = image.resize(size, Image.Resampling.LANCZOS)
                    image.save(submitted, format="PNG", compress_level=6)
                submitted.chmod(0o600)
                submitted_size = image.size
        prepared.append({**item, "path": str(submitted)})
        receipt.append({"index": index, "source_path": str(source), "source_sha256": digest,
                        "submitted_path": str(submitted), "original_size": original_size,
                        "submitted_size": submitted_size, "resized": submitted_size != original_size,
                        "original_bytes": original_bytes, "submitted_bytes": submitted.stat().st_size,
                        "submitted_base64_bytes": base64_size(submitted.stat().st_size)})
    if sum(item["submitted_bytes"] for item in receipt) > max_total_bytes:
        raise ValueError("Complete judge evidence exceeds the batch byte limit")
    (output / "preflight.json").write_text(json.dumps({"max_dimension": limit,
        "max_base64_bytes": MAX_JUDGE_BASE64_BYTES, "max_total_bytes": max_total_bytes,
        "images": receipt}, ensure_ascii=False, indent=2) + "\n")
    return prepared


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    print(json.dumps(prepare_judge_images(json.loads(Path(args.manifest).read_text()), args.output), ensure_ascii=False))
