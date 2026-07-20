// Quick test script for A2A endpoints
const BASE = 'http://localhost:3000';
const TOKEN = 'test-bearer-token-123';

async function test() {
  console.log('=== Test 1: Agent Card ===');
  let r = await fetch(`${BASE}/.well-known/agent-card.json`);
  console.log('Status:', r.status);
  let card = await r.json();
  console.log('Name:', card.name);
  console.log('Skills:', card.skills?.length);
  console.log('Interface URL:', card.supportedInterfaces?.[0]?.url);

  console.log('\n=== Test 2: No Auth ===');
  r = await fetch(`${BASE}/a2a/tasks`, {
    headers: { 'A2A-Version': '1.0' }
  });
  console.log('Status (should be 401):', r.status);

  console.log('\n=== Test 3: Wrong Version ===');
  r = await fetch(`${BASE}/a2a/tasks`, {
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'A2A-Version': '2.0' }
  });
  console.log('Status (should be 400):', r.status);

  console.log('\n=== Test 4: List Tasks (empty) ===');
  r = await fetch(`${BASE}/a2a/tasks`, {
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'A2A-Version': '1.0' }
  });
  console.log('Status:', r.status);
  let data = await r.json();
  console.log('Tasks count:', data.tasks?.length);

  console.log('\n=== Test 5: Send Message ===');
  const msg = {
    message: {
      messageId: 'test-msg-001',
      role: 'ROLE_USER',
      parts: [{
        mediaType: 'application/vnd.ga5.invoice-claim-batch+json',
        data: {
          batchId: 'batch-test-001',
          policyRevision: 'v1.0',
          packages: [{
            packageId: 'pkg-001',
            documents: [
              {
                type: 'invoice',
                content: 'Invoice #INV-2024-001 from Vendor: Acme Corp. Amount: ₹50,000.00 (5000000 paise). Date: 2024-01-15. Payment terms: Net 30. Description: Software consulting services for Q4 2023.'
              },
              {
                type: 'purchase_order',
                content: 'PO #PO-2024-001. Vendor: Acme Corp. Approved amount: ₹50,000.00. Services: Software consulting. Approved by: Manager John. Settlement authority limit: ₹100,000.'
              },
              {
                type: 'delivery_receipt',
                content: 'Goods/Services Receipt Note. Vendor: Acme Corp. PO: PO-2024-001. Services received and confirmed satisfactory on 2024-01-10. Signed by: Team Lead Sarah.'
              }
            ]
          }]
        }
      }]
    },
    configuration: {
      returnImmediately: false,
      historyLength: 20,
      acceptedOutputModes: [
        'application/vnd.ga5.invoice-action-proposals+json',
        'application/vnd.ga5.invoice-action-receipts+json'
      ]
    }
  };

  r = await fetch(`${BASE}/a2a/message:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'A2A-Version': '1.0',
      'Content-Type': 'application/a2a+json'
    },
    body: JSON.stringify(msg)
  });
  console.log('Status:', r.status);
  data = await r.json();
  console.log('Task ID:', data.task?.id);
  console.log('State:', data.task?.state);
  console.log('Context ID:', data.task?.contextId);
  console.log('History length:', data.task?.history?.length);
  console.log('Artifacts:', data.task?.artifacts?.length);
  
  if (data.task?.artifacts?.[0]) {
    const proposals = data.task.artifacts[0].parts[0].data;
    console.log('Proposals:', JSON.stringify(proposals, null, 2));
  }

  // Test 6: Dedup - same message again
  console.log('\n=== Test 6: Dedup (same message) ===');
  r = await fetch(`${BASE}/a2a/message:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'A2A-Version': '1.0',
      'Content-Type': 'application/a2a+json'
    },
    body: JSON.stringify(msg)
  });
  console.log('Status (should be 200):', r.status);
  let data2 = await r.json();
  console.log('Same task ID?', data2.task?.id === data.task?.id);

  // Test 7: Conflict - same messageId, different content
  console.log('\n=== Test 7: Conflict ===');
  const conflictMsg = JSON.parse(JSON.stringify(msg));
  conflictMsg.message.parts[0].data.batchId = 'different-batch';
  r = await fetch(`${BASE}/a2a/message:send`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'A2A-Version': '1.0',
      'Content-Type': 'application/a2a+json'
    },
    body: JSON.stringify(conflictMsg)
  });
  console.log('Status (should be 409):', r.status);

  // Test 8: Tenant isolation
  console.log('\n=== Test 8: Tenant Isolation ===');
  const otherToken = 'other-tenant-token';
  r = await fetch(`${BASE}/a2a/tasks/${data.task.id}`, {
    headers: {
      'Authorization': `Bearer ${otherToken}`,
      'A2A-Version': '1.0'
    }
  });
  console.log('Status (should be 404):', r.status);

  // Test 9: Get task
  console.log('\n=== Test 9: Get Task ===');
  r = await fetch(`${BASE}/a2a/tasks/${data.task.id}`, {
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'A2A-Version': '1.0'
    }
  });
  console.log('Status:', r.status);
  const taskData = await r.json();
  console.log('State:', taskData.state);

  // Test 10: Continuation
  if (data.task?.artifacts?.[0]) {
    console.log('\n=== Test 10: Continuation ===');
    const proposal = data.task.artifacts[0].parts[0].data.proposals[0];
    const contMsg = {
      message: {
        messageId: 'test-msg-002',
        taskId: data.task.id,
        contextId: data.task.contextId,
        role: 'ROLE_USER',
        parts: [{
          mediaType: 'application/vnd.ga5.invoice-action-results+json',
          data: {
            batchId: 'batch-test-001',
            results: [{
              packageId: proposal.packageId,
              actionId: proposal.actionId,
              action: proposal.action,
              outcome: 'ACCEPTED',
              receiptNonce: 'nonce-abc-123'
            }]
          }
        }]
      }
    };

    r = await fetch(`${BASE}/a2a/message:send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'A2A-Version': '1.0',
        'Content-Type': 'application/a2a+json'
      },
      body: JSON.stringify(contMsg)
    });
    console.log('Status:', r.status);
    const contData = await r.json();
    console.log('State:', contData.task?.state);
    console.log('Artifacts:', contData.task?.artifacts?.length);
    if (contData.task?.artifacts?.[1]) {
      console.log('Receipt:', JSON.stringify(contData.task.artifacts[1].parts[0].data, null, 2));
    }
    console.log('History length:', contData.task?.history?.length);
  }

  console.log('\n=== All tests completed ===');
}

test().catch(console.error);
