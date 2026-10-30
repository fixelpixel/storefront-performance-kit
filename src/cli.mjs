#!/usr/bin/env node
// speedkit — the engagement CLI.
//
// Commands split cleanly into two groups:
//   NO ACCESS NEEDED  — audit, psi   (run these on a prospect before selling)
//   NEEDS ACCESS      — themes, backup, rollback, whoami

import './env.mjs'; // side effect: load .env before anything reads process.env
import fs from 'node:fs';
import path from 'node:path';
import { auditStorefront, formatAudit } from './audit.mjs';
import { collectEvidence } from './evidence.mjs';
import { diagnose as llmDiagnose, formatDiagnosis } from './ai.mjs';
import { getStore, listStores, normalizeShop, kitHome } from './store.mjs';
import { getShopInfo, getLiveTheme, listThemes, snapshotTheme, getAsset, putAsset, pickProductUrl } from './admin.mjs';
import {
  projectRoot,
  loadProject,
  initProject,
  recordSnapshot,
  buildComparison,
  formatComparison,
} from './project.mjs';
import { verifyCandidate, formatVerify } from './verify.mjs';
import { scanStore, aggregate, formatFleet } from './fleet.mjs';
import { renderReport, STAGES } from './report.mjs';
import {
  KB_DIR,
  CATEGORIES,
  CONFIDENCE,
  loadFindings,
  loadCases,
  searchFindings,
  recordSighting,
  saveCase,
  caseFromProject,
  formatFindings,
} from './kb.mjs';

const PROJECTS_DIR =
  process.env.SPEEDKIT_PROJECTS || path.join(process.env.HOME || '.', 'projects', 'speed-clients');

function flagValue(name, fallback = null) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
}

function requireProject(shopArg) {
  const shop = normalizeShop(shopArg);
  if (!shop) die('Pass a shop: speedkit <cmd> example.myshopify.com');
  const dir = projectRoot(PROJECTS_DIR, shop);
  const project = loadProject(dir);
  if (!project) die(`No project for ${shop}.\n  Create it:  speedkit init ${shop} --storefront https://their-domain.com`);
  return { dir, project };
}

const [, , cmd, ...args] = process.argv;
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));

function die(msg, code = 1) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(code);
}

/** Accepts "example.myshopify.com", "https://brand.com" or "brand.com". */
function toUrl(input) {
  if (!input) return null;
  if (/^https?:\/\//i.test(input)) return input;
  return `https://${input.replace(/\/$/, '')}`;
}

function requireStore(shopArg) {
  const shop = normalizeShop(shopArg);
  if (!shop) die('Pass a shop: speedkit <cmd> example.myshopify.com');
  const store = getStore(shop);
  if (!store) {
    die(
      `No access to ${shop}.\n` +
        `  Connect it:  npm run auth   → open <APP_URL>/install?shop=${shop}\n` +
        `  Or one-off:  SPEEDKIT_TOKEN=YOUR_ACCESS_TOKEN speedkit <cmd> ${shop}`
    );
  }
  return store;
}

// --- PageSpeed ------------------------------------------------------------
async function psi(url, strategy = 'mobile') {
  const key = process.env.PAGESPEED_API_KEY;
  const api =
    `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=${encodeURIComponent(url)}` +
    `&strategy=${strategy}&category=performance${key ? `&key=${key}` : ''}`;
  const res = await fetch(api);
  if (!res.ok) throw new Error(`PageSpeed API ${res.status} (rate limited? set PAGESPEED_API_KEY)`);
  const data = await res.json();
  const lh = data.lighthouseResult;
  const a = lh.audits;
  const num = (id) => a[id]?.displayValue ?? '—';
  return {
    url: lh.finalUrl || url,
    strategy,
    score: Math.round((lh.categories.performance?.score ?? 0) * 100),
    lcp: num('largest-contentful-paint'),
    tbt: num('total-blocking-time'),
    fcp: num('first-contentful-paint'),
    cls: num('cumulative-layout-shift'),
    si: num('speed-index'),
    unusedJs: a['unused-javascript']?.details?.overallSavingsBytes ?? 0,
    unusedCss: a['unused-css-rules']?.details?.overallSavingsBytes ?? 0,
  };
}

function printPsi(r) {
  const kb = (b) => (b ? `${Math.round(b / 1024)} KB` : '—');
  console.log(`\n=== PageSpeed (${r.strategy}) ${r.url} ===`);
  console.log(`  score ${r.score}   LCP ${r.lcp}   TBT ${r.tbt}   FCP ${r.fcp}   SI ${r.si}   CLS ${r.cls}`);
  console.log(`  unused JS ${kb(r.unusedJs)}   unused CSS ${kb(r.unusedCss)}`);
}

// --- commands -------------------------------------------------------------
const commands = {
  async audit() {
    const target = positional[0];
    if (!target) die('Usage: speedkit audit <example.myshopify.com | https://brand.com>');
    const url = toUrl(target);

    const report = await auditStorefront(url);
    console.log(formatAudit(report));

    if (!flags.has('--no-psi')) {
      try {
        printPsi(await psi(url, flags.has('--desktop') ? 'desktop' : 'mobile'));
      } catch (err) {
        console.log(`\n  (PageSpeed skipped: ${err.message})`);
      }
    }

    if (report.cloakSuspected) {
      console.log(
        `\n  NOTE: cloaking was detected, so the score above measures a page real\n` +
          `  shoppers never receive. Remove the cloak, re-measure, and treat THAT\n` +
          `  number as the honest baseline.`
      );
    }
    console.log('');
  },

  async psi() {
    const target = positional[0];
    if (!target) die('Usage: speedkit psi <url> [--desktop]');
    printPsi(await psi(toUrl(target), flags.has('--desktop') ? 'desktop' : 'mobile'));
    console.log('');
  },

  /**
   * The main event: deterministic evidence -> LLM diagnosis -> ranked fixes.
   * The storefront scan is best-effort; if it can't run we say so, and the
   * model is told cloaking was NOT ruled out rather than assuming it's clean.
   */
  async diagnose() {
    const target = positional[0];
    if (!target) die('Usage: speedkit diagnose <shop|url> [--runs 3] [--desktop] [--json] [--context "..."]');
    const url = toUrl(target);
    const strategy = flags.has('--desktop') ? 'desktop' : 'mobile';
    const runsIdx = args.indexOf('--runs');
    const runs = runsIdx !== -1 ? Math.max(1, Math.min(5, Number(args[runsIdx + 1]) || 1)) : 1;
    const ctxIdx = args.indexOf('--context');
    const context = ctxIdx !== -1 ? args[ctxIdx + 1] : null;

    // --save <shop>: store the diagnosis in the project dir, where `report`
    // auto-discovers it. Checked BEFORE the expensive measurement runs.
    const saveShop = flagValue('--save') ? normalizeShop(flagValue('--save')) : null;
    let saveDir = null;
    if (flagValue('--save')) {
      if (!saveShop) die('Bad --save value. Usage: --save <example.myshopify.com>');
      saveDir = projectRoot(PROJECTS_DIR, saveShop);
      if (!loadProject(saveDir)) {
        die(`No project for ${saveShop} — create it first:  speedkit init ${saveShop} --storefront ${url}`);
      }
    }

    console.error(`Collecting evidence (${strategy}, ${runs} run${runs > 1 ? 's' : ''}) …`);
    const evidence = await collectEvidence(url, { strategy, runs });

    console.error('Scanning storefront scripts …');
    let storefront = null;
    try {
      const report = await auditStorefront(url);
      if (report.ok) storefront = report;
      else console.error(`  (scan unavailable: ${report.error})`);
    } catch (err) {
      console.error(`  (scan unavailable: ${err.message})`);
    }

    console.error('Analyzing …\n');
    const result = await llmDiagnose({ evidence, storefront, context });

    if (saveDir) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(saveDir, `diagnosis-${stamp}.json`);
      fs.writeFileSync(file, JSON.stringify({ evidence, storefront, diagnosis: result }, null, 2));
      console.error(`✓ diagnosis saved: ${file}\n`);
    }

    if (flags.has('--json')) {
      console.log(JSON.stringify({ evidence, storefront, diagnosis: result }, null, 2));
    } else {
      console.log(formatDiagnosis(result, evidence));
      console.log('');
    }
  },

  /**
   * The client deliverable. Three documents, one pipeline:
   *   --stage free    lead magnet — score + ONE headline cause; withholds the plan
   *   --stage paid    extended audit — this IS the frozen BEFORE record
   *   --stage final   before → after, with compare's disclosures verbatim
   * Self-contained HTML; open in a browser and print to PDF.
   */
  async report() {
    const stage = flagValue('--stage');
    if (!STAGES.includes(stage)) die(`Usage: speedkit report <shop> --stage ${STAGES.join('|')} [--diagnosis file.json] [--out file.html]`);
    const shop = normalizeShop(positional[0]);
    if (!shop) die('Pass a shop: speedkit report example.myshopify.com --stage free|paid|final');

    const dir = projectRoot(PROJECTS_DIR, shop);
    const project = loadProject(dir);
    if (!project && stage !== 'free') {
      die(`No project for ${shop}.\n  Create it:  speedkit init ${shop} --storefront https://their-domain.com`);
    }

    // Diagnosis: an explicit --diagnosis path, or the newest diagnosis-*.json
    // in the project dir (written by `speedkit diagnose … --save <shop>`).
    let diagnosisFile = flagValue('--diagnosis');
    if (!diagnosisFile && project) {
      const candidates = fs
        .readdirSync(dir)
        .filter((f) => /^diagnosis.*\.json$/.test(f))
        .sort();
      if (candidates.length) diagnosisFile = path.join(dir, candidates[candidates.length - 1]);
    }
    let diagnosis = null;
    let evidence = null;
    if (diagnosisFile) {
      if (!fs.existsSync(diagnosisFile)) die(`Diagnosis file not found: ${diagnosisFile}`);
      const parsed = JSON.parse(fs.readFileSync(diagnosisFile, 'utf8'));
      if (parsed.diagnosis) {
        diagnosis = parsed.diagnosis;
        evidence = parsed.evidence || null;
      } else if (parsed.verdict) {
        diagnosis = parsed; // bare diagnosis object
      } else {
        die(`${diagnosisFile} is not a diagnosis (expected the output of: speedkit diagnose <url> --json)`);
      }
    }

    if ((stage === 'free' || stage === 'paid') && !diagnosis) {
      die(
        `The ${stage} report needs a diagnosis.\n` +
          `  Produce one:  speedkit diagnose <url> --runs 5 --save ${shop}\n` +
          `  Or pass one:  --diagnosis path/to/diagnosis.json`
      );
    }
    if (stage === 'free' && !evidence) {
      die('The free report also needs the evidence pack — pass the full JSON from `speedkit diagnose <url> --json`.');
    }

    const label = project?.storefront || shop;
    const html = renderReport(stage, { label, project, diagnosis, evidence });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = flagValue('--out') || path.join(project ? path.join(dir, 'reports') : '.', `${stage}-${stamp}.html`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, html);

    console.log(`\n✓ ${stage} report → ${outFile}`);
    console.log('  Self-contained HTML — open in a browser and print to PDF.');
    if (stage === 'paid') console.log('  This document is the frozen BEFORE record for the engagement.');
    console.log('');
  },

  /** Stage 0: create the engagement folder and FREEZE the measurement method. */
  async init() {
    const shop = normalizeShop(positional[0]);
    if (!shop) die('Usage: speedkit init <example.myshopify.com> --storefront https://brand.com [--url /products/x ...]');
    const storefront = (flagValue('--storefront') || `https://${shop}`).replace(/\/$/, '');
    const runs = Number(flagValue('--runs', '5')); // Google: median of 5 is 2x as stable as 1
    const strategy = flags.has('--desktop') ? 'desktop' : 'mobile';

    // The page set must represent the STORE, not one lucky page. A single
    // product page told us nothing about the homepage on a previous project.
    const extra = args.filter((a, i) => args[i - 1] === '--url');
    const urls = [storefront + '/', ...extra.map((u) => (u.startsWith('http') ? u : storefront + u))];

    if (extra.length === 0) {
      const store = getStore(shop);
      if (store) {
        const productUrl = await pickProductUrl(store, storefront.replace(/^https?:\/\//, ''));
        if (productUrl) urls.push(productUrl);
      }
    }

    const dir = projectRoot(PROJECTS_DIR, shop);
    const project = initProject(dir, { shop, storefront, urls: [...new Set(urls)], strategy, runs });
    console.log(`\n✓ project created: ${dir}`);
    console.log(`  measurement (frozen): ${strategy}, median of ${runs} runs`);
    for (const u of project.measurement.urls) console.log(`    • ${u}`);
    console.log(`\n  next: speedkit snapshot ${shop} --phase before\n`);
  },

  /** Stages 1 & 3: capture immutable evidence for the whole page set. */
  async snapshot() {
    const { dir, project } = requireProject(positional[0]);
    const phase = flagValue('--phase');
    if (!['before', 'after'].includes(phase)) die('Pass --phase before  or  --phase after');
    if (phase === 'after' && !project.before) {
      die('No BEFORE snapshot exists. Capture the baseline first, or the comparison is meaningless.');
    }

    const { urls, strategy, runs } = project.measurement;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(dir, phase === 'before' ? '01-before' : '03-after', stamp);
    fs.mkdirSync(outDir, { recursive: true });

    const pages = {};
    let cloakSuspected = false;

    for (const url of urls) {
      console.error(`  measuring ${url} (${runs} runs) …`);
      const evidence = await collectEvidence(url, { strategy, runs });
      let scan = null;
      try {
        const rep = await auditStorefront(url);
        if (rep.ok) {
          scan = rep;
          if (rep.cloakSuspected) cloakSuspected = true;
        }
      } catch {
        /* scan is best-effort */
      }
      fs.writeFileSync(
        path.join(outDir, `${encodeURIComponent(url).slice(-80)}.json`),
        JSON.stringify({ evidence, scan }, null, 2)
      );
      pages[url] = {
        score: evidence.score,
        scoreRuns: evidence.scoreRuns,
        metrics: {
          lcp: evidence.metrics.lcp.value,
          tbt: evidence.metrics.tbt.value,
          fcp: evidence.metrics.fcp.value,
          cls: evidence.metrics.cls.value,
        },
        cloakSuspected: scan?.cloakSuspected ?? null,
        duplicates: scan?.duplicates?.length ?? null,
      };
    }

    recordSnapshot(dir, project, phase, {
      capturedAt: new Date().toISOString(),
      strategy,
      runs,
      dir: outDir,
      pages,
      cloakSuspected,
    });

    console.log(`\n✓ ${phase.toUpperCase()} captured → ${outDir}`);
    for (const [url, p] of Object.entries(pages)) {
      console.log(`    ${String(p.score).padStart(3)}  ${url}   (runs ${p.scoreRuns.join('/')})`);
    }
    if (cloakSuspected) {
      console.log(
        `\n  🚨 Benchmark cloaking detected during ${phase.toUpperCase()}.` +
          `\n     This baseline is NOT honest — it measures a page shoppers never get.` +
          `\n     Remove the cloak, then treat the re-measured number as the real baseline.`
      );
    }
    console.log(
      phase === 'before'
        ? `\n  next: optimize (see RUNBOOK.md), logging each change, then --phase after\n`
        : `\n  next: speedkit compare ${project.shop}\n`
    );
  },

  async compare() {
    const { project } = requireProject(positional[0]);
    const cmp = buildComparison(project);
    console.log(formatComparison(cmp, project));
  },

  async status() {
    const { dir, project } = requireProject(positional[0]);
    console.log(`\n${project.shop}  —  phase: ${project.phase}`);
    console.log(`  dir:     ${dir}`);
    console.log(`  method:  ${project.measurement.strategy}, ${project.measurement.runs} runs`);
    console.log(`  before:  ${project.before?.capturedAt || '— not captured'}`);
    console.log(`  after:   ${project.after?.capturedAt || '— not captured'}`);
    console.log(`  changes: ${project.changes.length}`);
    for (const c of project.changes) console.log(`    · ${c.summary}`);
    console.log('');
  },

  /**
   * Scan our own fleet to build proprietary prevalence data.
   * Per-store output stays local; only the aggregate is safe to commit.
   */
  async fleet() {
    if ((positional[0] || 'scan') !== 'scan') die('Usage: speedkit fleet scan --list <file> [--concurrency 4] [--limit N]');
    const listFile = flagValue('--list');
    if (!listFile || !fs.existsSync(listFile)) {
      die('Pass --list <file> with one shop domain or storefront URL per line.');
    }
    const limit = Number(flagValue('--limit', '0'));
    const concurrency = Math.max(1, Math.min(8, Number(flagValue('--concurrency', '4'))));

    let targets = fs
      .readFileSync(listFile, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    if (limit > 0) targets = targets.slice(0, limit);

    const outDir = path.join(KB_DIR, 'fleet');
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rawFile = path.join(outDir, `raw-${stamp}.jsonl`); // gitignored
    const results = [];
    let done = 0;

    // Bounded workers — this hits real client storefronts, so stay polite.
    const queue = [...targets];
    const worker = async () => {
      while (queue.length) {
        const target = queue.shift();
        let res;
        try {
          res = await scanStore(target);
        } catch (err) {
          res = { input: target, ok: false, error: String(err.message || err) };
        }
        results.push(res);
        fs.appendFileSync(rawFile, JSON.stringify(res) + '\n');
        done += 1;
        process.stderr.write(
          `\r  ${String(done).padStart(4)}/${targets.length}  ${res.ok ? (res.cloakSuspected ? '🚨' : '✓ ') : '✗ '} ${String(res.input).slice(0, 44).padEnd(46)}`
        );
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    process.stderr.write('\n');

    const summary = aggregate(results);
    const summaryFile = path.join(outDir, `summary-${stamp}.json`);
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

    console.log(formatFleet(summary));
    console.log(`\n  aggregate (safe to commit): ${summaryFile}`);
    console.log(`  per-store (LOCAL ONLY):     ${rawFile}`);

    const cloaked = results.filter((r) => r.ok && r.cloakSuspected);
    if (cloaked.length) {
      console.log(`\n  🚨 ${cloaked.length} store(s) with a suspected cloak — these are OUR clients:`);
      for (const c of cloaked) console.log(`     ${c.url}`);
      console.log(`     Each needs the "score will drop" conversation BEFORE removal.`);
    }
    console.log('');
  },

  /** The knowledge base: what we know, and how it grows. */
  async kb() {
    const sub = positional[0] || 'list';

    if (sub === 'list' || sub === 'search') {
      const rows = searchFindings(positional[1] || null);
      console.log(`\nKnowledge base — ${rows.length} finding(s)  [${KB_DIR}]`);
      console.log(formatFindings(rows));
      console.log('');
      return;
    }

    if (sub === 'show') {
      const f = loadFindings().find((x) => x.id === positional[1]);
      if (!f) die(`No finding "${positional[1]}"`);
      console.log(JSON.stringify(f, null, 2));
      return;
    }

    if (sub === 'seen') {
      const [, id, client, note] = positional;
      if (!id || !client) die('Usage: speedkit kb seen <finding-id> <client> "<note>"');
      const f = recordSighting(id, { client, note: note || null });
      console.log(`\n✓ ${id} — now seen ${f.seenAt.length}× (${f.seenAt.map((s) => s.client).join(', ')})\n`);
      return;
    }

    if (sub === 'cases') {
      const cases = loadCases();
      console.log(`\n${cases.length} case(s):`);
      for (const c of cases) {
        const p = c.pages?.[0];
        const delta = p ? ` ${p.score.before}→${p.score.after}` : '';
        console.log(`  ${c.id}${delta}${c.baselineCloaked ? '  [cloaked baseline]' : ''}`);
      }
      console.log('');
      return;
    }

    // Turn a finished project into a permanent case record.
    if (sub === 'learn') {
      const { project } = requireProject(positional[1]);
      if (!project.before || !project.after) {
        die('Project needs both BEFORE and AFTER snapshots before it can be learned from.');
      }
      const record = saveCase(caseFromProject(project));
      console.log(`\n✓ case recorded: ${record.id}`);
      console.log(`  Now add what you learned:  speedkit kb add`);
      console.log(`  And log repeat sightings:  speedkit kb seen <finding-id> ${project.shop} "<note>"\n`);
      return;
    }

    if (sub === 'add') {
      console.log(`
Add a finding by writing a JSON file to kb/findings/<id>.json:

{
  "id": "kebab-slug",
  "title": "one line",
  "category": "${CATEGORIES.join(' | ')}",
  "confidence": "${CONFIDENCE.join(' | ')}",
  "summary": "1-3 sentences",
  "detection": "how to detect it from evidence — be concrete",
  "action": "what to do about it",
  "risk": { "level": "low|medium|high", "breaks": "what it can break" },
  "affects": ["LCP", "TBT"],
  "sources": [],
  "seenAt": [{ "client": "...", "at": "YYYY-MM-DD", "note": "what we measured" }]
}

Rules: only "confirmed" if WE measured it. Mark "contested" when practitioners
disagree. detection must be concrete enough to run against evidence.
`);
      return;
    }

    die(`Unknown: kb ${sub}. Try: list | search <q> | show <id> | seen | cases | learn <shop> | add`);
  },

  async stores() {
    const rows = listStores();
    if (!rows.length) return console.log('\nNo connected stores yet. Run: npm run auth\n');
    console.log(`\nConnected stores (${kitHome()}/stores.json):`);
    for (const r of rows) console.log(`  ${r.shop}  scope=${r.scope || '?'}  ${r.installedAt || ''}`);
    console.log('');
  },

  async whoami() {
    const store = requireStore(positional[0]);
    const info = await getShopInfo(store);
    const theme = await getLiveTheme(store);
    console.log(`\n✓ access to ${info.myshopify_domain}`);
    console.log(`  name:       ${info.name}`);
    console.log(`  plan:       ${info.plan_name}`);
    console.log(`  domain:     ${info.domain}`);
    console.log(`  live theme: ${theme.name} (id ${theme.id})`);
    console.log(`  token via:  ${store.source}\n`);
  },

  async themes() {
    const store = requireStore(positional[0]);
    const themes = await listThemes(store);
    console.log('');
    for (const t of themes) {
      console.log(`  ${t.role === 'main' ? '★ LIVE' : '      '}  ${String(t.id).padEnd(14)} ${t.name}`);
    }
    console.log('');
  },

  async verify() {
    const store = requireStore(positional[0]);
    const candidate = flagValue('--candidate') || positional[1];
    if (!candidate) {
      die(
        'Pass the theme you are about to publish:\n' +
          `  speedkit verify ${store.shop} --candidate <themeId> [--live <themeId>] [--url /path ...]`
      );
    }

    let live = flagValue('--live');
    if (!live) live = String((await getLiveTheme(store)).id);
    if (String(live) === String(candidate)) {
      die('The candidate IS the live theme — there is nothing to compare it against.');
    }

    // Storefront: the project knows it; otherwise the caller must say. The
    // myshopify domain is deliberately not a fallback — it is what real
    // shoppers never load, and on this machine it does not even resolve.
    let storefront = flagValue('--storefront');
    if (!storefront) {
      const dir = projectRoot(PROJECTS_DIR, store.shop);
      storefront = loadProject(dir)?.storefront || null;
    }
    if (!storefront) {
      die(`No storefront known for ${store.shop}.\n  Pass --storefront https://their-domain.com (or run speedkit init first).`);
    }

    const urls = [];
    for (let i = 0; i < args.length; i++) if (args[i] === '--url' && args[i + 1]) urls.push(args[i + 1]);
    if (!urls.length) urls.push('/');

    console.log(`\nRendering ${urls.length} page(s) under both themes …`);
    const result = await verifyCandidate(store, {
      storefront: toUrl(storefront),
      candidateThemeId: candidate,
      liveThemeId: live,
      urls,
    });

    if (flags.has('--json')) console.log(JSON.stringify(result, null, 2));
    else console.log(formatVerify(result));

    // Non-zero so this can gate a publish in a script, not just inform a human.
    if (result.verdict === 'BLOCK') process.exit(1);
  },

  async backup() {
    const store = requireStore(positional[0]);
    const theme = await getLiveTheme(store);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(kitHome(), 'backups', store.shop, `${stamp}_theme-${theme.id}`);
    console.log(`\nSnapshotting live theme "${theme.name}" (${theme.id}) …`);
    const out = await snapshotTheme(store, theme.id, dest, {
      onProgress: (done, total, key) => {
        process.stdout.write(`\r  ${String(done).padStart(3)}/${total}  ${key.slice(0, 50).padEnd(52)}`);
      },
    });
    console.log(`\n\n✓ ${out.total} files → ${dest}\n`);
  },

  async rollback() {
    const [shopArg, assetKey, backupFile] = positional;
    if (!shopArg || !assetKey || !backupFile) {
      die('Usage: speedkit rollback <shop> <assets/file.liquid> <path/to/backup/file>');
    }
    const store = requireStore(shopArg);
    if (!fs.existsSync(backupFile)) die(`Backup not found: ${backupFile}`);
    const theme = await getLiveTheme(store);
    const value = fs.readFileSync(backupFile, 'utf8');
    const current = await getAsset(store, theme.id, assetKey).catch(() => null);
    console.log(`\nRestoring ${assetKey} on live theme ${theme.id} from ${backupFile}`);
    console.log(`  current: ${current?.value?.length ?? '?'} bytes → backup: ${value.length} bytes`);
    if (!flags.has('--yes')) die('Add --yes to confirm this live write.', 0);
    await putAsset(store, theme.id, assetKey, value, { backupPath: backupFile });
    console.log(`✓ restored\n`);
  },

  help() {
    console.log(`
shopify-speed-kit — speed engagements without the access scramble

  ENGAGEMENT PIPELINE (the 3 stages — read RUNBOOK.md)
    speedkit init <shop> --storefront https://brand.com [--url /path ...] [--runs 3]
        Create the client project and FREEZE the measurement method.
    speedkit snapshot <shop> --phase before     ← stage 1, immutable baseline
    speedkit verify <shop> --candidate <themeId> [--url /path ...]
        ★ PRE-PUBLISH GATE. Run this before you publish, every time.
        Diffs the candidate against the LIVE theme and blocks on the regressions
        PageSpeed cannot see: app embeds silently disabled, CSS lost to the
        inline_asset_content size cap, Liquid errors, un-resized srcset
        candidates. Exits 1 on BLOCK so it can gate a script.
    speedkit snapshot <shop> --phase after      ← stage 3
    speedkit compare <shop>                     before → after, with disclosures
    speedkit status <shop>                      where this project stands

  CLIENT DELIVERABLES (self-contained HTML, print to PDF)
    speedkit report <shop> --stage free|paid|final [--diagnosis f.json] [--out f.html]
        free  = lead magnet: score + the ONE headline cause (withholds the plan)
        paid  = extended audit; this IS the frozen BEFORE record
        final = before → after with compare's disclosures carried verbatim
        Disclosures (cloaked baseline, low run count) are injected automatically.

  NO ACCESS NEEDED (works on any public storefront)
    speedkit diagnose <shop|url> [--runs 3] [--desktop] [--json] [--context "..."]
        ★ AI diagnosis. Full Lighthouse + script scan -> ranked root causes,
        what to RULE OUT, prioritized fixes with risk/effort/QA. --runs 3
        takes the median (a single lab run swings ±8 points).
        --save <shop> stores the diagnosis in the project dir for 'report'.
    speedkit audit <shop|url> [--desktop] [--no-psi]
        Deterministic scan only: duplicate script loads, obfuscated/test-gated
        scripts (benchmark cloaking), render-blocking count + PageSpeed.
    speedkit psi <url> [--desktop]

  NEEDS ACCESS (connect once: npm run auth)
    speedkit stores                     list connected stores
    speedkit whoami <shop>              verify access + show live theme
    speedkit themes <shop>              list themes
    speedkit backup <shop>              snapshot live theme to disk
    speedkit rollback <shop> <key> <file> --yes

  FLEET (our own proprietary prevalence data)
    speedkit fleet scan --list <file> [--concurrency 4] [--limit N]
        Scan every storefront we have, aggregate what's actually wrong out
        there. Per-store output stays local; only aggregates are committed.

  KNOWLEDGE BASE (grows with every engagement; feeds the AI diagnosis)
    speedkit kb list | search <q> | show <id>
    speedkit kb seen <finding-id> <client> "<note>"   log a repeat sighting
    speedkit kb learn <shop>                          finished project -> case
    speedkit kb cases | add

  Tokens: ~/.shopify-speed-kit/stores.json (chmod 600), or SPEEDKIT_TOKEN env.
  Live writes always require an existing backup — by design.
`);
  },
};

const run = commands[cmd] || commands.help;
// Promise.resolve: help() is sync; calling .catch on undefined crashed every
// `speedkit help` with exit 1 (pre-existing, found while adding `report`).
Promise.resolve(run()).catch((err) => die(err.message));
