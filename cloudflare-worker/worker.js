/**
 * SVU Player — Cloudflare Worker Edge Proxy
 * -----------------------------------------
 * Handles:
 *  1. GET /api/browse?term=...&program=... (Cascading ViewState Scraper)
 *  2. GET /api/download?url=... (CORS & Streaming Proxy for .lrec files)
 *
 * Runs 100% on Cloudflare's free Workers tier (100,000 req/day).
 */

const SVU_CATALOG_URL = "http://sessions.svuonline.org/new/Default.aspx";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

const _BROWSE_CACHE = new Map();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, User-Agent, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Disposition"
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}

function unescapeHtml(str) {
  if (!str) return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec));
}

function cleanCell(cellHtml) {
  if (!cellHtml) return "";
  const text = cellHtml.replace(/<[^>]+>/g, "");
  return unescapeHtml(text).replace(/\u00a0/g, " ").trim();
}

function extractHidden(html) {
  const hidden = {};
  const names = ["__VIEWSTATE", "__VIEWSTATEGENERATOR", "__VIEWSTATEENCRYPTED", "__EVENTVALIDATION"];
  for (const name of names) {
    const regex = new RegExp(`id="${name}"\\s+value="([^"]*)"`, "i");
    const match = html.match(regex);
    if (match) {
      hidden[name] = unescapeHtml(match[1]);
    }
  }
  return hidden;
}

function extractSelect(html, selectId) {
  const selectRegex = new RegExp(`<select[^>]*id="${selectId}"[^>]*>([\\s\\S]*?)<\\/select>`, "i");
  const selectMatch = html.match(selectRegex);
  if (!selectMatch) return [];

  const items = [];
  const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
  let match;
  while ((match = optionRegex.exec(selectMatch[1])) !== null) {
    const rawUnescaped = unescapeHtml(match[1]);
    const val = rawUnescaped.trim();
    const label = unescapeHtml(match[2].replace(/<[^>]+>/g, "")).trim();
    if (!val || val === "0" || label.toLowerCase().startsWith("select ")) {
      continue;
    }
    items.push({ value: val, raw_value: rawUnescaped, label });
  }
  return items;
}

function resolveRaw(items, val) {
  if (!val) return "";
  const stripped = val.trim();
  for (const it of items) {
    if (it.value === stripped || it.raw_value === val) {
      return it.raw_value || it.value;
    }
  }
  return val;
}

function extractSessions(html) {
  const tableMatch = html.match(/<table[^>]*id="GridView_results"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];

  const sessions = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 8) continue;

    const idxMatch = cells[0].match(/Select\$(\d+)/i);
    const idx = idxMatch ? parseInt(idxMatch[1], 10) : sessions.length;
    sessions.push({
      index: idx,
      program: cleanCell(cells[1]),
      course: cleanCell(cells[2]),
      class: cleanCell(cells[3]),
      term: cleanCell(cells[4]),
      order: cleanCell(cells[5]),
      tutor: cleanCell(cells[6]),
      date: cleanCell(cells[7])
    });
  }
  return sessions;
}

function extractFiles(html) {
  const tableMatch = html.match(/<table[^>]*id="GridView1"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];

  const files = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(tableMatch[1])) !== null) {
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowMatch[1])) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 4) continue;

    const hrefMatch = cells[0].match(/href="([^"]+)"/i);
    if (!hrefMatch) continue;

    const url = unescapeHtml(hrefMatch[1]).trim();
    let name = "session.lrec";
    try {
      const parsed = new URL(url);
      name = decodeURIComponent(parsed.pathname.split("/").pop() || "session.lrec");
    } catch (e) {}

    const desc = cleanCell(cells[1]) || name;
    const dateStr = cleanCell(cells[2]);
    const sizeStr = cleanCell(cells[3]);
    let sizeMb = 0;
    try {
      sizeMb = parseFloat(sizeStr) || 0;
    } catch (e) {}

    files.push({
      url,
      name,
      description: desc,
      date: dateStr,
      sizeMB: sizeMb
    });
  }
  return files;
}

async function fetchCatalogHtml(formData = null) {
  const headers = { "User-Agent": USER_AGENT };
  const init = {
    method: formData ? "POST" : "GET",
    headers
  };
  if (formData) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(formData).toString();
  }
  const resp = await fetch(SVU_CATALOG_URL, init);
  if (!resp.ok) {
    throw new Error(`Upstream university server returned HTTP ${resp.status}`);
  }
  return await resp.text();
}

function getCache(key) {
  const entry = _BROWSE_CACHE.get(key);
  if (entry && (Date.now() - entry.ts) < CACHE_TTL_MS) {
    return entry;
  }
  return null;
}

function setCache(key, hidden, data) {
  const entry = { ts: Date.now(), hidden, data };
  if (_BROWSE_CACHE.size > 256) {
    _BROWSE_CACHE.clear();
  }
  _BROWSE_CACHE.set(key, entry);
  return entry;
}

async function browseCatalog(params) {
  const term = (params.get("term") || "").trim();
  const program = (params.get("program") || "").trim();
  const course = (params.get("course") || "").trim();
  const tutor = (params.get("tutor") || "").trim();
  const cls = (params.get("class") || "").trim();
  const session = (params.get("session") || "").trim();
  const forceRefresh = params.get("refresh") === "1";

  if (forceRefresh) {
    _BROWSE_CACHE.clear();
  }

  // Step 0: Initial terms
  let step0 = getCache("step0");
  if (!step0) {
    const pageHtml = await fetchCatalogHtml();
    const hidden = extractHidden(pageHtml);
    const terms = extractSelect(pageHtml, "DropDownList_Term");
    step0 = setCache("step0", hidden, { terms });
  }

  const result = { terms: step0.data.terms };
  if (!term) return result;
  const rawTerm = resolveRaw(step0.data.terms, term);

  // Step 1: Programs
  const key1 = `step1:${term}`;
  let step1 = getCache(key1);
  if (!step1) {
    const form = {
      ...step0.hidden,
      __EVENTTARGET: "DropDownList_Term",
      __EVENTARGUMENT: "",
      __LASTFOCUS: "",
      DropDownList_Term: rawTerm
    };
    const pageHtml = await fetchCatalogHtml(form);
    const hidden = extractHidden(pageHtml);
    const programs = extractSelect(pageHtml, "DropDownList_Program");
    step1 = setCache(key1, hidden, { programs });
  }

  result.term = term;
  let programs = step1.data.programs;
  result.programs = programs;
  let activeProg = program;
  if (!activeProg && programs.length === 1) {
    activeProg = programs[0].value;
  }
  if (!activeProg) return result;
  const rawProgram = resolveRaw(programs, activeProg);

  // Step 2: Courses
  const key2 = `step2:${term}:${activeProg}`;
  let step2 = getCache(key2);
  if (!step2) {
    const form = {
      ...step1.hidden,
      __EVENTTARGET: "DropDownList_Program",
      __EVENTARGUMENT: "",
      __LASTFOCUS: "",
      DropDownList_Term: rawTerm,
      DropDownList_Program: rawProgram
    };
    const pageHtml = await fetchCatalogHtml(form);
    const hidden = extractHidden(pageHtml);
    const courses = extractSelect(pageHtml, "DropDownList_Course");
    step2 = setCache(key2, hidden, { courses });
  }

  result.program = activeProg;
  let courses = step2.data.courses;
  result.courses = courses;
  let activeCourse = course;
  if (!activeCourse && courses.length === 1) {
    activeCourse = courses[0].value;
  }
  if (!activeCourse) return result;
  const rawCourse = resolveRaw(courses, activeCourse);

  // Step 3: Tutors
  const key3 = `step3:${term}:${activeProg}:${activeCourse}`;
  let step3 = getCache(key3);
  if (!step3) {
    const form = {
      ...step2.hidden,
      __EVENTTARGET: "DropDownList_Course",
      __EVENTARGUMENT: "",
      __LASTFOCUS: "",
      DropDownList_Term: rawTerm,
      DropDownList_Program: rawProgram,
      DropDownList_Course: rawCourse
    };
    const pageHtml = await fetchCatalogHtml(form);
    const hidden = extractHidden(pageHtml);
    const tutors = extractSelect(pageHtml, "DropDownList_Tutor");
    step3 = setCache(key3, hidden, { tutors });
  }

  result.course = activeCourse;
  let tutors = step3.data.tutors;
  result.tutors = tutors;
  let activeTutor = tutor;
  if (!activeTutor && tutors.length === 1) {
    activeTutor = tutors[0].value;
  }
  if (!activeTutor) return result;
  const rawTutor = resolveRaw(tutors, activeTutor);

  // Step 4: Classes
  const key4 = `step4:${term}:${activeProg}:${activeCourse}:${activeTutor}`;
  let step4 = getCache(key4);
  if (!step4) {
    const form = {
      ...step3.hidden,
      __EVENTTARGET: "DropDownList_Tutor",
      __EVENTARGUMENT: "",
      __LASTFOCUS: "",
      DropDownList_Term: rawTerm,
      DropDownList_Program: rawProgram,
      DropDownList_Course: rawCourse,
      DropDownList_Tutor: rawTutor
    };
    const pageHtml = await fetchCatalogHtml(form);
    const hidden = extractHidden(pageHtml);
    const classes = extractSelect(pageHtml, "DropDownList_Class");
    step4 = setCache(key4, hidden, { classes });
  }

  result.tutor = activeTutor;
  let classes = step4.data.classes;
  result.classes = classes;
  let activeClass = cls;
  if (!activeClass && classes.length === 1) {
    activeClass = classes[0].value;
  }
  if (!activeClass) return result;
  const rawClass = resolveRaw(classes, activeClass);

  // Step 5: Sessions
  const key5 = `step5:${term}:${activeProg}:${activeCourse}:${activeTutor}:${activeClass}`;
  let step5 = getCache(key5);
  if (!step5) {
    const form = {
      ...step4.hidden,
      __EVENTTARGET: "DropDownList_Class",
      __EVENTARGUMENT: "",
      __LASTFOCUS: "",
      DropDownList_Term: rawTerm,
      DropDownList_Program: rawProgram,
      DropDownList_Course: rawCourse,
      DropDownList_Tutor: rawTutor,
      DropDownList_Class: rawClass
    };
    const pageHtml = await fetchCatalogHtml(form);
    const hidden = extractHidden(pageHtml);
    const sessions = extractSessions(pageHtml);
    step5 = setCache(key5, hidden, { sessions });
  }

  result.class = activeClass;
  result.sessions = step5.data.sessions;
  if (session === "") return result;

  // Step 6: Files
  const key6 = `step6:${term}:${activeProg}:${activeCourse}:${activeTutor}:${activeClass}:${session}`;
  let step6 = getCache(key6);
  if (!step6) {
    const form = {
      ...step5.hidden,
      __EVENTTARGET: "GridView_results",
      __EVENTARGUMENT: `Select$${session}`,
      __LASTFOCUS: "",
      DropDownList_Term: rawTerm,
      DropDownList_Program: rawProgram,
      DropDownList_Course: rawCourse,
      DropDownList_Tutor: rawTutor,
      DropDownList_Class: rawClass
    };
    const pageHtml = await fetchCatalogHtml(form);
    const hidden = extractHidden(pageHtml);
    const files = extractFiles(pageHtml);
    step6 = setCache(key6, hidden, { files });
  }

  result.session = /^\d+$/.test(session) ? parseInt(session, 10) : session;
  result.files = step6.data.files;
  return result;
}

async function proxyDownload(targetUrl, requestHeaders) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch (e) {
    return jsonResponse({ error: "Invalid target URL" }, 400);
  }

  const host = target.hostname.toLowerCase();
  const isSvu = host === "svuonline.org" || host.endsWith(".svuonline.org");
  const isLrec = target.pathname.toLowerCase().endsWith(".lrec");

  if (!isSvu || !isLrec || (target.protocol !== "http:" && target.protocol !== "https:")) {
    return jsonResponse({ error: "Only .lrec URLs from svuonline.org allowed" }, 403);
  }

  const fwdHeaders = new Headers();
  fwdHeaders.set("User-Agent", USER_AGENT);
  if (requestHeaders.has("Range")) {
    fwdHeaders.set("Range", requestHeaders.get("Range"));
  }

  try {
    const upstreamResp = await fetch(target.href, {
      method: "GET",
      headers: fwdHeaders
    });

    const outHeaders = new Headers(CORS_HEADERS);
    const copyHeaders = ["content-type", "content-length", "content-disposition", "content-range", "accept-ranges"];
    for (const h of copyHeaders) {
      if (upstreamResp.headers.has(h)) {
        outHeaders.set(h, upstreamResp.headers.get(h));
      }
    }
    if (!outHeaders.has("content-type")) {
      outHeaders.set("content-type", "application/octet-stream");
    }

    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: outHeaders
    });
  } catch (err) {
    return jsonResponse({ error: `Upstream download failed: ${err.message}` }, 502);
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path.startsWith("/api/browse")) {
      try {
        const data = await browseCatalog(url.searchParams);
        return jsonResponse(data, 200);
      } catch (err) {
        return jsonResponse({ error: `Browse failed: ${err.message}` }, 502);
      }
    }

    if (path.startsWith("/api/download")) {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) {
        return jsonResponse({ error: "Missing url parameter" }, 400);
      }
      return await proxyDownload(targetUrl, request.headers);
    }

    if (path === "/" || path === "/health") {
      return jsonResponse({
        status: "ok",
        service: "SVU Player Edge Proxy",
        worker: "svu-proxy.iateam.workers.dev",
        endpoints: ["/api/browse", "/api/download"]
      });
    }

    return jsonResponse({ error: "Endpoint not found" }, 404);
  }
};
