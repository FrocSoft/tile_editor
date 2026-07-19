"""샘플 에셋(폴더별 스프라이트)과 앱 아이콘을 생성한다.

실행: python3 tools/generate_samples.py
생성 후 tools/build_asset_index.py 를 실행해 index.json을 갱신할 것.
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(__file__))
from pnglib import write_png

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 8비트 느낌 팔레트
PAL = {
    ".": (0, 0, 0, 0),          # 투명
    "K": (26, 27, 38, 255),     # 검정
    "W": (240, 240, 245, 255),  # 흰색
    "R": (247, 118, 142, 255),  # 빨강
    "O": (255, 158, 100, 255),  # 주황
    "Y": (224, 175, 104, 255),  # 노랑
    "G": (158, 206, 106, 255),  # 초록
    "C": (115, 218, 202, 255),  # 청록
    "B": (122, 162, 247, 255),  # 파랑
    "P": (187, 154, 247, 255),  # 보라
    "D": (65, 72, 104, 255),    # 어두운 회청
    "L": (169, 177, 214, 255),  # 밝은 회청
}


def from_rows(rows):
    w = len(rows[0])
    px = []
    for row in rows:
        assert len(row) == w, row
        for ch in row:
            px.append(PAL[ch])
    return w, len(rows), px


def hstack(sprites):
    """같은 높이의 (w, h, px)들을 가로로 이어 붙인다."""
    h = sprites[0][1]
    total_w = sum(s[0] for s in sprites)
    px = []
    for y in range(h):
        for w, _, p in sprites:
            px.extend(p[y * w : (y + 1) * w])
    return total_w, h, px


def save(rel_path, w, h, px):
    path = os.path.join(ROOT, rel_path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_png(path, w, h, px)
    print("wrote", rel_path, f"({w}x{h})")


# ---------- characters: 16x16 캐릭터 4프레임 시트 ----------

HERO_BASE = [
    "....KKKKKKKK....",
    "...KBBBBBBBBK...",
    "..KBBBBBBBBBBK..",
    "..KBLLBBBBLLBK..",
    "..KBLWBBBBLWBK..",
    "..KBBBBBBBBBBK..",
    "..KBBBRRRRBBBK..",
    "...KBBBBBBBBK...",
    "....KKKKKKKK....",
    "...KYYYYYYYYK...",
    "..KYYYYYYYYYYK..",
    "..KYYKYYYYKYYK..",
    "...KYYYYYYYYK...",
    "....KKKKKKKK....",
    "....KDD..DDK....",
    "....KKK..KKK....",
]


def hero_frame(i):
    rows = list(HERO_BASE)
    # 걷기: 다리 위치를 프레임마다 교대
    legs = [
        ("....KDD..DDK....", "....KKK..KKK...."),
        ("...KDD....DDK...", "...KKK....KKK..."),
        ("....KDD..DDK....", "....KKK..KKK...."),
        (".....KDDDDK.....", ".....KKKKKK....."),
    ][i % 4]
    rows[14], rows[15] = legs
    # 눈 깜빡임
    if i % 4 == 3:
        rows[4] = "..KBLLBBBBLLBK.."
    return from_rows(rows)


SLIME_FRAMES = [
    [
        "................",
        "................",
        "................",
        "................",
        "......KKKK......",
        "....KKGGGGKK....",
        "...KGGGGGGGGK...",
        "..KGGWKGGKWGGK..",
        "..KGGKKGGKKGGK..",
        ".KGGGGGGGGGGGGK.",
        ".KGGGGGGGGGGGGK.",
        ".KGGGGGGGGGGGGK.",
        "..KGGGGGGGGGGK..",
        "...KKKKKKKKKK...",
        "................",
        "................",
    ],
    [
        "................",
        "................",
        "................",
        "................",
        "................",
        "................",
        ".....KKKKKK.....",
        "...KKGGGGGGKK...",
        "..KGGWKGGKWGGK..",
        ".KGGGKKGGKKGGGK.",
        "KGGGGGGGGGGGGGGK",
        "KGGGGGGGGGGGGGGK",
        ".KGGGGGGGGGGGGK.",
        "..KKKKKKKKKKKK..",
        "................",
        "................",
    ],
]


def make_characters():
    save("assets/characters/hero_walk.png", *hstack([hero_frame(i) for i in range(4)]))
    frames = [from_rows(SLIME_FRAMES[i % 2]) for i in range(4)]
    save("assets/characters/slime.png", *hstack(frames))


# ---------- backgrounds: 반복 패턴 ----------

def make_bricks():
    w, h = 64, 64
    px = []
    for y in range(h):
        for x in range(w):
            by = y % 16
            bx = (x + (8 if (y // 16) % 2 else 0)) % 32
            if by in (0, 15) or bx in (0, 31):
                px.append(PAL["K"])
            elif by in (1, 2) and bx > 2:
                px.append(PAL["L"])
            else:
                px.append(PAL["D"])
    save("assets/backgrounds/bricks.png", w, h, px)


def make_clouds():
    rng = random.Random(7)
    w, h = 64, 32
    grid = [[PAL["B"]] * w for _ in range(h)]
    for _ in range(6):
        cx, cy, r = rng.randrange(w), rng.randrange(4, h - 4), rng.randrange(4, 9)
        for y in range(h):
            for x in range(w):
                dx = min(abs(x - cx), w - abs(x - cx))  # 가로 타일링 유지
                if dx * dx + (y - cy) ** 2 * 3 < r * r:
                    grid[y][x] = PAL["W"]
    px = [c for row in grid for c in row]
    save("assets/backgrounds/clouds.png", w, h, px)


def make_checker_dungeon():
    w, h = 64, 64
    px = []
    for y in range(h):
        for x in range(w):
            t = (x // 8 + y // 8) % 2
            inner = 1 <= x % 8 <= 6 and 1 <= y % 8 <= 6
            if t == 0:
                px.append(PAL["D"] if inner else PAL["K"])
            else:
                px.append(PAL["P"] if inner else PAL["K"])
    save("assets/backgrounds/dungeon.png", w, h, px)


# ---------- glitch: 교란용 소스 ----------

def make_noise():
    rng = random.Random(42)
    w, h = 64, 64
    colors = [PAL[k] for k in "KWRYGCBPDL"]
    px = [None] * (w * h)
    for ty in range(h // 8):
        for tx in range(w // 8):
            # 타일마다 2색 랜덤 디더 패턴
            a, b = rng.sample(colors, 2)
            for y in range(8):
                for x in range(8):
                    v = a if (x + y * 3 + rng.randrange(2)) % 3 else b
                    px[(ty * 8 + y) * w + (tx * 8 + x)] = v
    save("assets/glitch/noise.png", w, h, px)


def make_scanlines():
    w, h = 64, 64
    ramp = [PAL[k] for k in "KDPBCGYOR"]
    px = []
    for y in range(h):
        for x in range(w):
            c = ramp[(x // 8 + (y // 2) % 3) % len(ramp)]
            if y % 4 == 3:
                c = (c[0] // 2, c[1] // 2, c[2] // 2, 255)
            px.append(c)
    save("assets/glitch/scanline_bars.png", w, h, px)


# ---------- 앱 아이콘 ----------

def make_icon(size, rel_path):
    rng = random.Random(size)
    n = 8  # 8x8 모자이크
    cell = size // n
    colors = [PAL[k] for k in "BPCRGYD"]
    px = [None] * (size * size)
    for ty in range(n):
        for tx in range(n):
            c = rng.choice(colors)
            # 중앙에 'T' 형태 강조
            if ty == 2 and 1 <= tx <= 6:
                c = PAL["W"]
            if tx in (3, 4) and 2 <= ty <= 6:
                c = PAL["W"]
            for y in range(cell):
                for x in range(cell):
                    edge = x < max(1, cell // 12) or y < max(1, cell // 12)
                    v = PAL["K"] if edge else c
                    px[(ty * cell + y) * size + (tx * cell + x)] = v
    # 셀 나눗셈 나머지 채움
    for i in range(size * size):
        if px[i] is None:
            px[i] = PAL["K"]
    save(rel_path, size, size, px)


if __name__ == "__main__":
    make_characters()
    make_bricks()
    make_clouds()
    make_checker_dungeon()
    make_noise()
    make_scanlines()
    for s in (180, 192, 512):
        make_icon(s, f"icons/icon-{s}.png")
