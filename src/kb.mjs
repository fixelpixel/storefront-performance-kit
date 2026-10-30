// Knowledge base — the part that makes this a product rather than a script.
//
// Two stores, both plain files in git so they survive any agent, any session,
// and stay reviewable in a diff:
//
//   kb/findings/<id>.json   reusable knowledge: techniques, anti-patterns,
//                           platform constraints, breakages, measurement traps
//   kb/cases/<id>.json      what we actually did at a client and what it did
//
// The loop that makes it self-improving:
//   engagement -> findings recorded -> findings injected into the diagnosis
//   prompt -> the next diagnosis starts where the last one ended.
//
// `seenAt` is the important field. A pattern hit at four clients is not the
// same claim as one somebody read on a blog, and the model is told which is
// which instead of treating all advice as equal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KB_DIR = process.env.SPEEDKIT_KB || path.join(HERE, '..', 'kb');

const FINDINGS = () => path.join(KB_DIR, 'findings');
const CASES = () => path.join(KB_DIR, 'cases');

// 'market' covers pricing, guarantees, competitor terms and positioning —
// commercial knowledge that decides how work is SOLD, not how it is done. It
// earns a slot because a wrong commercial assumption (promising a lab score,
// promising permanence) costs more than a wrong technical one.
export const CATEGORIES = ['technique', 'anti-pattern', 'platform-constraint', 'breakage', 'measurement', 'market'];
export const CONFIDENCE = ['confirmed', 'high', 'probable', 'contested'];

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (err) {
        console.error(`  (skipping malformed KB file ${f}: ${err.message})`);
        return null;
      }
    })
    .filter(Boolean);
}

export function loadFindings() {
  return readDir(FINDINGS());
}

export function loadCases() {
  return readDir(CASES());
}

export function saveFinding(finding) {
  if (!finding.id) throw new Error('finding.id is required');
  if (!CATEGORIES.includes(finding.category)) {
    throw new Error(`category must be one of: ${CATEGORIES.join(', ')}`);
  }
  if (!CONFIDENCE.includes(finding.confidence)) {
    throw new Error(`confidence must be one of: ${CONFIDENCE.join(', ')}`);
  }
  fs.mkdirSync(FINDINGS(), { recursive: true });
  const file = path.join(FINDINGS(), `${finding.id}.json`);
  const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  const merged = {
    ...existing,
    ...finding,
    // Sightings accumulate; they are the evidence that a pattern is real.
    seenAt: [...(existing?.seenAt || []), ...(finding.seenAt || [])],
    addedAt: existing?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  return merged;
}

/** Record a sighting on an existing finding — how the KB gains weight. */
export function recordSighting(id, sighting) {
  const file = path.join(FINDINGS(), `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`No finding "${id}". Add it first: speedkit kb add`);
  const finding = JSON.parse(fs.readFileSync(file, 'utf8'));
  finding.seenAt = [...(finding.seenAt || []), { at: new Date().toISOString(), ...sighting }];
  finding.updatedAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(finding, null, 2));
  return finding;
}

export function saveCase(record) {
  if (!record.id) throw new Error('case.id is required');
  fs.mkdirSync(CASES(), { recursive: true });
  const file = path.join(CASES(), `${record.id}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...record, savedAt: new Date().toISOString() }, null, 2));
  return record;
}

export function searchFindings(query) {
  if (!query) return loadFindings();
  const q = query.toLowerCase();
  return loadFindings().filter((f) =>
    [f.id, f.title, f.summary, f.detection, f.action, (f.affects || []).join(' '), f.category]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q)
  );
}

/**
 * Render the KB for injection into the diagnosis prompt.
 *
 * Ordered by how much we actually trust it: things we have seen ourselves,
 * most-seen first. Sighting counts are shown so the model can weigh a pattern
 * we have hit four times above one sourced from a blog post.
 */
export function findingsForPrompt({ limit = 40 } = {}) {
  const rank = { confirmed: 0, high: 1, probable: 2, contested: 3 };
  const findings = loadFindings()
    .sort((a, b) => {
      const seen = (b.seenAt?.length || 0) - (a.seenAt?.length || 0);
      if (seen !== 0) return seen;
      return (rank[a.confidence] ?? 9) - (rank[b.confidence] ?? 9);
    })
    .slice(0, limit);

  if (!findings.length) return null;

  return findings.map((f) => ({
    id: f.id,
    title: f.title,
    category: f.category,
    confidence: f.confidence,
    timesSeenByUs: f.seenAt?.length || 0,
    summary: f.summary,
    detection: f.detection || null,
    action: f.action || null,
    affects: f.affects || [],
    risk: f.risk || null,
  }));
}

/** Seed a case record from a finished project so outcomes are not lost. */
export function caseFromProject(project, { whatWorked = [], whatDidnt = [], incidents = [] } = {}) {
  const pageDelta = (url) => {
    const b = project.before?.pages?.[url];
    const a = project.after?.pages?.[url];
    if (!b || !a) return null;
    return {
      url,
      score: { before: b.score, after: a.score },
      lcpMs: { before: b.metrics.lcp, after: a.metrics.lcp },
      tbtMs: { before: b.metrics.tbt, after: a.metrics.tbt },
    };
  };
  return {
    id: `${project.shop.replace(/\.myshopify\.com$/, '')}-${(project.before?.capturedAt || '').slice(0, 10)}`,
    shop: project.shop,
    storefront: project.storefront,
    measurement: project.measurement,
    baselineCloaked: project.before?.cloakSuspected ?? null,
    pages: Object.keys(project.before?.pages || {}).map(pageDelta).filter(Boolean),
    changes: project.changes || [],
    whatWorked,
    whatDidnt,
    incidents,
  };
}

export function formatFindings(findings) {
  if (!findings.length) return '\n  (knowledge base is empty)\n';
  const L = [];
  const byCat = {};
  for (const f of findings) (byCat[f.category] ||= []).push(f);
  for (const cat of CATEGORIES) {
    const rows = byCat[cat];
    if (!rows?.length) continue;
    L.push(`\n▸ ${cat.toUpperCase().replace('-', ' ')}`);
    for (const f of rows.sort((a, b) => (b.seenAt?.length || 0) - (a.seenAt?.length || 0))) {
      const seen = f.seenAt?.length || 0;
      L.push(`  • ${f.title}  [${f.confidence}${seen ? ` · seen ${seen}×` : ''}]`);
      L.push(`      ${f.summary}`);
      if (f.affects?.length) L.push(`      affects: ${f.affects.join(', ')}`);
    }
  }
  return L.join('\n');
}
