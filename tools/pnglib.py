"""최소 PNG 작성기 (의존성 없음, RGBA 전용)."""
import struct
import zlib


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def write_png(path: str, width: int, height: int, pixels) -> None:
    """pixels: (r, g, b, a) 튜플의 행 우선 리스트, 길이 width*height."""
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # 필터 없음
        for x in range(width):
            raw.extend(pixels[y * width + x])
    data = (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
        + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(data)
