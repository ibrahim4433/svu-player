#!/usr/bin/env python3
"""
SVU Player — Module Bundler
Concatenates src/config.js and src/??-*.js modules into app.js
"""
import glob
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(ROOT, "src")
OUTPUT_FILE = os.path.join(ROOT, "app.js")


def bundle():
    modules = [os.path.join(SRC_DIR, "config.js")]
    modules.extend(sorted(glob.glob(os.path.join(SRC_DIR, "[0-9][0-9]-*.js"))))

    parts = []
    print("Bundling SVU Player:")
    for path in modules:
        rel = os.path.relpath(path, ROOT)
        size = os.path.getsize(path)
        print(f"  + {rel} ({size:,} bytes)")
        with open(path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if content:
                parts.append(content)

    bundled_code = "\n;\n".join(parts) + "\n"
    with open(OUTPUT_FILE, "w", encoding="utf-8", newline="\n") as f:
        f.write(bundled_code)

    total_size = os.path.getsize(OUTPUT_FILE)
    print(f"\n-> Successfully wrote {OUTPUT_FILE} ({total_size:,} bytes, {len(modules)} modules)")


if __name__ == "__main__":
    bundle()
