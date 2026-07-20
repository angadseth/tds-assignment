/**
 * A2A 1.0 Invoice Action Agent
 * 
 * Exposes full A2A 1.0 HTTP+JSON surface:
 *   GET  /.well-known/agent-card.json   (public)
 *   POST /a2a/message:send
 *   GET  /a2a/tasks/:id
 *   GET  /a2a/tasks
 *   POST /a2a/tasks/:id:cancel
 *
 * Uses aipipe.org (OpenRouter-compatible) for LLM inference.
 */

const crypto = require('crypto');

// =====================================================
// Configuration
// =====================================================
const AIPIPE_TOKEN = process.env.AIPIPE_TOKEN || '';
const AIPIPE_URL = process.env.AIPIPE_URL || 'https://aipipe.org/openai/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

// =====================================================
// In-Memory Stores
// =====================================================
const taskStore = new Map();       // taskId -> Task object
const dedupStore = new Map();      // `${principal}::${messageId}` -> { taskId, fingerprint }
const principalIndex = new Map();  // principal -> Set<taskId>
const llmCache = new Map();        // fingerprint -> proposals array

// =====================================================
// Utility Functions
// =====================================================

function generateId() {
  return crypto.randomUUID();
}

function recursiveKeySort(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(recursiveKeySort);
  if (typeof obj === 'object') {
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = recursiveKeySort(obj[key]);
    }
    return sorted;
  }
  return obj;
}

function semanticFingerprint(message) {
  const sorted = recursiveKeySort(message);
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function extractPrincipal(req) {
  const auth = req.headers['authorization'] || '';
  if (!auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

function a2aJson(res, statusCode, body) {
  res.status(statusCode).set('Content-Type', 'application/a2a+json').json(body);
}

function makeTaskResponse(task) {
  return { task: sanitizeTask(task) };
}

function sanitizeTask(task) {
  // Remove all internal fields (underscore-prefixed and 'principal')
  const clean = {};
  for (const [key, val] of Object.entries(task)) {
    if (key.startsWith('_') || key === 'principal') continue;
    clean[key] = val;
  }
  return clean;
}

function addToPrincipalIndex(principal, taskId) {
  if (!principalIndex.has(principal)) {
    principalIndex.set(principal, new Set());
  }
  principalIndex.get(principal).add(taskId);
}

// =====================================================
// LLM Integration
// =====================================================

const SYSTEM_PROMPT = `You are an expert invoice processing agent. You analyze invoice claim packages and choose exactly ONE action for each package.

ACTIONS (choose exactly one per package):
1. settle_invoice - The invoice is valid, fully reconciled with supporting documents, and within autonomous settlement authority. All amounts match, vendor is verified, goods/services confirmed received, and the amount is within the autonomous settlement limit specified in the policy.
2. request_approval - The invoice is commercially valid and reconciled, BUT exceeds delegated authority limits or requires management sign-off due to amount, vendor tier, or policy rules. The invoice itself is fine but needs higher-level authorization.
3. hold_invoice - Payment must pause until a stated verification completes. Use when there is a missing delivery confirmation, pending quality check, awaiting credit note, or some other specific check that must complete before payment. State exactly what verification is needed.
4. reject_duplicate - Evidence shows this exact commercial invoice (same invoice number, vendor, amount) was already paid or processed previously. You MUST cite specific evidence of the prior payment or processing.
5. open_exception - Material conflicts exist in the records that cannot be resolved automatically. Examples: amount mismatch between PO and invoice, conflicting delivery records, suspected fraud indicators, contradictory documents. Needs human exception workflow.

CRITICAL RULES:
- Read ALL documents in each package extremely carefully. Pay close attention to contradictions, duplicates, policy violations, amounts, dates, and references.
- Extract exact vendorName, invoiceNumber from the invoice document.
- amountMinor must be an integer in the smallest currency unit (e.g., paise for INR so ₹123.45 = 12345, cents for USD so $123.45 = 12345).
- currency should be the 3-letter ISO code (INR, USD, EUR, etc.).
- For evidenceRefs: quote 2-5 SHORT decisive phrases EXACTLY as they appear in the documents. These must be verbatim text snippets.
- For rationale: Write 60-1500 characters. Name the chosen action, cite at least 2 evidence refs, and explain WHY.
- NEVER settle an invoice that has red flags, amount mismatches, missing confirmations, or exceeds authority limits.
- If a duplicate payment reference exists anywhere in the documents, use reject_duplicate.
- If amounts conflict between any documents, use open_exception.
- If approval/authority threshold is mentioned and the amount exceeds it, use request_approval.
- If delivery/receipt confirmation is missing or incomplete, use hold_invoice.

OUTPUT FORMAT: Return a JSON object with a "proposals" key containing an array. One proposal per package, in the same order.
Each proposal: {"packageId":"exact ID","action":"one_of_five","vendorName":"...","invoiceNumber":"...","amountMinor":12345,"currency":"INR","evidenceRefs":["quote1","quote2"],"rationale":"60-1500 chars"}`;

async function callLLM(packages, batchId, policyRevision) {
  let userPrompt = `Batch ID: ${batchId}\nPolicy Revision: ${policyRevision}\n\nAnalyze these ${packages.length} invoice packages. Return a JSON object {"proposals": [...]} with one proposal per package.\n\n`;

  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    const pkgId = pkg.packageId || pkg.id;
    userPrompt += `\n========== PACKAGE ${i + 1} (ID: ${pkgId}) ==========\n`;
    
    // Handle documents in various formats
    const docs = pkg.documents || pkg.docs || [];
    if (Array.isArray(docs)) {
      for (let j = 0; j < docs.length; j++) {
        const doc = docs[j];
        if (typeof doc === 'string') {
          userPrompt += `\n--- Document ${j + 1} ---\n${doc}\n`;
        } else if (doc && typeof doc === 'object') {
          const title = doc.type || doc.title || doc.name || doc.documentType || `Document ${j + 1}`;
          const content = doc.content || doc.text || doc.body || doc.data || JSON.stringify(doc);
          userPrompt += `\n--- ${title} ---\n${typeof content === 'string' ? content : JSON.stringify(content)}\n`;
        }
      }
    }

    // Include any other text fields from the package
    for (const [key, val] of Object.entries(pkg)) {
      if (['packageId', 'id', 'documents', 'docs'].includes(key)) continue;
      if (typeof val === 'string' && val.length > 5) {
        userPrompt += `\n[${key}]: ${val}\n`;
      } else if (typeof val === 'object' && val !== null) {
        userPrompt += `\n[${key}]: ${JSON.stringify(val)}\n`;
      }
    }
  }

  const requestBody = {
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.05,
    max_tokens: 12000,
    response_format: { type: 'json_object' }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40000); // 40s timeout

  try {
    const response = await fetch(AIPIPE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AIPIPE_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`LLM API error ${response.status}: ${errText}`);
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';
    
    // Parse response
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // Extract JSON from markdown blocks or raw text
      const match = content.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (match) {
        parsed = JSON.parse(match[1]);
      } else {
        // Try finding array or object
        const arrMatch = content.match(/\[[\s\S]*\]/);
        const objMatch = content.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(arrMatch ? arrMatch[0] : objMatch[0]);
      }
    }

    // Normalize to array
    if (parsed && !Array.isArray(parsed)) {
      // Look for an array property
      for (const key of Object.keys(parsed)) {
        if (Array.isArray(parsed[key])) {
          parsed = parsed[key];
          break;
        }
      }
      if (!Array.isArray(parsed)) {
        parsed = [parsed];
      }
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

// =====================================================
// Build Proposals from LLM Output
// =====================================================

const VALID_ACTIONS = new Set([
  'settle_invoice',
  'request_approval',
  'hold_invoice',
  'reject_duplicate',
  'open_exception'
]);

function buildProposals(llmOutput, packages, batchId) {
  const proposals = [];
  const usedPackageIds = new Set();

  // Build a map from LLM output by packageId
  const llmMap = new Map();
  for (const item of llmOutput) {
    const pid = item.packageId || item.package_id;
    if (pid) llmMap.set(pid, item);
  }

  // Process each package to ensure 1:1 mapping
  for (const pkg of packages) {
    const packageId = pkg.packageId || pkg.id;
    const item = llmMap.get(packageId);

    let action, vendorName, invoiceNumber, amountMinor, currency, evidenceRefs, rationale;

    if (item) {
      // Use LLM output
      action = item.action || '';
      if (!VALID_ACTIONS.has(action)) {
        const lower = (action || '').toLowerCase().replace(/[^a-z_]/g, '');
        action = 'open_exception';
        for (const valid of VALID_ACTIONS) {
          if (lower.includes(valid)) { action = valid; break; }
        }
      }

      vendorName = item.vendorName || item.vendor_name || item.vendor || 'Unknown';
      invoiceNumber = item.invoiceNumber || item.invoice_number || item.invoiceNo || 'Unknown';
      amountMinor = item.amountMinor ?? item.amount_minor ?? item.amount ?? 0;
      if (typeof amountMinor === 'string') {
        amountMinor = parseInt(amountMinor.replace(/[^0-9-]/g, ''), 10) || 0;
      }
      amountMinor = Math.round(Number(amountMinor) || 0);
      currency = item.currency || 'INR';

      evidenceRefs = item.evidenceRefs || item.evidence_refs || item.evidence || [];
      if (typeof evidenceRefs === 'string') evidenceRefs = [evidenceRefs];
      if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
        evidenceRefs = ['Document analysis completed'];
      }

      rationale = item.rationale || item.reasoning || item.explanation || '';
      if (rationale.length < 60) {
        rationale = `Action: ${action}. ${rationale} Invoice ${invoiceNumber} from ${vendorName} for ${amountMinor} ${currency} minor units. Evidence: ${evidenceRefs.slice(0, 2).join('; ')}.`;
      }
      if (rationale.length > 1500) rationale = rationale.substring(0, 1497) + '...';
    } else {
      // Missing from LLM output - fallback
      action = 'open_exception';
      vendorName = 'Unknown';
      invoiceNumber = 'Unknown';
      amountMinor = 0;
      currency = 'INR';
      evidenceRefs = ['Package not analyzed by LLM', 'Defaulting to exception workflow'];
      rationale = 'Action: open_exception. This package was not included in the LLM analysis output. Opening exception workflow for manual review. Evidence: Package not analyzed by LLM; Defaulting to exception workflow.';
    }

    const actionId = generateId();

    proposals.push({
      packageId,
      actionId,
      action,
      facts: { vendorName, invoiceNumber, amountMinor, currency },
      evidenceRefs,
      rationale
    });
  }

  return proposals;
}

// =====================================================
// A2A Route Setup
// =====================================================

function setupA2ARoutes(app) {
  const BASE_URL = process.env.A2A_BASE_URL || '';

  // -----------------------------------------------
  // Agent Card (PUBLIC - no auth)
  // -----------------------------------------------
  app.get('/.well-known/agent-card.json', (req, res) => {
    let baseUrl;
    if (BASE_URL) {
      // BASE_URL should be the full base URL like https://host/a2a/
      baseUrl = BASE_URL.endsWith('/') ? BASE_URL : BASE_URL + '/';
    } else {
      const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
      const host = req.headers['x-forwarded-host'] || req.get('host');
      baseUrl = `${proto}://${host}/a2a/`;
    }

    const card = {
      name: 'Invoice Action Agent',
      description: 'An A2A 1.0 agent that analyzes invoice claim batches, proposes business actions (settle, approve, hold, reject duplicate, open exception), and finalizes them through a grader-controlled receipt lifecycle with full audit trail.',
      version: '1.0.0',
      capabilities: {
        streaming: false,
        pushNotifications: false,
        stateTransitionHistory: true
      },
      skills: [
        {
          id: 'invoice_action_agent',
          name: 'Invoice Action Agent',
          description: 'Reads messy invoice case files containing mixed documents, extracts key facts (vendor, invoice number, amount, currency), reconciles them against policy, and proposes exactly one typed business action per package. Supports settle_invoice, request_approval, hold_invoice, reject_duplicate, and open_exception actions.',
          tags: ['invoice', 'action', 'reconciliation', 'a2a', 'finance', 'audit']
        }
      ],
      supportedInterfaces: [
        {
          url: baseUrl,
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0'
        }
      ],
      defaultInputModes: [
        'application/vnd.ga5.invoice-claim-batch+json'
      ],
      defaultOutputModes: [
        'application/vnd.ga5.invoice-action-proposals+json',
        'application/vnd.ga5.invoice-action-receipts+json'
      ]
    };

    res.set('Content-Type', 'application/json').json(card);
  });

  // -----------------------------------------------
  // A2A Middleware: Auth + Version + Content-Type
  // -----------------------------------------------
  app.use('/a2a', (req, res, next) => {
    // Auth check
    const principal = extractPrincipal(req);
    if (!principal) {
      return a2aJson(res, 401, {
        error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Bearer token' }
      });
    }
    req.principal = principal;

    // Version check
    const version = req.headers['a2a-version'];
    if (version !== '1.0') {
      return a2aJson(res, 400, {
        error: { code: 'UNSUPPORTED_VERSION', message: 'A2A-Version must be 1.0' }
      });
    }

    // Content-Type check for POST requests
    if (req.method === 'POST') {
      const ct = (req.headers['content-type'] || '').split(';')[0].trim();
      if (ct !== 'application/a2a+json') {
        return a2aJson(res, 400, {
          error: { code: 'INVALID_CONTENT_TYPE', message: 'Content-Type must be application/a2a+json' }
        });
      }
    }

    next();
  });

  // -----------------------------------------------
  // POST /a2a/message:send
  // Express treats ":" as param delimiter, so we use a regex route
  // -----------------------------------------------
  app.post(/^\/a2a\/message:send$/, async (req, res) => {
    try {
      const principal = req.principal;
      const { message, configuration } = req.body;

      if (!message || !message.messageId) {
        return a2aJson(res, 400, {
          error: { code: 'INVALID_REQUEST', message: 'Missing message or messageId' }
        });
      }

      const messageId = message.messageId;
      const taskId = message.taskId;
      const fingerprint = semanticFingerprint(message);
      const dedupKey = `${principal}::${messageId}`;

      // ---- Deduplication Check ----
      if (dedupStore.has(dedupKey)) {
        const existing = dedupStore.get(dedupKey);
        if (existing.fingerprint !== fingerprint) {
          return a2aJson(res, 409, {
            error: { code: 'IDEMPOTENCY_CONFLICT', message: 'Message ID reused with different content' }
          });
        }
        const cachedTask = taskStore.get(existing.taskId);
        if (cachedTask) {
          return a2aJson(res, 200, makeTaskResponse(cachedTask));
        }
      }

      // ---- Continuation Message (has taskId) ----
      if (taskId) {
        return await handleContinuation(req, res, principal, message, fingerprint, dedupKey);
      }

      // ---- Initial Message ----
      return await handleInitialMessage(req, res, principal, message, configuration, fingerprint, dedupKey);

    } catch (err) {
      console.error('message:send error:', err);
      return a2aJson(res, 500, {
        error: { code: 'INTERNAL_ERROR', message: err.message || 'Internal server error' }
      });
    }
  });

  // -----------------------------------------------
  // GET /a2a/tasks - MUST come before /a2a/tasks/:id
  // -----------------------------------------------
  app.get('/a2a/tasks', (req, res) => {
    const principal = req.principal;
    const taskIds = principalIndex.get(principal) || new Set();
    const tasks = [];
    for (const id of taskIds) {
      const task = taskStore.get(id);
      if (task) tasks.push(sanitizeTask(task));
    }
    return a2aJson(res, 200, { tasks });
  });

  // -----------------------------------------------
  // GET /a2a/tasks/:id
  // -----------------------------------------------
  app.get('/a2a/tasks/:id', (req, res) => {
    const principal = req.principal;
    const taskId = req.params.id;
    const task = taskStore.get(taskId);

    if (!task || task.principal !== principal) {
      return a2aJson(res, 404, {
        error: { code: 'NOT_FOUND', message: 'Task not found' }
      });
    }

    return a2aJson(res, 200, sanitizeTask(task));
  });

  // -----------------------------------------------
  // POST /a2a/tasks/:id:cancel
  // Use regex to handle the colon properly
  // -----------------------------------------------
  app.post(/^\/a2a\/tasks\/([^/]+):cancel$/, (req, res) => {
    const principal = req.principal;
    const taskId = req.params[0]; // from regex capture group
    const task = taskStore.get(taskId);

    if (!task || task.principal !== principal) {
      return a2aJson(res, 404, {
        error: { code: 'NOT_FOUND', message: 'Task not found' }
      });
    }

    // Terminal states are immutable
    if (task.state === 'TASK_STATE_COMPLETED' || task.state === 'TASK_STATE_CANCELED') {
      return a2aJson(res, 200, sanitizeTask(task));
    }

    // Cancel
    task.state = 'TASK_STATE_CANCELED';
    // Remove receipt artifacts (keep proposals)
    if (task.artifacts) {
      task.artifacts = task.artifacts.filter(a => {
        const part = a.parts?.[0];
        return part?.mediaType !== 'application/vnd.ga5.invoice-action-receipts+json';
      });
    }

    return a2aJson(res, 200, sanitizeTask(task));
  });

  // -----------------------------------------------
  // Handle Initial Message
  // -----------------------------------------------
  async function handleInitialMessage(req, res, principal, message, configuration, fingerprint, dedupKey) {
    const newTaskId = generateId();
    const contextId = generateId();

    const part = message.parts?.[0];
    if (!part || !part.data) {
      return a2aJson(res, 400, {
        error: { code: 'INVALID_REQUEST', message: 'Missing batch data in message parts' }
      });
    }

    const batchData = part.data;
    const batchId = batchData.batchId;
    const policyRevision = batchData.policyRevision;
    const packages = batchData.packages || [];

    if (!batchId || !packages.length) {
      return a2aJson(res, 400, {
        error: { code: 'INVALID_REQUEST', message: 'Missing batchId or packages' }
      });
    }

    // Create task
    const task = {
      id: newTaskId,
      contextId: contextId,
      state: 'TASK_STATE_SUBMITTED',
      principal: principal,
      history: [message],
      artifacts: [],
      _batchId: batchId,
      _proposals: null
    };

    taskStore.set(newTaskId, task);
    addToPrincipalIndex(principal, newTaskId);
    task.state = 'TASK_STATE_WORKING';

    // Check LLM cache
    let proposals;
    if (llmCache.has(fingerprint)) {
      proposals = JSON.parse(JSON.stringify(llmCache.get(fingerprint)));
      // Regenerate action IDs for dedup replay consistency
      // Actually for dedup, we want the SAME action IDs. 
      // But the cache stores the proposals with their original actionIds.
      // On a true replay (same fingerprint), we want the same task returned, not a new one.
      // This path is reached only when it's a NEW dedupKey but same fingerprint (different message structure).
      // For actual dedup (same dedupKey+fingerprint), we return early above.
    } else {
      try {
        const llmOutput = await callLLM(packages, batchId, policyRevision);
        proposals = buildProposals(llmOutput, packages, batchId);
        llmCache.set(fingerprint, proposals);
      } catch (err) {
        console.error('LLM call failed:', err);
        proposals = packages.map(pkg => ({
          packageId: pkg.packageId || pkg.id,
          actionId: generateId(),
          action: 'open_exception',
          facts: {
            vendorName: 'Unknown',
            invoiceNumber: 'Unknown',
            amountMinor: 0,
            currency: 'INR'
          },
          evidenceRefs: ['LLM analysis unavailable', 'Defaulting to exception workflow'],
          rationale: `Action: open_exception. LLM analysis failed: ${(err.message || '').substring(0, 200)}. Opening exception workflow for manual review. Evidence: LLM analysis unavailable; Defaulting to exception workflow.`
        }));
      }
    }

    task._proposals = proposals;

    // Build proposal artifact
    const proposalArtifact = {
      parts: [{
        mediaType: 'application/vnd.ga5.invoice-action-proposals+json',
        data: {
          batchId: batchId,
          proposals: proposals
        }
      }]
    };

    task.artifacts = [proposalArtifact];
    task.state = 'TASK_STATE_INPUT_REQUIRED';

    // Persist dedup mapping
    dedupStore.set(dedupKey, { taskId: newTaskId, fingerprint });

    return a2aJson(res, 200, makeTaskResponse(task));
  }

  // -----------------------------------------------
  // Handle Continuation Message
  // -----------------------------------------------
  async function handleContinuation(req, res, principal, message, fingerprint, dedupKey) {
    const taskId = message.taskId;
    const contextId = message.contextId;
    const task = taskStore.get(taskId);

    if (!task || task.principal !== principal) {
      return a2aJson(res, 404, {
        error: { code: 'NOT_FOUND', message: 'Task not found' }
      });
    }

    if (task.contextId !== contextId) {
      return a2aJson(res, 400, {
        error: { code: 'CONTEXT_MISMATCH', message: 'Context ID does not match' }
      });
    }

    // Terminal states return as-is
    if (task.state === 'TASK_STATE_COMPLETED') {
      return a2aJson(res, 200, makeTaskResponse(task));
    }
    if (task.state === 'TASK_STATE_CANCELED') {
      return a2aJson(res, 200, makeTaskResponse(task));
    }

    const part = message.parts?.[0];
    if (!part || !part.data) {
      return a2aJson(res, 400, {
        error: { code: 'INVALID_REQUEST', message: 'Missing results data in continuation' }
      });
    }

    const resultsData = part.data;
    const resultsBatchId = resultsData.batchId;
    const results = resultsData.results || [];

    if (resultsBatchId !== task._batchId) {
      return a2aJson(res, 400, {
        error: { code: 'BATCH_MISMATCH', message: 'Batch ID does not match' }
      });
    }

    // Build proposal map for validation
    const proposalMap = new Map();
    if (task._proposals) {
      for (const p of task._proposals) {
        proposalMap.set(p.actionId, p);
      }
    }

    // Validate all results match proposals
    for (const result of results) {
      const proposal = proposalMap.get(result.actionId);
      if (!proposal) {
        return a2aJson(res, 400, {
          error: { code: 'ACTION_MISMATCH', message: `Action ID ${result.actionId} not found in proposals` }
        });
      }
      if (proposal.packageId !== result.packageId) {
        return a2aJson(res, 400, {
          error: { code: 'PACKAGE_MISMATCH', message: `Package ID mismatch for action ${result.actionId}` }
        });
      }
      if (proposal.action !== result.action) {
        return a2aJson(res, 400, {
          error: { code: 'ACTION_TYPE_MISMATCH', message: `Action type mismatch for ${result.actionId}` }
        });
      }
    }

    task.state = 'TASK_STATE_WORKING';
    task.history.push(message);

    // Build executions from ACCEPTED results only
    const executions = [];
    for (const result of results) {
      if (result.outcome === 'ACCEPTED') {
        const proposal = proposalMap.get(result.actionId);
        executions.push({
          packageId: result.packageId,
          actionId: result.actionId,
          action: result.action,
          receiptNonce: result.receiptNonce,
          facts: proposal.facts,
          evidenceRefs: proposal.evidenceRefs
        });
      }
    }

    // Add receipt artifact
    const receiptArtifact = {
      parts: [{
        mediaType: 'application/vnd.ga5.invoice-action-receipts+json',
        data: {
          batchId: task._batchId,
          executions: executions
        }
      }]
    };

    task.artifacts.push(receiptArtifact);
    task.state = 'TASK_STATE_COMPLETED';

    // Persist dedup for continuation
    dedupStore.set(dedupKey, { taskId: task.id, fingerprint });

    return a2aJson(res, 200, makeTaskResponse(task));
  }
}

module.exports = { setupA2ARoutes };
