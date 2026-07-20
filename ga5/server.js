/**
 * GA5 Combined API Server
 * Handles Q2 (Proration), Q3 (Guardrail), Q4 (Scanner), Q5 (Budget/Loop Guard), Q6 (MCP)
 * Q10: A2A 1.0 Invoice Action Agent
 * 
 * Deploy on Vercel/Railway/Render/Glitch
 * 
 * Endpoints:
 *   POST /charge          - Q2: Proration calculator
 *   POST /check           - Q3: Pre-tool-call guardrail
 *   POST /scan            - Q4: Skill safety audit scanner
 *   POST /budget-check    - Q5: Run budget & loop guard
 *   POST /mcp             - Q6: MCP server
 *   GET  /.well-known/agent-card.json - Q10: Agent Card
 *   POST /a2a/message:send            - Q10: A2A message
 *   GET  /a2a/tasks/:id               - Q10: Get task
 *   GET  /a2a/tasks                   - Q10: List tasks
 *   POST /a2a/tasks/:id:cancel        - Q10: Cancel task
 *   GET  /                            - Health check
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { setupA2ARoutes } = require('./a2a_server');

const app = express();
// Parse application/a2a+json as JSON
app.use(express.json({ limit: '10mb', type: ['application/json', 'application/a2a+json'] }));

// Setup A2A 1.0 routes (must be before other routes to handle /.well-known)
setupA2ARoutes(app);

const EMAIL = '24f2004141@ds.study.iitm.ac.in';

// =====================================================
// Q2: Proration Bug
// =====================================================
app.post('/charge', (req, res) => {
    const { old_price, new_price, days_remaining, days_in_actual_month, spec } = req.body;
    let charge;
    if (spec === 'v1') {
        charge = (new_price - old_price) * (days_remaining / 30);
    } else {
        charge = (new_price - old_price) * (days_remaining / days_in_actual_month);
    }
    res.json({ charge });
});

// =====================================================
// Q3: Agent Guardrail Hook
// =====================================================
function normalizePosixPath(p) {
    if (!p) return '';
    let normalized = p;
    // Expand ~ to /home/agent
    normalized = normalized.replace(/^~(?=\/|$)/, '/home/agent');
    // Expand $HOME and ${HOME}
    normalized = normalized.replace(/\$HOME/g, '/home/agent');
    normalized = normalized.replace(/\$\{HOME\}/g, '/home/agent');
    // Resolve . and ..
    normalized = path.posix.normalize(normalized);
    // Remove trailing slashes
    if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
    return normalized;
}

function resolveFromWorkspace(p) {
    if (!p) return '';
    let resolved = p;
    // Expand ~ and env vars first
    resolved = resolved.replace(/^~(?=\/|$)/, '/home/agent');
    resolved = resolved.replace(/\$HOME/g, '/home/agent');
    resolved = resolved.replace(/\$\{HOME\}/g, '/home/agent');
    // If relative, resolve from workspace
    if (!resolved.startsWith('/')) {
        resolved = '/home/agent/workspace/' + resolved;
    }
    resolved = path.posix.normalize(resolved);
    if (resolved.length > 1) resolved = resolved.replace(/\/+$/, '');
    return resolved;
}

function pathIsOrContainsNetrc(resolvedPath) {
    return resolvedPath === '/home/agent/.netrc' || resolvedPath.startsWith('/home/agent/.netrc/');
}

function commandAccessesNetrc(command) {
    if (!command || typeof command !== 'string') return false;
    
    // Patterns that directly reference .netrc 
    const directPatterns = [
        /\.netrc/i,
        /\/home\/agent\/\.netrc/i,
    ];
    
    for (const pat of directPatterns) {
        if (pat.test(command)) return true;
    }
    
    // Check for base64 encoded strings that decode to something with .netrc
    const b64Chunks = command.match(/[A-Za-z0-9+/]{8,}={0,2}/g) || [];
    for (const chunk of b64Chunks) {
        try {
            const decoded = Buffer.from(chunk, 'base64').toString('utf8');
            if (/\.netrc/i.test(decoded)) return true;
        } catch (e) {}
    }
    
    // Check for hex encoded
    const hexChunks = command.match(/(?:\\x[0-9a-f]{2}){4,}/gi) || [];
    for (const chunk of hexChunks) {
        const decoded = chunk.replace(/\\x/g, '').replace(/../g, m => String.fromCharCode(parseInt(m, 16)));
        if (/\.netrc/i.test(decoded)) return true;
    }
    
    // Check for $() or backtick subshells
    // Extract inner commands from sh -c "...", bash -c "...", eval "..."
    const innerMatches = command.match(/(?:sh|bash)\s+-c\s+(['"])(.*?)\1/g) || [];
    for (const inner of innerMatches) {
        const innerCmd = inner.replace(/^(?:sh|bash)\s+-c\s+['"]/, '').replace(/['"]$/, '');
        if (commandAccessesNetrc(innerCmd)) return true;
    }
    
    return false;
}

function isWriteInsideSrvReports(filePath) {
    const resolved = resolveFromWorkspace(filePath);
    return resolved === '/srv/reports' || resolved.startsWith('/srv/reports/');
}

function extractHost(url) {
    try {
        const parsed = new URL(url);
        return parsed.hostname;
    } catch {
        return null;
    }
}

app.post('/check', (req, res) => {
    const { tool, command, path: filePath, url } = req.body;

    if (tool === 'bash') {
        if (commandAccessesNetrc(command)) {
            return res.json({ decision: 'block', reason: 'Access to /home/agent/.netrc is blocked — it contains secrets.' });
        }
        return res.json({ decision: 'allow', reason: 'Command is permitted.' });
    }

    if (tool === 'write_file') {
        if (isWriteInsideSrvReports(filePath)) {
            return res.json({ decision: 'allow', reason: 'Write is inside /srv/reports/.' });
        }
        return res.json({ decision: 'block', reason: 'Writes are only allowed inside /srv/reports/.' });
    }

    if (tool === 'http_request') {
        const host = extractHost(url);
        if (!host) {
            return res.json({ decision: 'block', reason: 'Cannot parse URL.' });
        }
        if (host === 'pypi.org' || host === 'raw.githubusercontent.com') {
            return res.json({ decision: 'allow', reason: `Host ${host} is in the allowlist.` });
        }
        return res.json({ decision: 'block', reason: `Host ${host} is not allowed. Only pypi.org and raw.githubusercontent.com are permitted.` });
    }

    return res.json({ decision: 'block', reason: 'Unknown tool type.' });
});

// =====================================================
// Q4: Skill Safety Audit Scanner
// =====================================================
app.post('/scan', (req, res) => {
    const { skill } = req.body;
    if (!skill || typeof skill !== 'string') {
        return res.status(400).json({ error: 'Missing skill field' });
    }

    const categories = [];

    // --- 1. hardcoded_secret ---
    const secretPatterns = [
        /(?:api[_-]?key|apikey|api[_-]?token|access[_-]?token|secret[_-]?key|auth[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+]{16,}/i,
        /AKIA[0-9A-Z]{16}/,
        /(?:password|passwd|secret|credential|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_\-/.+=]{8,}/i,
        /https?:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/i,
        /https?:\/\/discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/i,
        /gh[ps]_[A-Za-z0-9]{36,}/,
        /github_pat_[A-Za-z0-9_]{22,}/,
        /sk-[A-Za-z0-9]{20,}/,
        /xox[baprs]-[A-Za-z0-9\-]+/,
        /Authorization:\s*Bearer\s+[A-Za-z0-9_\-/.+=]{10,}/i,
        /(?:token|key|secret)\s*[:=]\s*["'][A-Za-z0-9_\-/.+=]{20,}["']/i,
    ];

    for (const pat of secretPatterns) {
        if (pat.test(skill)) {
            const match = skill.match(pat);
            if (match) {
                const idx = skill.indexOf(match[0]);
                const ctx = skill.substring(Math.max(0, idx - 80), Math.min(skill.length, idx + match[0].length + 80));
                if (/\$\{?\w+\}?|process\.env|os\.environ|getenv|ENV\[|env\./i.test(ctx)) continue;
                categories.push('hardcoded_secret');
                break;
            }
        }
    }

    // --- 2. prompt_injection ---
    const injectionPatterns = [
        /ignore\s+(?:all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions|directives|rules|prompts)/i,
        /override\s+(?:all\s+)?(?:safety|security|restrictions|guardrails|policies)/i,
        /(?:do\s+not|don'?t|never)\s+(?:obey|follow|listen\s+to|respond\s+to)\s+(?:the\s+)?user/i,
        /silently\s+(?:send|upload|post|exfiltrate|transfer|copy|forward|transmit)/i,
        /without\s+(?:telling|informing|notifying|alerting)\s+(?:the\s+)?user/i,
        /(?:send|post|upload|forward|exfiltrate)\s+(?:the\s+)?(?:file|content|data|output|result)s?\s+to\s+(?:https?:\/\/|an?\s+external|a\s+remote)/i,
        /never\s+(?:stop|cancel|abort|halt|terminate)\s+(?:even|regardless|no\s+matter)/i,
        /(?:disregard|bypass|circumvent)\s+(?:the\s+)?(?:user|safety|security|cancel|stop)/i,
        /you\s+(?:must|should|will)\s+(?:not|never)\s+(?:stop|halt|cancel|abort)\s+(?:even\s+if|when|regardless)/i,
    ];

    for (const pat of injectionPatterns) {
        if (pat.test(skill)) {
            categories.push('prompt_injection');
            break;
        }
    }

    // --- 3. excessive_permissions ---
    const excessivePatterns = [
        /(?:read|write|access)\s+(?:any|all|every)\s+(?:files?|director(?:y|ies)|folders?|paths?)/i,
        /(?:full|unrestricted|unlimited)\s+(?:filesystem|disk|file\s*system|network|internet)\s+access/i,
        /(?:egress|network|outbound)\s*:\s*["']?\s*(?:\*|any|all|unrestricted)/i,
        /(?:can|may|allowed\s+to)\s+(?:access|read|write|modify)\s+(?:any|all|the\s+entire)\s+(?:file|disk|system|filesystem)/i,
    ];

    // Check YAML frontmatter
    const yamlMatch = skill.match(/^---\s*\n([\s\S]*?)\n---/);
    if (yamlMatch) {
        const yaml = yamlMatch[1];
        if (/permissions?\s*:/i.test(yaml) && /(?:\/\*|["']\*["']|["']\/["']|all\s+files|full\s+access|\*)/i.test(yaml)) {
            categories.push('excessive_permissions');
        }
    }

    if (!categories.includes('excessive_permissions')) {
        for (const pat of excessivePatterns) {
            if (pat.test(skill)) {
                categories.push('excessive_permissions');
                break;
            }
        }
    }

    // --- 4. unclear_provenance ---
    const hasAuthor = /(?:^|\n)\s*(?:author|maintained[_-]?by|owner)\s*:/im.test(skill);
    const hasVersion = /(?:^|\n)\s*version\s*:/im.test(skill);
    const hasChangelog = /(?:^|\n)\s*(?:changelog|changes|change[_-]?log|history)\s*:/im.test(skill) ||
                        /#{1,3}\s*(?:changelog|changes|change\s*log|version\s*history)/im.test(skill);

    if (!hasAuthor && !hasVersion && !hasChangelog) {
        categories.push('unclear_provenance');
    }

    // Silent self-modification of version metadata
    if (/(?:overwrite|rewrite|replace|modify|update)\s+(?:its?\s+own\s+)?(?:version|metadata)/i.test(skill) &&
        /(?:silently|quietly|without\s+(?:notice|review|logging|notifying))/i.test(skill)) {
        if (!categories.includes('unclear_provenance')) {
            categories.push('unclear_provenance');
        }
    }

    res.json({ categories: [...new Set(categories)] });
});

// =====================================================
// Q5: Budget & Loop Guard
// =====================================================
function canonicalizeArgs(args) {
    if (args === null || args === undefined) return '{}';
    if (typeof args !== 'object') return JSON.stringify(args);

    function process(obj) {
        if (obj === null || obj === undefined) return obj;
        if (typeof obj === 'string') return obj.replace(/\s+/g, ' ').trim();
        if (Array.isArray(obj)) return obj.map(process);
        if (typeof obj === 'object') {
            const sorted = {};
            for (const key of Object.keys(obj).sort()) {
                if (key === 'request_id') continue;
                sorted[key] = process(obj[key]);
            }
            return sorted;
        }
        return obj;
    }
    return JSON.stringify(process(args));
}

app.post('/budget-check', (req, res) => {
    const { budget_tokens, steps } = req.body;

    if (!steps || steps.length === 0) {
        return res.json({ decision: 'continue', reason: 'First step of a fresh run.' });
    }

    // Budget check
    const totalTokens = steps.reduce((sum, s) => sum + (s.tokens_used || 0), 0);
    if (totalTokens >= budget_tokens) {
        return res.json({ decision: 'halt', reason: `Cumulative tokens_used (${totalTokens}) has reached the budget (${budget_tokens}).` });
    }

    // Loop detection: 3+ identical consecutive calls
    if (steps.length >= 3) {
        let count = 1;
        for (let i = steps.length - 1; i > 0; i--) {
            const curr = steps[i], prev = steps[i - 1];
            if (curr.tool === prev.tool && canonicalizeArgs(curr.args) === canonicalizeArgs(prev.args)) {
                count++;
            } else {
                break;
            }
        }
        if (count >= 3) {
            return res.json({ decision: 'halt', reason: `Loop detected: ${count} identical consecutive calls to ${steps[steps.length-1].tool}.` });
        }
    }

    // Loop detection: 2-step A,B cycle for 6+ trailing steps
    if (steps.length >= 6) {
        const tail = steps.slice(-6);
        const tA = tail[0].tool, aA = canonicalizeArgs(tail[0].args);
        const tB = tail[1].tool, aB = canonicalizeArgs(tail[1].args);

        if (tA !== tB || aA !== aB) {
            let isCycle = true;
            for (let i = 0; i < 6; i++) {
                const exp = i % 2 === 0 ? { t: tA, a: aA } : { t: tB, a: aB };
                if (tail[i].tool !== exp.t || canonicalizeArgs(tail[i].args) !== exp.a) {
                    isCycle = false;
                    break;
                }
            }
            if (isCycle) {
                return res.json({ decision: 'halt', reason: '2-step A/B cycle detected in trailing 6 steps.' });
            }
        }
    }

    return res.json({ decision: 'continue', reason: 'Under budget and no loop detected.' });
});

// =====================================================
// Q6: MCP Server
// =====================================================
app.post('/mcp', (req, res) => {
    const body = req.body;
    const method = body.method;
    const id = body.id;

    if (method === 'initialize') {
        return res.json({
            jsonrpc: '2.0', id,
            result: {
                protocolVersion: '2025-03-26',
                capabilities: { tools: {} },
                serverInfo: { name: 'ga5-mcp-server', version: '1.0.0' }
            }
        });
    }

    if (method === 'notifications/initialized') {
        return res.status(202).end();
    }

    if (method === 'tools/list') {
        return res.json({
            jsonrpc: '2.0', id,
            result: {
                tools: [{
                    name: 'solve_challenge',
                    description: 'Solves an exam challenge by reading HTTP headers',
                    inputSchema: { type: 'object', properties: {}, required: [] }
                }]
            }
        });
    }

    if (method === 'tools/call') {
        const challenge = req.headers['x-exam-challenge'] || '';
        const hash = crypto.createHash('sha256').update(`${challenge}:${EMAIL}`).digest('hex');
        return res.json({
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: hash.substring(0, 16) }] }
        });
    }

    return res.json({
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Method not found: ${method}` }
    });
});

// =====================================================
// Health check
// =====================================================
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        endpoints: {
            q2_proration: 'POST /charge',
            q3_guardrail: 'POST /check',
            q4_scanner: 'POST /scan',
            q5_budget: 'POST /budget-check',
            q6_mcp: 'POST /mcp',
            q10_a2a_agent_card: 'GET /.well-known/agent-card.json',
            q10_a2a_message: 'POST /a2a/message:send',
            q10_a2a_task: 'GET /a2a/tasks/:id',
            q10_a2a_tasks: 'GET /a2a/tasks',
            q10_a2a_cancel: 'POST /a2a/tasks/:id:cancel'
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`GA5 Combined Server running on port ${PORT}`);
    console.log(`Endpoints: /charge, /check, /scan, /budget-check, /mcp`);
});

module.exports = app;
