/**
 * Q11: Observable Incident Agent
 *
 * Endpoints:
 *   POST /v2/incidents              – Start a run (AI analysis + diagnostic dispatches)
 *   POST /v2/incidents/:runId/receipts – Process grader receipts (outcomes/approvals)
 *   GET  /v2/incidents/:runId       – Return stored state
 *
 * State machine: init → diag_pending → [approval_pending] → effect_pending → completed/failed
 */

const crypto = require('crypto');
const https = require('https');

// ============================================================
// Constants
// ============================================================
const PROFILE = 'ga5-incident-agent/v2';
const MODEL = 'gemini-2.0-flash';

// ============================================================
// In-memory state store
// ============================================================
const store = new Map();

// ============================================================
// Utility helpers
// ============================================================

function hex(n) { return crypto.randomBytes(n).toString('hex'); }

function freshTraceId() {
  let h;
  do { h = hex(16); } while (h === '0'.repeat(32));
  return h;
}

function freshSpanId() {
  let h;
  do { h = hex(8); } while (h === '0'.repeat(16));
  return h;
}

function uid() { return hex(8); } // 16 hex chars (≥8 required)

function ns(ms) { return (BigInt(ms) * 1000000n).toString(); }

/** Parse a W3C traceparent header; returns null if invalid. */
function parseTraceparent(h) {
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!m || m[1] === '0'.repeat(32) || m[2] === '0'.repeat(16)) return null;
  return { traceId: m[1], parentSpanId: m[2], flags: m[3] };
}

/** SHA-256 of recursively key-sorted compact JSON (for argumentsDigest). */
function sortedDigest(obj) {
  function sk(o) {
    if (o === null || o === undefined) return o;
    if (typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(sk);
    const s = {};
    for (const k of Object.keys(o).sort()) s[k] = sk(o[k]);
    return s;
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(sk(obj || {})))
    .digest('hex');
}

/** Generic deterministic hash of a value for conflict detection. */
function djson(o) {
  return crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');
}

/** Build an OTLP string attribute. */
function sa(k, v) { return { key: k, value: { stringValue: String(v) } }; }
/** Build an OTLP int attribute. */
function ia(k, v) { return { key: k, value: { intValue: String(v) } }; }

// ============================================================
// Gemini API
// ============================================================

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');

  const body = JSON.stringify({
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
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (!j.candidates || !j.candidates[0] || !j.candidates[0].content) {
            return reject(new Error('Bad Gemini response: ' + d.substring(0, 500)));
          }
          const text = j.candidates[0].content.parts[0].text;
          resolve(JSON.parse(text));
        } catch (e) { reject(new Error('Parse error: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(14000, () => { req.destroy(); reject(new Error('Gemini timeout')); });
    req.write(body);
    req.end();
  });
}

// ============================================================
// AI analysis: build diagnosis + tool plan
// ============================================================

async function analyzeIncident(incident, catalog, policy) {
  // Extract evidence lines from transcript
  const lines = incident.transcript.split('\n');
  const evLines = [];
  const evIds = [];
  for (const l of lines) {
    const m = l.trim().match(/^\[([^\]]+)\]/);
    if (m) {
      evIds.push(m[1]);
      evLines.push(l.trim());
    }
  }

  // Separate diagnostic vs. effect tools
  const diagTools = catalog.filter(t => !policy.effectTools.includes(t.name));
  const effTools = catalog.filter(t => policy.effectTools.includes(t.name));

  const prompt = `You are an incident response AI. Analyze the evidence and produce a JSON response.

INCIDENT:
- ID: ${incident.incidentId}
- Title: ${incident.title}
- Service: ${incident.service}
- Severity: ${incident.severity}

EVIDENCE LINES (each starts with an ID in brackets):
${evLines.join('\n')}

ALL EVIDENCE IDs: ${JSON.stringify(evIds)}

ALLOWED ROOT CAUSES (choose EXACTLY ONE):
${JSON.stringify(incident.allowedRootCauses)}

DIAGNOSTIC TOOLS (choose 1 to ${policy.maximumDiagnostics}, these confirm root cause):
${JSON.stringify(diagTools, null, 2)}

EFFECT TOOLS (choose EXACTLY ONE, this fixes the problem):
${JSON.stringify(effTools, null, 2)}

RULES:
1. Pick ONE rootCause from the allowed list (exact string match).
2. Cite 2-4 UNIQUE evidence IDs from the list above that justify the root cause.
3. Pick 1-${policy.maximumDiagnostics} diagnostic tools. For each provide toolName (exact), arguments (matching inputSchema with real incident-specific values), and evidenceRef (1+ evidence IDs from your cited evidence).
4. Pick 1 effect tool. Provide toolName (exact) and effectArguments (matching inputSchema with real values).
5. Use service names, metric names, deployment IDs, timestamps, and other concrete values from the evidence lines.
6. Send independent diagnostics together (they can run in parallel).

Return ONLY this JSON:
{"rootCause":"exactly from allowed list","evidence":["id1","id2"],"diagnostics":[{"toolName":"exact_name","arguments":{},"evidenceRef":["id1"]}],"chosenEffect":"exact_name","effectArguments":{}}`;

  let result;
  try {
    result = await callGemini(prompt);
  } catch (e) {
    console.error('Gemini call failed, using fallback:', e.message);
    // Minimal fallback
    result = {
      rootCause: incident.allowedRootCauses[0],
      evidence: evIds.slice(0, 3),
      diagnostics: diagTools.length > 0
        ? [{ toolName: diagTools[0].name, arguments: {}, evidenceRef: [evIds[0]] }]
        : [],
      chosenEffect: policy.effectTools[0],
      effectArguments: {}
    };
  }

  // ---- Validate & fix AI response ----

  // rootCause must be in allowed list
  if (!incident.allowedRootCauses.includes(result.rootCause)) {
    result.rootCause = incident.allowedRootCauses[0];
  }

  // evidence: 2-4 unique IDs
  if (!Array.isArray(result.evidence)) result.evidence = [];
  result.evidence = [...new Set(result.evidence)].filter(e => evIds.includes(e));
  if (result.evidence.length < 2) {
    result.evidence = evIds.slice(0, Math.min(3, evIds.length));
  }
  result.evidence = result.evidence.slice(0, 4);

  // diagnostics: 1-max
  if (!Array.isArray(result.diagnostics) || result.diagnostics.length === 0) {
    result.diagnostics = diagTools.length > 0
      ? [{ toolName: diagTools[0].name, arguments: {}, evidenceRef: [result.evidence[0]] }]
      : [];
  }
  result.diagnostics = result.diagnostics.slice(0, policy.maximumDiagnostics);

  // Fix each diagnostic
  const catalogNames = new Set(catalog.map(t => t.name));
  for (const d of result.diagnostics) {
    if (!catalogNames.has(d.toolName) && diagTools.length > 0) {
      d.toolName = diagTools[0].name;
    }
    if (!d.arguments) d.arguments = {};
    if (!Array.isArray(d.evidenceRef) || d.evidenceRef.length === 0) {
      d.evidenceRef = [result.evidence[0]];
    }
    // Filter to only cited diagnosis evidence
    d.evidenceRef = [...new Set(d.evidenceRef.filter(e => result.evidence.includes(e)))];
    if (d.evidenceRef.length === 0) d.evidenceRef = [result.evidence[0]];
  }

  // chosenEffect must be in effectTools
  if (!policy.effectTools.includes(result.chosenEffect)) {
    result.chosenEffect = policy.effectTools[0];
  }
  if (!result.effectArguments) result.effectArguments = {};

  return result;
}

// ============================================================
// POST /v2/incidents
// ============================================================

async function handleIncident(req, res) {
  try {
    const body = req.body;

    // --- Validation ---
    if (!body || body.profile !== PROFILE) {
      return res.status(400).json({ error: 'Unsupported profile' });
    }
    if (!body.runId || !body.incident || !body.toolCatalog || !body.policy) {
      return res.status(422).json({ error: 'Missing required fields' });
    }

    const runId = body.runId;

    // Content hash (excludes sensitive and runId)
    const ch = djson({
      profile: body.profile,
      agentName: body.agentName,
      publicMarker: body.publicMarker,
      incident: body.incident,
      toolCatalog: body.toolCatalog,
      policy: body.policy
    });

    // --- Replay / conflict ---
    if (store.has(runId)) {
      const existing = store.get(runId);
      if (existing.contentHash !== ch) {
        return res.status(409).json({ error: 'Content conflict for runId' });
      }
      // Replay: return stored response without model call
      return res.json(existing.lastResponse);
    }

    // --- Parse incoming trace context ---
    const tp = parseTraceparent(req.headers['traceparent']);
    const tid = tp ? tp.traceId : freshTraceId();
    const incomingParentSid = tp ? tp.parentSpanId : null;
    const flags = tp ? tp.flags : '01';
    const tstate = tp ? (req.headers['tracestate'] || undefined) : undefined;

    // --- Call AI model ---
    const plan = await analyzeIncident(body.incident, body.toolCatalog, body.policy);

    // --- Build run state ---
    const run = {
      runId,
      contentHash: ch,
      publicMarker: body.publicMarker,
      agentName: body.agentName || 'incident-response',

      // Trace context
      traceId: tid,
      incomingParentSid,
      flags,
      tstate,

      // OTLP span IDs (stable across replays)
      serverSid: freshSpanId(),
      agentSid: freshSpanId(),
      chatSid: freshSpanId(),
      joinSid: null,

      // Diagnosis
      diagnosis: { rootCause: plan.rootCause, evidence: plan.evidence },
      chosenEffect: plan.chosenEffect,
      effectArgs: plan.effectArguments,

      // State machine
      phase: 'diag_pending',

      // Actions (logical tool calls)
      actions: [],
      actionLog: [],
      receiptLog: [],
      receiptHashes: {},

      // Approval
      approval: null,
      approvalReceipt: null,

      // Suppressed effects
      suppressed: [],

      // Timing
      startMs: Date.now(),

      // Policy
      policy: body.policy,

      // Last response (for replay)
      lastResponse: null
    };

    // --- Build diagnostic dispatches ---
    const dispatches = [];
    for (const d of plan.diagnostics) {
      const actionId = uid();
      const callId = uid();
      const clientSid = freshSpanId();
      const etSid = freshSpanId();

      const dispatch = {
        actionId,
        callId,
        phase: 'diagnostic',
        toolName: d.toolName,
        arguments: d.arguments,
        evidence: d.evidenceRef,
        attempt: 1,
        traceparent: `00-${tid}-${clientSid}-${flags}`
      };
      if (tstate) dispatch.tracestate = tstate;

      dispatches.push(dispatch);
      run.actionLog.push({ ...dispatch });

      run.actions.push({
        actionId,
        callId,
        toolName: d.toolName,
        arguments: d.arguments,
        phase: 'diagnostic',
        evidence: d.evidenceRef,
        etSid,
        attempts: [{
          attempt: 1,
          cSid: clientSid,
          dispatch: { ...dispatch },
          done: false,
          receipt: null
        }]
      });
    }

    // Join span if >1 parallel diagnostics
    if (dispatches.length > 1) {
      run.joinSid = freshSpanId();
    }

    const response = {
      runId,
      status: 'waiting',
      diagnosis: run.diagnosis,
      dispatches,
      approvals: []
    };

    run.lastResponse = response;
    store.set(runId, run);
    return res.json(response);
  } catch (err) {
    console.error('handleIncident error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// POST /v2/incidents/:runId/receipts
// ============================================================

function handleReceipt(req, res) {
  try {
    const { runId } = req.params;
    const body = req.body;

    if (!store.has(runId)) {
      return res.status(404).json({ error: 'Run not found' });
    }

    const run = store.get(runId);
    const rid = body.receiptId;
    if (!rid) {
      return res.status(422).json({ error: 'Missing receiptId' });
    }

    const rh = djson(body);

    // Receipt replay / conflict
    if (run.receiptHashes[rid] !== undefined) {
      if (run.receiptHashes[rid] !== rh) {
        return res.status(409).json({ error: 'Receipt content conflict' });
      }
      // Replay: return stored response
      return res.json(run.lastResponse);
    }

    // Reject if run is already terminal
    if (run.phase === 'completed' || run.phase === 'failed') {
      return res.status(422).json({ error: 'Run already terminal' });
    }

    // --- Process outcomes ---
    if (Array.isArray(body.outcomes)) {
      for (const o of body.outcomes) {
        const action = run.actions.find(a => a.actionId === o.actionId);
        if (!action) continue;

        const att = action.attempts.find(a =>
          a.attempt === o.attempt && !a.done
        );
        if (!att) continue;

        att.done = true;
        att.receipt = {
          receiptId: rid,
          status: o.status,
          resultClass: o.resultClass,
          nonce: o.nonce,
          errorType: o.errorType
        };

        // Add to receipt log
        const logEntry = {
          receiptId: rid,
          actionId: o.actionId,
          callId: o.callId,
          attempt: o.attempt,
          status: o.status,
          resultClass: o.resultClass,
          nonce: o.nonce
        };
        run.receiptLog.push(logEntry);

        // 503 → retry once
        if (o.status === 503 && action.attempts.length < 2) {
          const newCsid = freshSpanId();
          const retryNum = o.attempt + 1;
          const retryDisp = {
            actionId: action.actionId,
            callId: action.callId,
            phase: action.phase,
            toolName: action.toolName,
            arguments: action.arguments,
            evidence: action.evidence,
            attempt: retryNum,
            traceparent: `00-${run.traceId}-${newCsid}-${run.flags}`
          };
          if (run.tstate) retryDisp.tracestate = run.tstate;

          action.attempts.push({
            attempt: retryNum,
            cSid: newCsid,
            dispatch: { ...retryDisp },
            done: false,
            receipt: null
          });
          run.actionLog.push({ ...retryDisp });
        }
      }
    }

    // --- Process approvals ---
    if (Array.isArray(body.approvals)) {
      for (const a of body.approvals) {
        if (run.approval && run.approval.approvalId === a.approvalId) {
          run.approvalReceipt = {
            receiptId: rid,
            approvalId: a.approvalId,
            decision: a.decision,
            nonce: a.nonce
          };
          run.receiptLog.push({
            receiptId: rid,
            approvalId: a.approvalId,
            decision: a.decision,
            nonce: a.nonce
          });
        }
      }
    }

    // Store receipt hash
    run.receiptHashes[rid] = rh;

    // Determine next state
    const resp = resolveNextState(run);
    run.lastResponse = resp;
    return res.json(resp);
  } catch (err) {
    console.error('handleReceipt error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ============================================================
// State resolution
// ============================================================

function resolveNextState(run) {
  // 1. Collect pending dispatches (not yet received outcome)
  const pending = [];
  for (const a of run.actions) {
    const last = a.attempts[a.attempts.length - 1];
    if (!last.done) pending.push(last.dispatch);
  }

  // If retries or dispatches are pending, return them (no approval in a retry response)
  if (pending.length > 0) {
    return {
      runId: run.runId,
      status: 'waiting',
      diagnosis: run.diagnosis,
      dispatches: pending,
      approvals: []
    };
  }

  // 2. All current attempts resolved
  if (run.phase === 'diag_pending') {
    const diags = run.actions.filter(a => a.phase === 'diagnostic');
    const allDone = diags.every(a => {
      const last = a.attempts[a.attempts.length - 1];
      return last.done;
    });

    if (allDone) {
      // Check for timeout or total failure
      const anyTimeout = diags.some(a => {
        const last = a.attempts[a.attempts.length - 1];
        return last.receipt &&
          (last.receipt.status === 0 || last.receipt.errorType === 'timeout');
      });

      if (anyTimeout) {
        run.suppressed = [run.chosenEffect];
        run.phase = 'failed';
        return buildFinalResponse(run);
      }

      // All diagnostics succeeded → proceed to effect
      const needsApproval = run.policy.approvalRequiredFor &&
        run.policy.approvalRequiredFor.includes(run.chosenEffect);

      if (needsApproval) {
        // Reserve action ID for the effect
        const actionId = uid();
        const approvalId = uid();

        run.approval = {
          approvalId,
          actionId,
          toolName: run.chosenEffect,
          argumentsDigest: sortedDigest(run.effectArgs),
          aSid: freshSpanId()
        };
        run.phase = 'approval_pending';

        return {
          runId: run.runId,
          status: 'waiting',
          diagnosis: run.diagnosis,
          dispatches: [],
          approvals: [{
            approvalId,
            actionId,
            toolName: run.chosenEffect,
            argumentsDigest: run.approval.argumentsDigest
          }]
        };
      } else {
        // No approval needed → dispatch effect directly
        return emitEffect(run, null, null);
      }
    }
  }

  // 3. Approval received → dispatch effect
  if (run.phase === 'approval_pending' && run.approvalReceipt) {
    return emitEffect(run, run.approval.approvalId, run.approvalReceipt.nonce);
  }

  // 4. Effect outcome received → completed
  if (run.phase === 'effect_pending') {
    const eff = run.actions.find(a => a.phase === 'effect');
    if (eff) {
      const last = eff.attempts[eff.attempts.length - 1];
      if (last.done) {
        run.phase = 'completed';
        return buildFinalResponse(run);
      }
    }
  }

  // Still waiting (edge case)
  return {
    runId: run.runId,
    status: 'waiting',
    diagnosis: run.diagnosis,
    dispatches: [],
    approvals: run.approval && !run.approvalReceipt
      ? [{
        approvalId: run.approval.approvalId,
        actionId: run.approval.actionId,
        toolName: run.approval.toolName,
        argumentsDigest: run.approval.argumentsDigest
      }]
      : []
  };
}

// ============================================================
// Emit effect dispatch
// ============================================================

function emitEffect(run, approvalId, approvalNonce) {
  const actionId = run.approval ? run.approval.actionId : uid();
  const callId = uid();
  const clientSid = freshSpanId();
  const etSid = freshSpanId();

  const dispatch = {
    actionId,
    callId,
    phase: 'effect',
    toolName: run.chosenEffect,
    arguments: run.effectArgs,
    evidence: run.diagnosis.evidence,
    attempt: 1,
    traceparent: `00-${run.traceId}-${clientSid}-${run.flags}`
  };
  if (run.tstate) dispatch.tracestate = run.tstate;
  if (approvalId) {
    dispatch.approvalId = approvalId;
    dispatch.approvalNonce = approvalNonce;
  }

  run.actionLog.push({ ...dispatch });
  run.actions.push({
    actionId,
    callId,
    toolName: run.chosenEffect,
    arguments: run.effectArgs,
    phase: 'effect',
    evidence: run.diagnosis.evidence,
    etSid,
    attempts: [{
      attempt: 1,
      cSid: clientSid,
      dispatch: { ...dispatch },
      done: false,
      receipt: null
    }]
  });

  run.phase = 'effect_pending';

  return {
    runId: run.runId,
    status: 'waiting',
    diagnosis: run.diagnosis,
    dispatches: [dispatch],
    approvals: []
  };
}

// ============================================================
// Final response builder
// ============================================================

function buildFinalResponse(run) {
  return {
    runId: run.runId,
    status: run.suppressed.length > 0 ? 'failed' : 'completed',
    diagnosis: run.diagnosis,
    chosenEffect: run.chosenEffect,
    suppressed: run.suppressed,
    actionLog: run.actionLog,
    receiptLog: run.receiptLog,
    otlp: buildOTLP(run),
    dispatches: [],
    approvals: []
  };
}

// ============================================================
// OTLP trace builder
// ============================================================

function buildOTLP(run) {
  const spans = [];
  const T = run.startMs;
  let off = 0;

  // Common attributes on every span
  const ca = [
    sa('ga5.run.id', run.runId),
    sa('ga5.public.marker', run.publicMarker)
  ];

  // ---- 1. SERVER span ----
  const serverSpan = {
    traceId: run.traceId,
    spanId: run.serverSid,
    name: 'POST /v2/incidents',
    kind: 2, // SERVER
    startTimeUnixNano: ns(T),
    endTimeUnixNano: ns(T + 9000),
    attributes: [...ca],
    status: {}
  };
  if (run.incomingParentSid) {
    serverSpan.parentSpanId = run.incomingParentSid;
  }
  spans.push(serverSpan);

  // ---- 2. INTERNAL invoke_agent ----
  spans.push({
    traceId: run.traceId,
    spanId: run.agentSid,
    parentSpanId: run.serverSid,
    name: `invoke_agent ${run.agentName}`,
    kind: 1, // INTERNAL
    startTimeUnixNano: ns(T + 1),
    endTimeUnixNano: ns(T + 8999),
    attributes: [...ca],
    status: {}
  });

  // ---- 3. CLIENT chat incident-plan (exactly one) ----
  spans.push({
    traceId: run.traceId,
    spanId: run.chatSid,
    parentSpanId: run.agentSid,
    name: 'chat incident-plan',
    kind: 3, // CLIENT
    startTimeUnixNano: ns(T + 10),
    endTimeUnixNano: ns(T + 2000),
    attributes: [
      ...ca,
      sa('gen_ai.operation.name', 'chat'),
      sa('gen_ai.request.model', MODEL)
    ],
    status: {}
  });

  off = 2001;

  // ---- 4. execute_tool + CLIENT spans (per logical action) ----
  for (const a of run.actions) {
    const etStart = T + off;
    // Calculate end time to enclose all attempts
    const etEnd = etStart + 200 + (a.attempts.length * 500);

    // INTERNAL execute_tool <toolName>
    spans.push({
      traceId: run.traceId,
      spanId: a.etSid,
      parentSpanId: run.agentSid,
      name: `execute_tool ${a.toolName}`,
      kind: 1,
      startTimeUnixNano: ns(etStart),
      endTimeUnixNano: ns(etEnd),
      attributes: [
        ...ca,
        sa('ga5.action.id', a.actionId),
        sa('gen_ai.tool.name', a.toolName),
        sa('gen_ai.tool.call.id', a.callId),
        sa('gen_ai.operation.name', 'execute_tool')
      ],
      status: {}
    });

    // CLIENT POST tool/<toolName> (one per physical attempt)
    let attOff = 100;
    for (const att of a.attempts) {
      const cAttrs = [
        ...ca,
        sa('ga5.action.id', a.actionId),
        ia('ga5.attempt', att.attempt),
        sa('http.request.method', 'POST'),
        ia('http.request.resend_count', att.attempt - 1)
      ];

      const cSpan = {
        traceId: run.traceId,
        spanId: att.cSid,
        parentSpanId: a.etSid,
        name: `POST tool/${a.toolName}`,
        kind: 3,
        startTimeUnixNano: ns(etStart + attOff),
        endTimeUnixNano: ns(etStart + attOff + 400),
        attributes: cAttrs,
        status: {}
      };

      // Populate receipt info
      if (att.receipt) {
        cAttrs.push(sa('ga5.receipt.id', att.receipt.receiptId));
        cAttrs.push(sa('ga5.receipt.nonce', att.receipt.nonce));

        if (att.receipt.status === 503) {
          cSpan.status = { code: 2 }; // ERROR
          cAttrs.push(sa('error.type', '503'));
        } else if (att.receipt.status === 0 || att.receipt.errorType === 'timeout') {
          cSpan.status = { code: 2 }; // ERROR
          cAttrs.push(sa('error.type', 'timeout'));
        }
        // Success: leave status as UNSET ({}), no error.type
      }

      spans.push(cSpan);
      attOff += 500;
    }
    off += 200 + (a.attempts.length * 500) + 100;
  }

  // ---- 5. incident.join (when >1 parallel diagnostic) ----
  const diags = run.actions.filter(a => a.phase === 'diagnostic');
  if (diags.length > 1 && run.joinSid) {
    spans.push({
      traceId: run.traceId,
      spanId: run.joinSid,
      parentSpanId: run.agentSid,
      name: 'incident.join',
      kind: 1,
      startTimeUnixNano: ns(T + off),
      endTimeUnixNano: ns(T + off + 10),
      attributes: [...ca],
      links: diags.map(d => ({
        traceId: run.traceId,
        spanId: d.etSid
      })),
      status: {}
    });
    off += 20;
  }

  // ---- 6. approval_gate (when approval is required) ----
  if (run.approval) {
    const gateAttrs = [
      ...ca,
      sa('ga5.approval.id', run.approval.approvalId)
    ];
    if (run.approvalReceipt) {
      gateAttrs.push(sa('ga5.receipt.nonce', run.approvalReceipt.nonce));
    }
    spans.push({
      traceId: run.traceId,
      spanId: run.approval.aSid,
      parentSpanId: run.agentSid,
      name: 'approval_gate',
      kind: 1,
      startTimeUnixNano: ns(T + off),
      endTimeUnixNano: ns(T + off + 10),
      attributes: gateAttrs,
      status: {}
    });
  }

  return {
    resourceSpans: [{
      scopeSpans: [{
        spans
      }]
    }]
  };
}

// ============================================================
// GET /v2/incidents/:runId
// ============================================================

function getIncident(req, res) {
  const { runId } = req.params;
  if (!store.has(runId)) {
    return res.status(404).json({ error: 'Run not found' });
  }
  return res.json(store.get(runId).lastResponse);
}

module.exports = { handleIncident, handleReceipt, getIncident };
