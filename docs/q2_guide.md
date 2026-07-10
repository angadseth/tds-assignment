# 🔥 Complete Guide: RAG Evaluation Harness — RAGAS-style Metrics (Q2)

> [!IMPORTANT]
> Har student ka dataset alag hota hai, so **answers alag honge**. But the **approach/code** is EXACTLY the same.

---

## Step 0: Setup

Your `rag_eval/` folder contains:
- `traces.jsonl` — 96 traces, each with: question, retrieved_chunks (3 chunks), generated_answer
- `ground_truth.jsonl` — 96 entries with: reference_answer, relevant_chunk_ids
- `answer_embeddings.json` — pre-computed embeddings for each generated_answer
- `question_embeddings.json` — pre-computed embeddings for each question

---

## The 4 Metrics

| Metric | What it measures |
|--------|-----------------|
| **Faithfulness** | Is the generated answer supported by the retrieved chunks? |
| **Answer Relevance** | Is the generated answer relevant to the question? |
| **Context Recall** | Did we retrieve all the relevant chunks? |
| **Context Precision** | Are the relevant chunks ranked higher than irrelevant ones? |

---

## Metric 1: Faithfulness

### Formula:
1. Split `generated_answer` into sentences using `[.!?]\s+`
2. Filter out sentences ≤ 5 characters
3. For each sentence, tokenize it: `text.toLowerCase().match(/[a-z0-9]+/g)`
4. For each sentence, find **max token overlap** with ANY individual chunk in `retrieved_chunks`
5. A sentence is "faithful" if overlap ≥ 50% of sentence tokens
6. **Faithfulness = count of faithful sentences / total sentences**

```javascript
function faithfulness(trace) {
    const sentences = trace.generated_answer.split(/[.!?]\s+/)
        .filter(s => s.trim().length > 5);
    
    if (sentences.length === 0) return 1.0;
    
    let faithfulCount = 0;
    for (const sent of sentences) {
        const sentTokens = tokenize(sent);
        if (sentTokens.length === 0) { faithfulCount++; continue; }
        
        let maxOverlap = 0;
        for (const chunk of trace.retrieved_chunks) {
            const chunkTokens = new Set(tokenize(chunk.text));
            const overlap = sentTokens.filter(t => chunkTokens.has(t)).length;
            maxOverlap = Math.max(maxOverlap, overlap);
        }
        
        if (maxOverlap / sentTokens.length >= 0.5) {
            faithfulCount++;
        }
    }
    
    return faithfulCount / sentences.length;
}
```

> [!NOTE]
> - Overlap = count of sentence tokens that appear in the chunk token SET
> - Threshold is ≥ 50% (i.e., `overlap / sentTokens.length >= 0.5`)
> - If no valid sentences (all ≤ 5 chars), return 1.0

---

## Metric 2: Answer Relevance

### Formula:
1. Get the embedding for `generated_answer` from `answer_embeddings.json`
2. Get the embedding for `question` from `question_embeddings.json`
3. **Answer Relevance = cosine_similarity(answer_embedding, question_embedding)**

```javascript
function answerRelevance(traceId) {
    const ansEmb = answerEmbeddings[traceId];
    const qEmb = questionEmbeddings[traceId];
    return cosineSim(ansEmb, qEmb);
}
```

> [!TIP]
> This is the simplest metric — just one cosine similarity calculation!

---

## Metric 3: Context Recall

### Formula:
1. Split `reference_answer` (from ground_truth) into sentences using `[.!?]\s+`
2. Filter out sentences ≤ 5 characters
3. For each reference sentence, check if ANY retrieved chunk has ≥ 50% token overlap
4. **Context Recall = count of supported reference sentences / total reference sentences**

```javascript
function contextRecall(trace, gt) {
    const refSentences = gt.reference_answer.split(/[.!?]\s+/)
        .filter(s => s.trim().length > 5);
    
    if (refSentences.length === 0) return 1.0;
    
    let supportedCount = 0;
    for (const sent of refSentences) {
        const sentTokens = tokenize(sent);
        if (sentTokens.length === 0) { supportedCount++; continue; }
        
        let maxOverlap = 0;
        for (const chunk of trace.retrieved_chunks) {
            const chunkTokens = new Set(tokenize(chunk.text));
            const overlap = sentTokens.filter(t => chunkTokens.has(t)).length;
            maxOverlap = Math.max(maxOverlap, overlap);
        }
        
        if (maxOverlap / sentTokens.length >= 0.5) {
            supportedCount++;
        }
    }
    
    return supportedCount / refSentences.length;
}
```

> [!NOTE]
> Context Recall is almost identical to Faithfulness, but:
> - Faithfulness checks `generated_answer` sentences against chunks
> - Context Recall checks `reference_answer` sentences against chunks

---

## Metric 4: Context Precision (AP@K)

### Formula — Average Precision at K:
1. For each retrieved chunk (in order), check if it's in `relevant_chunk_ids` (from ground_truth)
2. Compute precision at each position where a relevant chunk is found
3. **Context Precision = Average Precision = mean of these precisions**

```javascript
function contextPrecision(trace, gt) {
    const relevantSet = new Set(gt.relevant_chunk_ids);
    const retrieved = trace.retrieved_chunks.map(c => c.chunk_id);
    
    let hits = 0;
    let sumPrecision = 0;
    
    for (let i = 0; i < retrieved.length; i++) {
        if (relevantSet.has(retrieved[i])) {
            hits++;
            sumPrecision += hits / (i + 1);  // precision at position i+1
        }
    }
    
    if (relevantSet.size === 0) return 1.0;
    return sumPrecision / relevantSet.size;
}
```

### Example:
```
Retrieved:  [C1 ✓, C2 ✓, C3 ✗]     (C1, C2 are relevant)
Position 1: C1 is relevant → hits=1, precision = 1/1 = 1.0
Position 2: C2 is relevant → hits=2, precision = 2/2 = 1.0
Position 3: C3 not relevant → skip
AP = (1.0 + 1.0) / 2 = 1.0

Retrieved:  [C1 ✗, C2 ✓, C3 ✓]     (C2, C3 are relevant)
Position 1: C1 not relevant → skip
Position 2: C2 is relevant → hits=1, precision = 1/2 = 0.5
Position 3: C3 is relevant → hits=2, precision = 2/3 = 0.667
AP = (0.5 + 0.667) / 2 = 0.583
```

> [!IMPORTANT]
> Divide by `relevant_chunk_ids.length` (total number of relevant chunks), NOT by `retrieved_chunks.length`.

---

## Complete Working Code (JavaScript — Node.js)

```javascript
const fs = require('fs');

const DATA_DIR = 'rag_eval';
const traces = fs.readFileSync(`${DATA_DIR}/traces.jsonl`, 'utf8')
    .trim().split('\n').map(JSON.parse);
const groundTruth = fs.readFileSync(`${DATA_DIR}/ground_truth.jsonl`, 'utf8')
    .trim().split('\n').map(JSON.parse);
const answerEmbeddings = JSON.parse(fs.readFileSync(`${DATA_DIR}/answer_embeddings.json`, 'utf8'));
const questionEmbeddings = JSON.parse(fs.readFileSync(`${DATA_DIR}/question_embeddings.json`, 'utf8'));

// Build ground truth lookup
const gtMap = {};
for (const gt of groundTruth) gtMap[gt.trace_id] = gt;

// Tokenize
function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9]+/g)) || [];
}

// Cosine similarity
function cosineSim(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Round to 2 decimal places
function r2(val) {
    return Math.round(val * 100) / 100;
}

const results = {};

for (const trace of traces) {
    const tid = trace.trace_id;
    const gt = gtMap[tid];
    
    // --- Faithfulness ---
    const ansSentences = trace.generated_answer.split(/[.!?]\s+/)
        .filter(s => s.trim().length > 5);
    let faithfulness = 1.0;
    if (ansSentences.length > 0) {
        let faithfulCount = 0;
        for (const sent of ansSentences) {
            const sentTokens = tokenize(sent);
            if (sentTokens.length === 0) { faithfulCount++; continue; }
            let maxOverlap = 0;
            for (const chunk of trace.retrieved_chunks) {
                const chunkTokens = new Set(tokenize(chunk.text));
                const overlap = sentTokens.filter(t => chunkTokens.has(t)).length;
                maxOverlap = Math.max(maxOverlap, overlap);
            }
            if (maxOverlap / sentTokens.length >= 0.5) faithfulCount++;
        }
        faithfulness = faithfulCount / ansSentences.length;
    }
    
    // --- Answer Relevance ---
    const answerRelevance = cosineSim(
        answerEmbeddings[tid],
        questionEmbeddings[tid]
    );
    
    // --- Context Recall ---
    const refSentences = gt.reference_answer.split(/[.!?]\s+/)
        .filter(s => s.trim().length > 5);
    let contextRecall = 1.0;
    if (refSentences.length > 0) {
        let supportedCount = 0;
        for (const sent of refSentences) {
            const sentTokens = tokenize(sent);
            if (sentTokens.length === 0) { supportedCount++; continue; }
            let maxOverlap = 0;
            for (const chunk of trace.retrieved_chunks) {
                const chunkTokens = new Set(tokenize(chunk.text));
                const overlap = sentTokens.filter(t => chunkTokens.has(t)).length;
                maxOverlap = Math.max(maxOverlap, overlap);
            }
            if (maxOverlap / sentTokens.length >= 0.5) supportedCount++;
        }
        contextRecall = supportedCount / refSentences.length;
    }
    
    // --- Context Precision (AP@K) ---
    const relevantSet = new Set(gt.relevant_chunk_ids);
    const retrieved = trace.retrieved_chunks.map(c => c.chunk_id);
    let hits = 0, sumPrecision = 0;
    for (let i = 0; i < retrieved.length; i++) {
        if (relevantSet.has(retrieved[i])) {
            hits++;
            sumPrecision += hits / (i + 1);
        }
    }
    const contextPrecision = relevantSet.size === 0 ? 1.0 : sumPrecision / relevantSet.size;
    
    // Store results
    results[tid] = {
        faithfulness: r2(faithfulness),
        answer_relevance: r2(answerRelevance),
        context_recall: r2(contextRecall),
        context_precision: r2(contextPrecision)
    };
}

console.log(JSON.stringify(results));
```

---

## Output Format

```json
{
  "T001": {
    "faithfulness": 1.0,
    "answer_relevance": 0.99,
    "context_recall": 1.0,
    "context_precision": 1.0
  },
  "T002": { ... },
  ...
  "T096": { ... }
}
```

> [!IMPORTANT]
> All values must be rounded to **exactly 2 decimal places**.

---

## Common Mistakes to Avoid

| ❌ Mistake | ✅ Fix |
|-----------|--------|
| Forgetting to filter sentences ≤ 5 chars | Always filter: `.filter(s => s.trim().length > 5)` |
| Using ALL tokens overlap instead of per-chunk max | Compare each sentence against EACH chunk individually, take MAX |
| Dividing AP@K by retrieved count | Divide by `relevant_chunk_ids.length` |
| Not rounding to 2 decimal places | Use `Math.round(val * 100) / 100` |
| Using wrong embedding files | answer_embeddings for answer, question_embeddings for question |

---

## Key Concepts

### Faithfulness
- Checks: "Is the answer actually based on what was retrieved?"
- Low faithfulness = the model is hallucinating (making stuff up)
- Example: If retrieved chunks say "fuel savings of 15%" but the answer says "quantum computing", faithfulness = 0

### Answer Relevance  
- Checks: "Does the answer actually address the question?"
- Uses embedding similarity (semantic meaning)
- An answer can be faithful but irrelevant (copies chunk text but doesn't answer the question)

### Context Recall
- Checks: "Did we retrieve enough relevant information?"
- Compares reference answer sentences against retrieved chunks
- Low recall = we missed important chunks during retrieval

### Context Precision (AP@K)
- Checks: "Are relevant chunks ranked at the top?"
- Even if all relevant chunks are retrieved, their ORDER matters
- AP@K rewards putting relevant chunks at positions 1, 2 rather than 2, 3
