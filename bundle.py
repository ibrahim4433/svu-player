#!/usr/bin/env python3
"""
SVU Player — Module Bundler
Compiles assets/svu-material-codes.csv into src/04-materials.js and
concatenates src/config.js and src/??-*.js modules into app.js
"""
import csv
import glob
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(ROOT, "src")
OUTPUT_FILE = os.path.join(ROOT, "app.js")
CSV_FILE = os.path.join(ROOT, "assets", "svu-material-codes.csv")
MATERIALS_JS = os.path.join(SRC_DIR, "04-materials.js")


def build_materials():
    if not os.path.exists(CSV_FILE):
        print(f"Notice: CSV file not found at {CSV_FILE}, skipping materials build.")
        return

    with open(CSV_FILE, "r", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    clean_rows = []
    for r in rows:
        code = r.get("Course_Code", "").strip()
        en = r.get("English_Name", "").strip()
        ar = r.get("Arabic_Name", "").strip()
        if code:
            clean_rows.append([code, en, ar])

    json_data = json.dumps(clean_rows, ensure_ascii=False, separators=(",", ":"))

    js_code = (
        "(function (ns) {\n"
        "  'use strict';\n\n"
        "  // SVU Materials Database (Auto-generated from assets/svu-material-codes.csv)\n"
        f"  // {len(clean_rows)} total course records\n"
        f"  const RAW = {json_data};\n\n"
        "  const codeMap = new Map();\n"
        "  const allList = [];\n\n"
        "  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', \"'\": '&#39;' };\n"
        "  const esc = str => String(str || '').replace(/[&<>\"']/g, ch => ESC_MAP[ch]);\n\n"
        "  for (let i = 0; i < RAW.length; i++) {\n"
        "    const row = RAW[i];\n"
        "    const code = row[0];\n"
        "    const en = row[1];\n"
        "    const ar = row[2];\n"
        "    const upper = code.toUpperCase();\n\n"
        "    if (!codeMap.has(upper)) {\n"
        "      const entry = { code, en, ar, alts: [] };\n"
        "      codeMap.set(upper, entry);\n"
        "      allList.push(entry);\n"
        "    } else {\n"
        "      const existing = codeMap.get(upper);\n"
        "      if (existing.en !== en || existing.ar !== ar) {\n"
        "        if (!existing.alts.some(a => a.en === en && a.ar === ar)) {\n"
        "          existing.alts.push({ en, ar });\n"
        "        }\n"
        "      }\n"
        "    }\n"
        "  }\n\n"
        "  const MaterialsDB = {\n"
        "    get(rawCode) {\n"
        "      if (!rawCode) return null;\n"
        "      const key = String(rawCode).trim().toUpperCase();\n"
        "      return codeMap.get(key) || null;\n"
        "    },\n\n"
        "    getName(rawCode, lang) {\n"
        "      const mat = this.get(rawCode);\n"
        "      if (!mat) return '';\n"
        "      const currentLang = lang || (ns.I18N && ns.I18N.lang) || 'ar';\n"
        "      return currentLang === 'en' ? (mat.en || mat.ar) : (mat.ar || mat.en);\n"
        "    },\n\n"
        "    getLabel(rawCode, lang) {\n"
        "      const mat = this.get(rawCode);\n"
        "      if (!mat) return String(rawCode || '');\n"
        "      const currentLang = lang || (ns.I18N && ns.I18N.lang) || 'ar';\n"
        "      const name = currentLang === 'en' ? (mat.en || mat.ar) : (mat.ar || mat.en);\n"
        "      return mat.code + ' — ' + name;\n"
        "    },\n\n"
        "    getBadgeHtml(rawCode, options) {\n"
        "      const opts = options || {};\n"
        "      const mat = this.get(rawCode);\n"
        "      const codeStr = mat ? mat.code : String(rawCode || '');\n"
        "      const currentLang = opts.lang || (ns.I18N && ns.I18N.lang) || 'ar';\n"
        "      if (!mat) {\n"
        "        return '<span class=\"mtag mtag-material\"><b>' + esc(codeStr) + '</b></span>';\n"
        "      }\n"
        "      const mainName = currentLang === 'en' ? (mat.en || mat.ar) : (mat.ar || mat.en);\n"
        "      let title = mat.ar + ' / ' + mat.en;\n"
        "      if (mat.alts && mat.alts.length) {\n"
        "        title += ' (' + mat.alts.map(a => a.ar + ' / ' + a.en).join('; ') + ')';\n"
        "      }\n"
        "      return '<span class=\"mtag mtag-material\" title=\"' + esc(title) + '\"><b>' + esc(codeStr) + '</b> · ' + esc(mainName) + '</span>';\n"
        "    },\n\n"
        "    getTooltip(rawCode) {\n"
        "      const mat = this.get(rawCode);\n"
        "      if (!mat) return '';\n"
        "      let t = mat.ar + ' / ' + mat.en;\n"
        "      if (mat.alts && mat.alts.length) {\n"
        "        t += ' (' + mat.alts.map(a => a.ar + ' / ' + a.en).join('; ') + ')';\n"
        "      }\n"
        "      return t;\n"
        "    },\n\n"
        "    search(query, limit) {\n"
        "      const lim = typeof limit === 'number' ? limit : 50;\n"
        "      if (!query) return allList.slice(0, lim);\n"
        "      const q = String(query).trim().toLowerCase();\n"
        "      const exactCode = [];\n"
        "      const startsCode = [];\n"
        "      const matchesName = [];\n\n"
        "      for (let i = 0; i < allList.length; i++) {\n"
        "        const item = allList[i];\n"
        "        const codeLower = item.code.toLowerCase();\n"
        "        const enLower = item.en.toLowerCase();\n"
        "        const arLower = item.ar.toLowerCase();\n\n"
        "        if (codeLower === q) {\n"
        "          exactCode.push(item);\n"
        "        } else if (codeLower.startsWith(q)) {\n"
        "          startsCode.push(item);\n"
        "        } else if (codeLower.includes(q) || enLower.includes(q) || arLower.includes(q)) {\n"
        "          matchesName.push(item);\n"
        "        } else if (item.alts && item.alts.some(a => a.en.toLowerCase().includes(q) || a.ar.toLowerCase().includes(q))) {\n"
        "          matchesName.push(item);\n"
        "        }\n"
        "        if (exactCode.length + startsCode.length + matchesName.length >= lim * 2) break;\n"
        "      }\n"
        "      return exactCode.concat(startsCode, matchesName).slice(0, lim);\n"
        "    },\n\n"
        "    all() {\n"
        "      return allList;\n"
        "    },\n\n"
        "    count() {\n"
        "      return allList.length;\n"
        "    }\n"
        "  };\n\n"
        "  ns.MaterialsDB = MaterialsDB;\n"
        "})(globalThis);\n"
    )

    with open(MATERIALS_JS, "w", encoding="utf-8", newline="\n") as f:
        f.write(js_code)

    size = os.path.getsize(MATERIALS_JS)
    print(f"  + Compiled {CSV_FILE} -> {MATERIALS_JS} ({len(clean_rows)} courses, {size:,} bytes)")


def bundle():
    print("Bundling SVU Player:")
    build_materials()

    modules = [os.path.join(SRC_DIR, "config.js")]
    modules.extend(sorted(glob.glob(os.path.join(SRC_DIR, "[0-9][0-9]-*.js"))))

    parts = []
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
