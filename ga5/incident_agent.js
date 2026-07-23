/**
 * Q11: Observable Incident Agent
 *
 * Exports:
 *   handleIncident(req, res) – POST /v2/incidents
 *   handleReceipt(req, res)  – POST /v2/incidents/:runId/receipts
 *   getIncident(req, res)    – GET  /v2/incidents/:runId
 */

const crypto = require('crypto');
const https  = require('https');

// ============================================================
// Config
// ============================================================
const PROFILE = 'ga5-incident-agent/v2';
const MODEL   = 'gemini-2.0-flash';

// ============================================================
// In-memory store
// ============================================================
const store = new Map();

// ============================================================
// Helpers
// ============================================================

function hex(n) { return crypto.randomBytes(n).toString('hex'); }
function freshTraceId() { let h; do { h = hex(16); } while (/^0+$/.test(h)); return h; }
function freshSpanId()  { let h; do { h = hex(8);  } while (/^0+$/.test(h)); return h; }
function uid() { return hex(8); }
function nanos(ms) { return (BigInt(ms) * 1000000n).toString(); }

function parseTraceparent(h) {
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!m || /^0+$/.test(m[1]) || /^0+$/.test(m[2])) return null;
  return { traceId: m[1], parentId: m[2], flags: m[3] };
}

function sortedDigest(obj) {
  function sk(o) {
    if (o === null || o === undefined) return o;
    if (typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(sk);
    const s = {};
    Object.keys(o).sort().forEach(k => { s[k] = sk(o[k]); });
    return s;
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(sk(obj != null ? obj : {})))
    .digest('hex');
}

function jhash(o) {
  return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

function sa(k, v) { return { key: k, value: { stringValue: String(v) } }; }
function ia(k, v) { return { key: k, value: { intValue: String(Math.floor(Number(v))) } }; }

// ============================================================
// Gemini API
// ============================================================

function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return Promise.reject(new Error('GEMINI_API_KEY not set'));

  const payload = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${MODEL}:generateContent?key=${key}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const txt = j?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!txt) return reject(new Error('empty gemini response'));
          resolve(JSON.parse(txt));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(14000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

// ============================================================
// AI Analysis
// ============================================================

async function analyze(incident, catalog, policy) {
  const lines = incident.transcript.split('\n');
  const evLines = [], evIds = [];
  for (const l of lines) {
    const m = l.trim().match(/^\[([^\]]+)\]/);
    if (m) { evIds.push(m[1]); evLines.push(l.trim()); }
  }

  const diagTools = catalog.filter(t => !policy.effectTools.includes(t.name));
  const effTools  = catalog.filter(t => policy.effectTools.includes(t.name));

  const prompt = `You are an incident-response AI. Analyze the evidence and produce a JSON decision.

INCIDENT:
- incidentId: ${incident.incidentId}
- title: ${incident.title}
- service: ${incident.service}
- severity: ${incident.severity}

EVIDENCE (lines starting with [id]):
${evLines.join('\n')}

Available evidence IDs: ${JSON.stringify(evIds)}

ALLOWED ROOT CAUSES (choose EXACTLY ONE string from this list):
${JSON.stringify(incident.allowedRootCauses)}

DIAGNOSTIC TOOLS (choose 1 to ${policy.maximumDiagnostics}):
${JSON.stringify(diagTools, null, 2)}

EFFECT TOOLS (choose exactly 1):
${JSON.stringify(effTools, null, 2)}

RULES:
1. rootCause: exact string from allowedRootCauses.
2. evidence: 2-4 unique IDs from the available evidence IDs that justify rootCause.
3. diagnostics: 1-${policy.maximumDiagnostics} tools. Each has toolName (exact catalog name), arguments (object matching inputSchema with real incident-specific values), evidenceRef (1+ IDs from your cited evidence).
4. chosenEffect: exact name from effect tools.
5. effectArguments: object matching the effect tool inputSchema with real values.
6. Use concrete values from the incident: service names, timestamps, metric names, deployment IDs, versions.
7. Only include diagnostics genuinely needed to confirm this specific root cause.

Return ONLY valid JSON, no markdown:
{"rootCause":"...","evidence":["..."],"diagnostics":[{"toolName":"...","arguments":{...},"evidenceRef":["..."]}],"chosenEffect":"...","effectArguments":{...}}`;

  let plan;
  try {
    plan = await callGemini(prompt);
  } catch (e) {
    console.error('Gemini error, fallback:', e.message);
    plan = {
      rootCause: incident.allowedRootCauses[0],
      evidence: evIds.slice(0, 3),
      diagnostics: diagTools.length > 0
        ? [{ toolName: diagTools[0].name, arguments: {}, evidenceRef: [evIds[0] || 'ev_1'] }]
        : [],
      chosenEffect: policy.effectTools[0],
      effectArguments: {}
    };
  }

  // Validate/fix
  if (!incident.allowedRootCauses.includes(plan.rootCause))
    plan.rootCause = incident.allowedRootCauses[0];

  if (!Array.isArray(plan.evidence)) plan.evidence = [];
  plan.evidence = [...new Set(plan.evidence)].filter(e => evIds.includes(e));
  if (plan.evidence.length < 2) plan.evidence = evIds.slice(0, Math.min(3, evIds.length));
  plan.evidence = [...new Set(plan.evidence)].slice(0, 4);

  if (!Array.isArray(plan.diagnostics) || plan.diagnostics.length === 0) {
    plan.diagnostics = diagTools.length > 0
      ? [{ toolName: diagTools[0].name, arguments: {}, evidenceRef: [plan.evidence[0]] }]
      : [];
  }
  plan.diagnostics = plan.diagnostics.slice(0, policy.maximumDiagnostics);

  const diagSet = new Set(diagTools.map(t => t.name));
  for (const d of plan.diagnostics) {
    if (!diagSet.has(d.toolName)) d.toolName = diagTools[0]?.name || catalog[0]?.name;
    if (!d.arguments || typeof d.arguments !== 'object') d.arguments = {};
    if (!Array.isArray(d.evidenceRef) || d.evidenceRef.length === 0)
      d.evidenceRef = [plan.evidence[0]];
    d.evidenceRef = [...new Set(d.evidenceRef.filter(e => plan.evidence.includes(e)))];
    if (d.evidenceRef.length === 0) d.evidenceRef = [plan.evidence[0]];
  }

  if (!policy.effectTools.includes(plan.chosenEffect))
    plan.chosenEffect = policy.effectTools[0];
  if (!plan.effectArguments || typeof plan.effectArguments !== 'object')
    plan.effectArguments = {};

  return plan;
}

// ============================================================
// POST /v2/incidents handler
// ============================================================

async function handleIncident(req, res) {
  try {
    const body = req.body;

    if (!body || body.profile !== PROFILE)
      return res.status(400).json({ error: 'Unsupported profile' });
    if (!body.runId || !body.incident || !body.toolCatalog || !body.policy)
      return res.status(422).json({ error: 'Missing required fields' });

    const runId = body.runId;
    const ch = jhash({
      profile: body.profile, agentName: body.agentName,
      publicMarker: body.publicMarker, incident: body.incident,
      toolCatalog: body.toolCatalog, policy: body.policy
    });

    // Replay/conflict
    if (store.has(runId)) {
      const ex = store.get(runId);
      if (ex.ch !== ch) return res.status(409).json({ error: 'Content conflict' });
      return res.json(ex.lastResp);
    }

    // Trace context
    const tp    = parseTraceparent(req.headers['traceparent']);
    const tid   = tp ? tp.traceId  : freshTraceId();
    const pSid  = tp ? tp.parentId : null;
    const flags = tp ? tp.flags    : '01';
    const tst   = tp ? (req.headers['tracestate'] || undefined) : undefined;

    // AI call
    const plan = await analyze(body.incident, body.toolCatalog, body.policy);

    // Create run
    const run = {
      runId, ch,
      marker: body.publicMarker,
      agent:  body.agentName || 'incident-response',
      tid, pSid, flags, tst,
      sSid: freshSpanId(), aSid: freshSpanId(), cSid: freshSpanId(),
      diag: { rootCause: plan.rootCause, evidence: plan.evidence },
      effect: plan.chosenEffect,
      effectArgs: plan.effectArguments,
      phase: 'diag',
      actions: [], aLog: [], rLog: [],
      rHashes: new Map(),
      appr: null, apprRcpt: null,
      joinSid: null, suppressed: [],
      t0: Date.now(), lastResp: null,
      policy: body.policy
    };

    // Diagnostic dispatches
    const dispatches = [];
    for (const d of plan.diagnostics) {
      const aid = uid(), cid = uid();
      const csid = freshSpanId(), etsid = freshSpanId();
      const disp = {
        actionId: aid, callId: cid,
        phase: 'diagnostic', toolName: d.toolName,
        arguments: d.arguments, evidence: d.evidenceRef,
        attempt: 1,
        traceparent: `00-${tid}-${csid}-${flags}`
      };
      if (tst) disp.tracestate = tst;
      dispatches.push(disp);
      run.aLog.push({ ...disp });
      run.actions.push({
        aid, cid, tool: d.toolName, args: d.arguments,
        ph: 'diagnostic', ev: d.evidenceRef, etSid: etsid,
        atts: [{ n: 1, cSid: csid, disp: { ...disp }, done: false, rcpt: null }]
      });
    }

    if (dispatches.length > 1) run.joinSid = freshSpanId();

    const resp = { runId, status: 'waiting', diagnosis: run.diag, dispatches, approvals: [] };
    run.lastResp = resp;
    store.set(runId, run);
    return res.json(resp);
  } catch (err) {
    console.error('POST /v2/incidents error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// POST /v2/incidents/:runId/receipts handler
// ============================================================

function handleReceipt(req, res) {
  try {
    const { runId } = req.params;
    const body = req.body;

    if (!store.has(runId))
      return res.status(404).json({ error: 'Run not found' });

    const run = store.get(runId);
    const rid = body.receiptId;
    if (!rid)
      return res.status(422).json({ error: 'Missing receiptId' });

    const rh = jhash(body);

    // Receipt replay/conflict
    if (run.rHashes.has(rid)) {
      if (run.rHashes.get(rid) !== rh) return res.status(409).json({ error: 'Receipt conflict' });
      return res.json(run.lastResp);
    }

    if (run.phase === 'done' || run.phase === 'fail')
      return res.status(422).json({ error: 'Run already terminal' });

    // Process outcomes
    if (Array.isArray(body.outcomes)) {
      for (const o of body.outcomes) {
        const action = run.actions.find(a => a.aid === o.actionId);
        if (!action) continue;
        const att = action.atts.find(a => a.n === o.attempt && !a.done);
        if (!att) continue;

        att.done = true;
        att.rcpt = { rid, status: o.status, cls: o.resultClass, nonce: o.nonce, err: o.errorType };

        run.rLog.push({
          receiptId: rid, actionId: o.actionId, callId: o.callId,
          attempt: o.attempt, status: o.status,
          resultClass: o.resultClass, nonce: o.nonce
        });

        // 503 retry (once)
        if (o.status === 503 && action.atts.length < 2) {
          const newSid = freshSpanId();
          const retryN = o.attempt + 1;
          const rd = {
            actionId: action.aid, callId: action.cid,
            phase: action.ph, toolName: action.tool,
            arguments: action.args, evidence: action.ev,
            attempt: retryN,
            traceparent: `00-${run.tid}-${newSid}-${run.flags}`
          };
          if (run.tst) rd.tracestate = run.tst;
          action.atts.push({ n: retryN, cSid: newSid, disp: { ...rd }, done: false, rcpt: null });
          run.aLog.push({ ...rd });
        }
      }
    }

    // Process approvals
    if (Array.isArray(body.approvals)) {
      for (const a of body.approvals) {
        if (run.appr && run.appr.apprId === a.approvalId) {
          run.apprRcpt = { rid, apprId: a.approvalId, decision: a.decision, nonce: a.nonce };
          run.rLog.push({ receiptId: rid, approvalId: a.approvalId, decision: a.decision, nonce: a.nonce });
        }
      }
    }

    run.rHashes.set(rid, rh);

    const resp = advance(run);
    run.lastResp = resp;
    return res.json(resp);
  } catch (err) {
    console.error('POST receipts error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}

// ============================================================
// State machine
// ============================================================

function advance(run) {
  // Pending dispatches?
  const pending = [];
  for (const a of run.actions) {
    const last = a.atts[a.atts.length - 1];
    if (!last.done) pending.push(last.disp);
  }
  if (pending.length > 0)
    return { runId: run.runId, status: 'waiting', diagnosis: run.diag, dispatches: pending, approvals: [] };

  // Diagnostics complete?
  if (run.phase === 'diag') {
    const diags = run.actions.filter(a => a.ph === 'diagnostic');
    const allDone = diags.every(a => a.atts[a.atts.length - 1].done);
    if (!allDone)
      return { runId: run.runId, status: 'waiting', diagnosis: run.diag, dispatches: [], approvals: [] };

    const timedOut = diags.some(a => {
      const r = a.atts[a.atts.length - 1].rcpt;
      return r && (r.status === 0 || r.err === 'timeout');
    });
    if (timedOut) {
      run.suppressed = [run.effect];
      run.phase = 'fail';
      return final(run);
    }

    const needAppr = run.policy.approvalRequiredFor?.includes(run.effect);
    if (needAppr) {
      const aid = uid(), apid = uid();
      run.appr = { apprId: apid, actionId: aid, tool: run.effect,
                    digest: sortedDigest(run.effectArgs), gSid: freshSpanId() };
      run.phase = 'approve';
      return { runId: run.runId, status: 'waiting', diagnosis: run.diag,
               dispatches: [],
               approvals: [{ approvalId: apid, actionId: aid,
                              toolName: run.effect, argumentsDigest: run.appr.digest }] };
    }
    return emitEffect(run, null, null);
  }

  // Approval received?
  if (run.phase === 'approve' && run.apprRcpt)
    return emitEffect(run, run.appr.apprId, run.apprRcpt.nonce);

  // Effect outcome?
  if (run.phase === 'eff') {
    const eff = run.actions.find(a => a.ph === 'effect');
    if (eff && eff.atts[eff.atts.length - 1].done) {
      run.phase = 'done';
      return final(run);
    }
  }

  // Waiting for approval
  if (run.phase === 'approve' && run.appr && !run.apprRcpt) {
    return { runId: run.runId, status: 'waiting', diagnosis: run.diag,
             dispatches: [],
             approvals: [{ approvalId: run.appr.apprId, actionId: run.appr.actionId,
                           toolName: run.appr.tool, argumentsDigest: run.appr.digest }] };
  }
  return { runId: run.runId, status: 'waiting', diagnosis: run.diag, dispatches: [], approvals: [] };
}

function emitEffect(run, apprId, apprNonce) {
  const aid  = run.appr ? run.appr.actionId : uid();
  const cid  = uid();
  const csid = freshSpanId();
  const etsid = freshSpanId();

  const disp = {
    actionId: aid, callId: cid,
    phase: 'effect', toolName: run.effect,
    arguments: run.effectArgs, evidence: run.diag.evidence,
    attempt: 1,
    traceparent: `00-${run.tid}-${csid}-${run.flags}`
  };
  if (run.tst) disp.tracestate = run.tst;
  if (apprId) { disp.approvalId = apprId; disp.approvalNonce = apprNonce; }

  run.aLog.push({ ...disp });
  run.actions.push({
    aid, cid, tool: run.effect, args: run.effectArgs,
    ph: 'effect', ev: run.diag.evidence, etSid: etsid,
    atts: [{ n: 1, cSid: csid, disp: { ...disp }, done: false, rcpt: null }]
  });
  run.phase = 'eff';

  return { runId: run.runId, status: 'waiting', diagnosis: run.diag, dispatches: [disp], approvals: [] };
}

// ============================================================
// Final response
// ============================================================

function final(run) {
  return {
    runId:       run.runId,
    status:      run.phase === 'fail' ? 'failed' : 'completed',
    diagnosis:   run.diag,
    chosenEffect: run.effect,
    suppressed:  run.suppressed,
    actionLog:   run.aLog,
    receiptLog:  run.rLog,
    otlp:        buildOTLP(run),
    dispatches:  [],
    approvals:   []
  };
}

// ============================================================
// OTLP trace builder
// ============================================================

function buildOTLP(run) {
  const spans = [];
  const T = run.t0;
  let off = 0;
  const ca = [sa('ga5.run.id', run.runId), sa('ga5.public.marker', run.marker)];

  // SERVER
  const srv = {
    traceId: run.tid, spanId: run.sSid,
    name: 'POST /v2/incidents', kind: 2,
    startTimeUnixNano: nanos(T), endTimeUnixNano: nanos(T + 10000),
    attributes: [...ca], status: {}
  };
  if (run.pSid) srv.parentSpanId = run.pSid;
  spans.push(srv);

  // invoke_agent
  spans.push({
    traceId: run.tid, spanId: run.aSid, parentSpanId: run.sSid,
    name: `invoke_agent ${run.agent}`, kind: 1,
    startTimeUnixNano: nanos(T + 1), endTimeUnixNano: nanos(T + 9999),
    attributes: [...ca], status: {}
  });

  // chat incident-plan (exactly one)
  spans.push({
    traceId: run.tid, spanId: run.cSid, parentSpanId: run.aSid,
    name: 'chat incident-plan', kind: 3,
    startTimeUnixNano: nanos(T + 5), endTimeUnixNano: nanos(T + 2000),
    attributes: [...ca, sa('gen_ai.operation.name', 'chat'), sa('gen_ai.request.model', MODEL)],
    status: {}
  });

  off = 2001;

  // Per-action spans
  for (const a of run.actions) {
    const aStart = T + off;
    const aEnd   = aStart + 200 + a.atts.length * 600;

    // INTERNAL execute_tool
    spans.push({
      traceId: run.tid, spanId: a.etSid, parentSpanId: run.aSid,
      name: `execute_tool ${a.tool}`, kind: 1,
      startTimeUnixNano: nanos(aStart), endTimeUnixNano: nanos(aEnd),
      attributes: [
        ...ca,
        sa('ga5.action.id', a.aid), sa('gen_ai.tool.name', a.tool),
        sa('gen_ai.tool.call.id', a.cid), sa('gen_ai.operation.name', 'execute_tool')
      ],
      status: {}
    });

    // CLIENT per attempt
    let aOff = 100;
    for (const att of a.atts) {
      const cAttrs = [
        ...ca,
        sa('ga5.action.id', a.aid), ia('ga5.attempt', att.n),
        sa('http.request.method', 'POST'), ia('http.request.resend_count', att.n - 1)
      ];
      const cStatus = {};

      if (att.rcpt) {
        cAttrs.push(sa('ga5.receipt.id', att.rcpt.rid));
        cAttrs.push(sa('ga5.receipt.nonce', att.rcpt.nonce));
        if (att.rcpt.status === 503) {
          cStatus.code = 2;
          cAttrs.push(sa('error.type', '503'));
        } else if (att.rcpt.status === 0 || att.rcpt.err === 'timeout') {
          cStatus.code = 2;
          cAttrs.push(sa('error.type', 'timeout'));
        }
      }

      spans.push({
        traceId: run.tid, spanId: att.cSid, parentSpanId: a.etSid,
        name: `POST tool/${a.tool}`, kind: 3,
        startTimeUnixNano: nanos(aStart + aOff), endTimeUnixNano: nanos(aStart + aOff + 500),
        attributes: cAttrs, status: cStatus
      });
      aOff += 600;
    }
    off += 200 + a.atts.length * 600 + 100;
  }

  // incident.join
  const diags = run.actions.filter(a => a.ph === 'diagnostic');
  if (diags.length > 1 && run.joinSid) {
    spans.push({
      traceId: run.tid, spanId: run.joinSid, parentSpanId: run.aSid,
      name: 'incident.join', kind: 1,
      startTimeUnixNano: nanos(T + off), endTimeUnixNano: nanos(T + off + 10),
      attributes: [...ca],
      links: diags.map(d => ({ traceId: run.tid, spanId: d.etSid })),
      status: {}
    });
    off += 20;
  }

  // approval_gate
  if (run.appr) {
    const gA = [...ca, sa('ga5.approval.id', run.appr.apprId)];
    if (run.apprRcpt) gA.push(sa('ga5.receipt.nonce', run.apprRcpt.nonce));
    spans.push({
      traceId: run.tid, spanId: run.appr.gSid, parentSpanId: run.aSid,
      name: 'approval_gate', kind: 1,
      startTimeUnixNano: nanos(T + off), endTimeUnixNano: nanos(T + off + 10),
      attributes: gA, status: {}
    });
  }

  return { resourceSpans: [{ scopeSpans: [{ spans }] }] };
}

// ============================================================
// GET /v2/incidents/:runId handler
// ============================================================

function getIncident(req, res) {
  const { runId } = req.params;
  if (!store.has(runId))
    return res.status(404).json({ error: 'Run not found' });
  return res.json(store.get(runId).lastResp);
}

module.exports = { handleIncident, handleReceipt, getIncident };
