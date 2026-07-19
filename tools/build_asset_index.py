"""assets/ 폴더를 스캔해 assets/index.json 을 생성한다.

에셋을 추가/삭제한 뒤 실행: python3 tools/build_asset_index.py
구조: { "폴더명": ["파일1.png", ...], ... }
"""
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
EXTS = (".png", ".gif", ".webp", ".jpg", ".jpeg")


def main():
    index = {}
    if os.path.isdir(ASSETS):
        for folder in sorted(os.listdir(ASSETS)):
            path = os.path.join(ASSETS, folder)
            if not os.path.isdir(path):
                continue
            files = sorted(
                f for f in os.listdir(path) if f.lower().endswith(EXTS)
            )
            if files:
                index[folder] = files
    out = os.path.join(ASSETS, "index.json")
    os.makedirs(ASSETS, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    total = sum(len(v) for v in index.values())
    print(f"assets/index.json: {len(index)} folders, {total} files")


if __name__ == "__main__":
    main()
