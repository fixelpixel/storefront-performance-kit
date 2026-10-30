// LLM layer. OpenRouter by default, but the endpoint is any OpenAI-compatible
// /chat/completions — so the same code points at OpenAI, a local vLLM, or a
// gateway without edits.
//
// The model DIAGNOSES. It never writes to a store: its output is a proposal a
// human approves, and the writing is done by the deterministic layer that
// enforces backups. Keep that boundary.

import { SYSTEM_PROMPT, buildUserMessage } from './prompt.mjs';
import { findingsForPrompt } from './kb.mjs';

const DEFAULT_BASE = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
// Model slugs change; override with OPENROUTER_MODEL / LLM_MODEL.
// Browse current slugs at https://openrouter.ai/models
const DEFAULT_MODEL = process.env.LLM_MODEL || process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5';

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY || process.env.LLM_API_KEY;
  if (!key) {
    throw new Error(
      'No LLM key. Set OPENROUTER_API_KEY (get one at https://openrouter.ai/keys),\n' +
        '  or point LLM_BASE_URL + LLM_API_KEY at any OpenAI-compatible endpoint.'
    );
  }
  return key;
}

/** Pull the first JSON object out of a response that may be fenced or prefixed. */
function parseJsonLoose(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw new Error('Model did not return parseable JSON');
  }
}

const REQUIRED = ['verdict', 'rootCauses', 'fixes'];

function validate(result) {
  const missing = REQUIRED.filter((k) => result[k] === undefined);
  if (missing.length) throw new Error(`Model output missing: ${missing.join(', ')}`);
  result.ruledOut ??= [];
  result.doNotDo ??= [];
  result.openQuestions ??= [];
  result.baselineTrustworthy ??= true;
  result.baselineWarning ??= null;
  result.clientSummary ??= '';
  return result;
}

export async function diagnose({
  evidence,
  storefront,
  context,
  knowledgeBase = findingsForPrompt(),
  model = DEFAULT_MODEL,
  timeoutMs = 180000,
}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${DEFAULT_BASE}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        'Content-Type': 'application/json',
        'X-Title': 'shopify-speed-kit',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage({ evidence, storefront, context, knowledgeBase }) },
        ],
      }),
    });

    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 400);
      try {
        detail = JSON.parse(text)?.error?.message || detail;
      } catch {
        /* keep raw */
      }
      const hint = /model/i.test(detail)
        ? `\n  (model slug "${model}" may be wrong — see https://openrouter.ai/models, then set LLM_MODEL)`
        : '';
      throw new Error(`LLM API ${res.status}: ${detail}${hint}`);
    }

    const body = JSON.parse(text);
    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned an empty message');
    const result = validate(parseJsonLoose(content));
    result._meta = { model: body.model || model, usage: body.usage || null };
    return result;
  } finally {
    clearTimeout(timer);
  }
}

// --- rendering ------------------------------------------------------------

const CONF = { confirmed: '●●●', high: '●●○', probable: '●○○', possible: '○○○' };

export function formatDiagnosis(d, evidence) {
  const L = [];
  const rule = (t) => `\n${'─'.repeat(72)}\n${t}\n${'─'.repeat(72)}`;

  L.push(rule(`DIAGNOSIS  ${evidence.url}  (${evidence.strategy})`));
  L.push(`score ${evidence.score}${evidence.scoreRuns.length > 1 ? ` (runs: ${evidence.scoreRuns.join(', ')} — median)` : ' (single run)'}`);
  const m = evidence.metrics;
  L.push(`LCP ${m.lcp.display}   TBT ${m.tbt.display}   FCP ${m.fcp.display}   CLS ${m.cls.display}   SI ${m.speedIndex.display}`);

  if (!d.baselineTrustworthy) {
    L.push(`\n🚨 BASELINE NOT TRUSTWORTHY`);
    if (d.baselineWarning) L.push(`   ${d.baselineWarning}`);
  }

  L.push(`\n▸ VERDICT\n  ${d.verdict.replace(/\n/g, '\n  ')}`);

  if (d.ruledOut.length) {
    L.push(`\n▸ RULED OUT (do not spend time here)`);
    for (const r of d.ruledOut) L.push(`  ✗ ${r.cause}\n      ${r.evidence}`);
  }

  if (d.rootCauses.length) {
    L.push(`\n▸ ROOT CAUSES`);
    for (const c of [...d.rootCauses].sort((a, b) => a.rank - b.rank)) {
      L.push(`  ${c.rank}. [${CONF[c.confidence] || '???'} ${c.confidence}] ${c.cause}`);
      L.push(`      affects: ${(c.affects || []).join(', ') || '—'}`);
      L.push(`      evidence: ${c.evidence}`);
    }
  }

  if (d.fixes.length) {
    L.push(`\n▸ FIXES (ranked)`);
    for (const f of [...d.fixes].sort((a, b) => a.rank - b.rank)) {
      const qa = (f.requiresQA || []).filter((q) => q && q !== 'none');
      L.push(`  ${f.rank}. ${f.title}   [effort ${f.effort} · risk ${f.risk}${f.reversible === false ? ' · NOT reversible' : ''}]`);
      L.push(`      what:  ${f.what}`);
      L.push(`      where: ${f.where}`);
      if (f.mechanism) L.push(`      why:   ${f.mechanism}`);
      if (qa.length) L.push(`      ⚠ QA:  ${qa.join(', ')}`);
    }
  }

  if (d.doNotDo.length) {
    L.push(`\n▸ DO NOT`);
    for (const x of d.doNotDo) L.push(`  • ${x}`);
  }

  if (d.openQuestions.length) {
    L.push(`\n▸ OPEN QUESTIONS`);
    for (const q of d.openQuestions) L.push(`  ? ${q}`);
  }

  if (d.matchedFindings?.length) {
    L.push(`\n▸ KNOWN PATTERNS MATCHED (from our past engagements)`);
    for (const f of d.matchedFindings) L.push(`  ✓ ${f.id}\n      ${f.why}`);
  }

  if (d.newPattern) {
    L.push(`\n▸ NEW PATTERN — not yet in the knowledge base`);
    L.push(`  ${d.newPattern}`);
    L.push(`  → record it:  speedkit kb add`);
  }

  if (d.clientSummary) L.push(`\n▸ FOR THE CLIENT\n  ${d.clientSummary}`);

  if (d._meta) {
    const u = d._meta.usage;
    L.push(`\n(model: ${d._meta.model}${u ? ` · ${u.total_tokens} tokens` : ''})`);
  }
  return L.join('\n');
}
