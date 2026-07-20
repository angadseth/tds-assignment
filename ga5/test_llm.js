// Test aipipe OpenAI endpoint
async function main() {
  const token = process.env.AIPIPE_TOKEN;
  
  console.log('Testing aipipe.org OpenAI endpoint...');
  
  try {
    const r = await fetch('https://aipipe.org/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'Return JSON: {"greeting":"hello"}' }],
        max_tokens: 50,
        response_format: { type: 'json_object' }
      })
    });
    
    console.log('Status:', r.status);
    const data = await r.json();
    console.log('Response:', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }
  
  // Also try openrouter with a free model
  console.log('\nTesting openrouter with free model...');
  try {
    const r2 = await fetch('https://aipipe.org/openrouter/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://test.app',
        'X-Title': 'Test'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash-lite',
        messages: [{ role: 'user', content: 'Return JSON: {"greeting":"hello"}' }],
        max_tokens: 50
      })
    });
    
    console.log('Status:', r2.status);
    const data2 = await r2.json();
    console.log('Response:', JSON.stringify(data2, null, 2));
  } catch (e) {
    console.error('Error:', e.message);
  }

  // Try Google Gemini API directly via aipipe proxy
  console.log('\nTesting Google AI Studio proxy...');
  try {
    const r3 = await fetch('https://aipipe.org/gemini/v1beta/models/gemini-2.0-flash:generateContent', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Return JSON: {"greeting":"hello"}' }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    });
    
    console.log('Status:', r3.status);
    const data3 = await r3.text();
    console.log('Response:', data3.substring(0, 500));
  } catch (e) {
    console.error('Error:', e.message);
  }
}

main();
