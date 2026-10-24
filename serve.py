#!/usr/bin/env python3
"""
SVU Player — local server (standalone local mode)
Connects only to sessions.svuonline.org for browsing the session catalog
and downloading .lrec recordings.
"""
import html as html_mod
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))

SVU_CATALOG_URL = "http://sessions.svuonline.org/new/Default.aspx"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/148.0.0.0 Safari/537.36"
)

EXTRA_TYPES = {
    ".wasm": "application/wasm",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".webmanifest": "application/manifest+json",
    ".mjs": "application/javascript",
    ".js": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".css": "text/css",
    ".csv": "text/csv; charset=utf-8",
    ".lrec": "application/octet-stream",
}

# In-memory cache of ASP.NET postback states keyed by selection tuple
# Each entry: {"ts": float, "hidden": dict, "data": dict}
_CACHE_LOCK = threading.Lock()
_BROWSE_CACHE = {}
_CACHE_TTL = 1800  # 30 minutes


def _fetch_catalog_html(form_data=None):
    headers = {"User-Agent": USER_AGENT}
    if form_data is not None:
        body = urllib.parse.urlencode(form_data).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(SVU_CATALOG_URL, data=body, headers=headers)
    else:
        req = urllib.request.Request(SVU_CATALOG_URL, headers=headers)
    with urllib.request.urlopen(req, timeout=25) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _extract_hidden(page_html):
    hidden = {}
    for name in (
        "__VIEWSTATE",
        "__VIEWSTATEGENERATOR",
        "__VIEWSTATEENCRYPTED",
        "__EVENTVALIDATION",
    ):
        m = re.search(rf'id="{name}"\s+value="([^"]*)"', page_html)
        if m:
            hidden[name] = html_mod.unescape(m.group(1))
    return hidden


def _extract_select(page_html, select_id):
    m = re.search(
        rf'<select[^>]*id="{select_id}"[^>]*>(.*?)</select>',
        page_html,
        re.S | re.I,
    )
    if not m:
        return []
    items = []
    for raw_val, raw_label in re.findall(
        r'<option[^>]*value="([^"]*)"[^>]*>(.*?)</option>', m.group(1), re.S | re.I
    ):
        raw_unescaped = html_mod.unescape(raw_val)
        val = raw_unescaped.strip()
        label = html_mod.unescape(re.sub(r"<[^>]+>", "", raw_label)).strip()
        if not val or val == "0" or label.lower().startswith("select "):
            continue
        items.append({"value": val, "raw_value": raw_unescaped, "label": label})
    return items


def _resolve_raw(items, val):
    if not val:
        return ""
    stripped = val.strip()
    for it in items:
        if it.get("value") == stripped or it.get("raw_value") == val:
            return it.get("raw_value", it.get("value"))
    return val


def _clean_cell(cell_html):
    text = re.sub(r"<[^>]+>", "", cell_html)
    return html_mod.unescape(text).replace("\xa0", " ").strip()


def _extract_sessions(page_html):
    m = re.search(
        r'<table[^>]*id="GridView_results"[^>]*>(.*?)</table>',
        page_html,
        re.S | re.I,
    )
    if not m:
        return []
    sessions = []
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(1), re.S | re.I)
    for row in rows:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        if len(cells) < 8:
            continue
        idx_match = re.search(r"Select\$(\d+)", cells[0])
        idx = int(idx_match.group(1)) if idx_match else len(sessions)
        sessions.append(
            {
                "index": idx,
                "program": _clean_cell(cells[1]),
                "course": _clean_cell(cells[2]),
                "class": _clean_cell(cells[3]),
                "term": _clean_cell(cells[4]),
                "order": _clean_cell(cells[5]),
                "tutor": _clean_cell(cells[6]),
                "date": _clean_cell(cells[7]),
            }
        )
    return sessions


def _extract_files(page_html):
    m = re.search(
        r'<table[^>]*id="GridView1"[^>]*>(.*?)</table>',
        page_html,
        re.S | re.I,
    )
    if not m:
        return []
    files = []
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", m.group(1), re.S | re.I)
    for row in rows:
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        if len(cells) < 4:
            continue
        href_match = re.search(r'href="([^"]+)"', cells[0], re.I)
        if not href_match:
            continue
        url = html_mod.unescape(href_match.group(1)).strip()
        parsed_url = urllib.parse.urlparse(url)
        name = urllib.parse.unquote(parsed_url.path.split("/")[-1] or "session.lrec")
        desc = _clean_cell(cells[1]) or name
        date_str = _clean_cell(cells[2])
        size_str = _clean_cell(cells[3])
        try:
            size_mb = float(size_str) if "." in size_str else int(size_str)
        except ValueError:
            size_mb = 0
        files.append(
            {
                "url": url,
                "name": name,
                "description": desc,
                "date": date_str,
                "sizeMB": size_mb,
            }
        )
    return files


def _get_cached(key):
    now = time.time()
    with _CACHE_LOCK:
        entry = _BROWSE_CACHE.get(key)
        if entry and (now - entry["ts"]) < _CACHE_TTL:
            return entry
    return None


def _set_cached(key, hidden, data):
    entry = {"ts": time.time(), "hidden": hidden, "data": data}
    with _CACHE_LOCK:
        if len(_BROWSE_CACHE) > 256:
            _BROWSE_CACHE.clear()
        _BROWSE_CACHE[key] = entry
    return entry


def browse_catalog(params):
    term = params.get("term", "").strip()
    program = params.get("program", "").strip()
    course = params.get("course", "").strip()
    tutor = params.get("tutor", "").strip()
    cls = params.get("class", "").strip()
    session = params.get("session", "").strip()
    force_refresh = params.get("refresh", "").strip() == "1"

    if force_refresh:
        with _CACHE_LOCK:
            if cls:
                # Invalidate session list and file lists for this class
                prefix = (term, program, course, tutor, cls)
                for k in list(_BROWSE_CACHE.keys()):
                    if len(k) >= 5 and k[:5] == prefix:
                        _BROWSE_CACHE.pop(k, None)
            elif course:
                prefix = (term, program, course)
                for k in list(_BROWSE_CACHE.keys()):
                    if len(k) >= 3 and k[:3] == prefix:
                        _BROWSE_CACHE.pop(k, None)
            elif program:
                prefix = (term, program)
                for k in list(_BROWSE_CACHE.keys()):
                    if len(k) >= 2 and k[:2] == prefix:
                        _BROWSE_CACHE.pop(k, None)
            else:
                _BROWSE_CACHE.clear()

    # Step 0: Initial page (terms)
    step0 = _get_cached(())
    if not step0:
        page_html = _fetch_catalog_html()
        hidden = _extract_hidden(page_html)
        terms = _extract_select(page_html, "DropDownList_Term")
        step0 = _set_cached((), hidden, {"terms": terms})

    result = {"terms": step0["data"]["terms"]}
    if not term:
        return result
    raw_term = _resolve_raw(step0["data"]["terms"], term)

    # Step 1: Term -> Programs
    key1 = (term,)
    step1 = _get_cached(key1)
    if not step1:
        form = {
            **step0["hidden"],
            "__EVENTTARGET": "DropDownList_Term",
            "__EVENTARGUMENT": "",
            "__LASTFOCUS": "",
            "DropDownList_Term": raw_term,
        }
        page_html = _fetch_catalog_html(form)
        hidden = _extract_hidden(page_html)
        programs = _extract_select(page_html, "DropDownList_Program")
        step1 = _set_cached(key1, hidden, {"programs": programs})

    result["term"] = term
    programs = step1["data"]["programs"]
    result["programs"] = programs
    if not program and len(programs) == 1:
        program = programs[0]["value"]
    if not program:
        return result
    raw_program = _resolve_raw(programs, program)

    # Step 2: Program -> Courses
    key2 = (term, program)
    step2 = _get_cached(key2)
    if not step2:
        form = {
            **step1["hidden"],
            "__EVENTTARGET": "DropDownList_Program",
            "__EVENTARGUMENT": "",
            "__LASTFOCUS": "",
            "DropDownList_Term": raw_term,
            "DropDownList_Program": raw_program,
        }
        page_html = _fetch_catalog_html(form)
        hidden = _extract_hidden(page_html)
        courses = _extract_select(page_html, "DropDownList_Course")
        step2 = _set_cached(key2, hidden, {"courses": courses})

    result["program"] = program
    courses = step2["data"]["courses"]
    result["courses"] = courses
    if not course and len(courses) == 1:
        course = courses[0]["value"]
    if not course:
        return result
    raw_course = _resolve_raw(courses, course)

    # Step 3: Course -> Tutors
    key3 = (term, program, course)
    step3 = _get_cached(key3)
    if not step3:
        form = {
            **step2["hidden"],
            "__EVENTTARGET": "DropDownList_Course",
            "__EVENTARGUMENT": "",
            "__LASTFOCUS": "",
            "DropDownList_Term": raw_term,
            "DropDownList_Program": raw_program,
            "DropDownList_Course": raw_course,
        }
        page_html = _fetch_catalog_html(form)
        hidden = _extract_hidden(page_html)
        tutors = _extract_select(page_html, "DropDownList_Tutor")
        step3 = _set_cached(key3, hidden, {"tutors": tutors})

    result["course"] = course
    tutors = step3["data"]["tutors"]
    result["tutors"] = tutors
    if not tutor and len(tutors) == 1:
        tutor = tutors[0]["value"]
    if not tutor:
        return result
    raw_tutor = _resolve_raw(tutors, tutor)

    # Step 4: Tutor -> Classes
    key4 = (term, program, course, tutor)
    step4 = _get_cached(key4)
    if not step4:
        form = {
            **step3["hidden"],
            "__EVENTTARGET": "DropDownList_Tutor",
            "__EVENTARGUMENT": "",
            "__LASTFOCUS": "",
            "DropDownList_Term": raw_term,
            "DropDownList_Program": raw_program,
            "DropDownList_Course": raw_course,
            "DropDownList_Tutor": raw_tutor,
        }
        page_html = _fetch_catalog_html(form)
        hidden = _extract_hidden(page_html)
        classes = _extract_select(page_html, "DropDownList_Class")
        step4 = _set_cached(key4, hidden, {"classes": classes})

    result["tutor"] = tutor
    classes = step4["data"]["classes"]
    result["classes"] = classes
    if not cls and len(classes) == 1:
        cls = classes[0]["value"]
    if not cls:
        return result
    raw_cls = _resolve_raw(classes, cls)

    # Step 5: Class -> Sessions
    key5 = (term, program, course, tutor, cls)
    step5 = _get_cached(key5)
    if not step5:
        form = {
            **step4["hidden"],
            "__EVENTTARGET": "DropDownList_Class",
            "__EVENTARGUMENT": "",
            "__LASTFOCUS": "",
            "DropDownList_Term": raw_term,
            "DropDownList_Program": raw_program,
            "DropDownList_Course": raw_course,
            "DropDownList_Tutor": raw_tutor,
            "DropDownList_Class": raw_cls,
        }
        page_html = _fetch_catalog_html(form)
        hidden = _extract_hidden(page_html)
        sessions = _extract_sessions(page_html)
        step5 = _set_cached(key5, hidden, {"sessions": sessions})

    result["class"] = cls
    result["sessions"] = step5["data"]["sessions"]
    if session == "":
        return result

    # Step 6: Session -> Files
    key6 = (term, program, course, tutor, cls, str(session))
    step6 = _get_cached(key6)
    if not step6:
        form = {
            **step5["hidden"],
            "__EVENTTARGET": "GridView_results",
            "__EVENTARGUMENT": f"Select${session}",
            "__LASTFOCUS": "",
            "DropDownList_Term": raw_term,
            "DropDownList_Program": raw_program,
            "DropDownList_Course": raw_course,
            "DropDownList_Tutor": raw_tutor,
            "DropDownList_Class": raw_cls,
        }
        page_html = _fetch_catalog_html(form)
        hidden = _extract_hidden(page_html)
        files = _extract_files(page_html)
        step6 = _set_cached(key6, hidden, {"files": files})

    result["session"] = int(session) if session.isdigit() else session
    result["files"] = step6["data"]["files"]
    return result


def parse_args(argv):
    opts = {"port": 8080, "host": "127.0.0.1"}
    positional = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.isdigit() and not positional:
            opts["port"] = int(a)
        elif not a.startswith("-"):
            positional.append(a)
        i += 1
    if len(positional) >= 2:
        opts["host"] = positional[1]
    elif len(positional) == 1:
        opts["host"] = positional[0]
    return opts


CLIENT_DISCONNECT_ERRORS = (
    ConnectionResetError,
    BrokenPipeError,
    ConnectionAbortedError,
    ConnectionError,
)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True

    def copyfile(self, source, outputfile):
        try:
            super().copyfile(source, outputfile)
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True

    def send_json(self, status, obj):
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(payload)
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True

    def handle_browse(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        params = {k: (v[0] if v else "") for k, v in qs.items()}
        try:
            data = browse_catalog(params)
            self.send_json(200, data)
        except urllib.error.URLError as e:
            self.send_json(502, {"error": f"sessions.svuonline.org unreachable: {e.reason}"})
        except Exception as e:
            self.send_json(502, {"error": f"browse error: {e}"})

    def proxy_download(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        url = qs.get("url", [None])[0]
        if not url:
            self.send_error(400, "missing url parameter")
            return
        target = urllib.parse.urlparse(url)
        host = (target.hostname or "").lower()
        if (
            target.scheme not in ("http", "https")
            or (host != "svuonline.org" and not host.endswith(".svuonline.org"))
            or not target.path.lower().endswith(".lrec")
        ):
            self.send_error(403, "only .lrec URLs from svuonline.org allowed")
            return
        fwd = {
            k: v
            for k, v in self.headers.items()
            if k.lower() not in ("host", "content-length", "accept-encoding")
        }
        if not fwd.get("User-Agent"):
            fwd["User-Agent"] = USER_AGENT
        req = urllib.request.Request(url, method=self.command, headers=fwd)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() in (
                        "transfer-encoding",
                        "connection",
                        "content-length",
                        "content-encoding",
                    ):
                        continue
                    self.send_header(k, v)
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True
        except urllib.error.HTTPError as e:
            try:
                payload = e.read()
                self.send_response(e.code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except CLIENT_DISCONNECT_ERRORS:
                self.close_connection = True
        except urllib.error.URLError as e:
            self.send_json(502, {"error": f"backend unreachable: {e.reason}"})
        except Exception as e:
            self.send_json(502, {"error": f"proxy error: {e}"})

    def do_GET(self):
        clean_path = self.path.split("?")[0]
        if clean_path in ("/assets/index.html", "/assets/app.js", "/assets/"):
            # Fallback for legacy service worker relative paths during upgrade
            self.path = "/" + clean_path[len("/assets/"):]
        if self.path.startswith("/api/browse"):
            self.handle_browse()
            return
        if self.path.startswith("/api/download"):
            self.proxy_download()
            return
        if self.path.startswith("/api/"):
            self.send_error(404, "API endpoint removed (offline mode)")
            return
        try:
            super().do_GET()
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True

    def do_HEAD(self):
        try:
            super().do_HEAD()
        except CLIENT_DISCONNECT_ERRORS:
            self.close_connection = True

    def do_POST(self):
        if self.path.startswith("/api/"):
            self.send_error(404, "API endpoint removed (offline mode)")
            return
        self.send_error(405, "POST only supported under /api/")

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)

    def end_headers(self):
        path = self.path.split("?")[0]
        if path.endswith(("sw.js",)):
            self.send_header("Service-Worker-Allowed", "/")
        if path.endswith((".html", ".js", ".css", ".json", "/")):
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Gracefully ignore client disconnects/aborts (common on Windows when browser
        # cancels in-flight asset downloads, reloads the page, or closes keep-alive sockets)
        exc_type, exc_val, _ = sys.exc_info()
        if exc_type and issubclass(exc_type, CLIENT_DISCONNECT_ERRORS):
            return
        if exc_type and issubclass(exc_type, OSError):
            winerror = getattr(exc_val, "winerror", None)
            if winerror in (10053, 10054):  # WSAECONNABORTED, WSAECONNRESET
                return
        super().handle_error(request, client_address)


def main():
    opts = parse_args(sys.argv[1:])

    with Server((opts["host"], opts["port"]), Handler) as httpd:
        print()
        print("  SVU Player — local server (standalone mode)")
        print("  -------------------------------------------")
        print("  Root : %s" % ROOT)
        print("  URL  : http://%s:%d/" % (opts["host"], opts["port"]))
        print("  API  : /api/browse & /api/download -> sessions.svuonline.org")
        print()
        print("  Open the URL above in your browser.")
        print("  Press Ctrl+C to stop.")
        print()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.")


if __name__ == "__main__":
    main()
