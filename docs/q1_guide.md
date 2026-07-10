# 🔥 Complete Guide: End-to-End Chunking & Hybrid Retrieval Pipeline (Q1)

> [!IMPORTANT]
> Har student ka dataset alag hota hai, so **answers alag honge**. But the **approach/code** is EXACTLY the same. Just apna zip file use karo.

---

## Step 0: Setup

1. Download your student-specific zip file
2. Extract it — you'll get a folder `rag_pipeline/` with these files:
   - `documents.jsonl` — 64 documents
   - `chunk_rules.json` — chunking parameters
   - `chunk_embeddings.json` — pre-computed 100-dim vectors for chunks
   - `queries.json` — 80 test queries
   - `query_embeddings.json` — pre-computed 100-dim vectors for queries

---

## Step 1: Read `chunk_rules.json`

```json
{"strategy": "sentence", "chunk_size": 3, "overlap": 1, "rrf_k": 60, "top_k": 5}
```

Key parameters:
| Parameter | Meaning |
|-----------|---------|
| `strategy` | "sentence" — split text into sentences first |
| `chunk_size` | 3 — each chunk = 3 sentences |
| `overlap` | 1 — consecutive chunks share 1 sentence |
| `rrf_k` | 60 — the k parameter in the RRF formula |
| `top_k` | 5 — return top 5 chunks per query |

---

## Step 2: Sentence Splitting

Split each document's text using this regex:
```javascript
const sentences = doc.text.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
```

> [!NOTE]
> This splits on period, exclamation, or question mark **followed by one or more whitespace characters**.
> The last sentence may still have a trailing period (that's fine).
> Filter out any empty strings.

---

## Step 3: Chunking (Sliding Window)

```javascript
const step = chunk_size - overlap;  // 3 - 1 = 2
for (let i = 0; i < sentences.length; i += step) {
    const chunkSents = sentences.slice(i, i + chunk_size);
    // Join sentences with space
    const chunkText = chunkSents.join(' ');
}
```

### Chunk ID Format
Use a **global counter** across ALL documents:
```
DOC_1_CHUNK_000, DOC_1_CHUNK_001, ..., DOC_1_CHUNK_005,
DOC_2_CHUNK_006, DOC_2_CHUNK_007, ..., DOC_2_CHUNK_011,
...
DOC_64_CHUNK_378, ..., DOC_64_CHUNK_383
```

Total = 384 chunks (64 docs × 6 chunks each).

> [!IMPORTANT]
> The chunk ID uses the document's `doc_id` field (e.g., `DOC_1`) + `_CHUNK_` + 3-digit zero-padded global index.
> Verify your chunk IDs match the keys in `chunk_embeddings.json`.

---

## Step 4: Tokenization (for BM25)

```javascript
function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9]+/g)) || [];
}
```

This extracts all lowercase alphanumeric words. Strips punctuation, markdown symbols, etc.

---

## Step 5: BM25 Scoring

### Pre-compute corpus statistics:
```javascript
// For each chunk, compute:
// - tokens (tokenized text)
// - document length (dl = number of tokens)
// For the corpus:
// - df[term] = number of chunks containing that term
// - avgdl = average document length across all chunks
// - N = total number of chunks (384)
```

### BM25 Formula (per query-chunk pair):

```
score = Σ IDF(q) × TF_norm(q, chunk)
```

Where:
```
IDF(q) = log((N - df + 0.5) / (df + 0.5) + 1.0)    ← Lucene-style, always positive

TF_norm = (tf × (k1 + 1)) / (tf + k1 × (1 - b + b × dl/avgdl))
```

**Default parameters: `k1 = 1.5`, `b = 0.75`**

> [!IMPORTANT]
> The IDF formula uses `+ 1.0` inside the log. This is the **Lucene/Elasticsearch** variant that ensures IDF is always non-negative.
> `log` here is **natural log** (`Math.log` in JS, `math.log` in Python).

### Sum over unique query terms only (deduplicate).

---

## Step 6: Dense (Cosine Similarity) Scoring

Use the **pre-computed embeddings** from `chunk_embeddings.json` and `query_embeddings.json`.

```javascript
function cosineSim(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

---

## Step 7: Ranking with Tie-Breaking

### ⚠️ THIS IS THE CRITICAL PART — Most errors happen here!

For **BOTH** BM25 and Dense rankings:
1. Sort all 384 chunks by score **descending**
2. For ties, use **`localeCompare`** in JavaScript

```javascript
// BM25 ranking
bm25Scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

// Dense ranking  
denseScores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
```

> [!CAUTION]
> **DO NOT use `<` / `>` operators for string comparison!**
> `localeCompare` does **numeric-aware** sorting:
> - `"DOC_6".localeCompare("DOC_22")` → DOC_6 comes BEFORE DOC_22 (because 6 < 22)
> - With `<` operator: `"DOC_6" > "DOC_22"` is `true` (because '6' > '2' in ASCII)
> 
> This difference affects ~32 out of 80 queries!

Assign ranks 1, 2, 3, ... (1-indexed) after sorting.

---

## Step 8: RRF (Reciprocal Rank Fusion)

```javascript
// For each chunk:
rrfScore = 1.0 / (rrf_k + bm25Rank) + 1.0 / (rrf_k + denseRank)

// rrf_k = 60 (from chunk_rules.json)
```

Then sort by RRF score descending, tie-break with `localeCompare`:
```javascript
rrfScores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
```

Take the **top 5** (`top_k = 5`).

---

## Step 9: Output Format

```json
{
  "Q001": ["chunk_id_1", "chunk_id_2", "chunk_id_3", "chunk_id_4", "chunk_id_5"],
  "Q002": ["...", "...", "...", "...", "..."],
  ...
  "Q080": ["...", "...", "...", "...", "..."]
}
```

---

## Complete Working Code (JavaScript — Node.js)

Save this as `solve.js` and run with `node solve.js`:

```javascript
const fs = require('fs');

const DATA_DIR = 'rag_pipeline';
const documents = fs.readFileSync(`${DATA_DIR}/documents.jsonl`, 'utf8')
    .trim().split('\n').map(JSON.parse);
const rules = JSON.parse(fs.readFileSync(`${DATA_DIR}/chunk_rules.json`, 'utf8'));
const chunkEmbeddings = JSON.parse(fs.readFileSync(`${DATA_DIR}/chunk_embeddings.json`, 'utf8'));
const queries = JSON.parse(fs.readFileSync(`${DATA_DIR}/queries.json`, 'utf8'));
const queryEmbeddings = JSON.parse(fs.readFileSync(`${DATA_DIR}/query_embeddings.json`, 'utf8'));

const { chunk_size, overlap, rrf_k, top_k } = rules;

// --- Step 1: Chunking ---
const chunks = [];
let globalIdx = 0;
for (const doc of documents) {
    const sentences = doc.text.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
    const step = chunk_size - overlap;
    for (let i = 0; i < sentences.length; i += step) {
        const chunkSents = sentences.slice(i, i + chunk_size);
        if (chunkSents.length > 0) {
            const chunkId = `${doc.doc_id}_CHUNK_${String(globalIdx).padStart(3, '0')}`;
            chunks.push({ id: chunkId, text: chunkSents.join(' ') });
            globalIdx++;
        }
    }
}

// --- Step 2: Tokenization & BM25 Setup ---
function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9]+/g)) || [];
}

const N = chunks.length;
const corpusTokens = {};
const dfMap = {};
let totalDl = 0;

for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    corpusTokens[chunk.id] = tokens;
    totalDl += tokens.length;
    for (const term of new Set(tokens)) {
        dfMap[term] = (dfMap[term] || 0) + 1;
    }
}
const avgdl = totalDl / N;

// --- Step 3: BM25 Score Function ---
function bm25Score(queryTokens, chunkId, k1 = 1.5, b = 0.75) {
    const docTokens = corpusTokens[chunkId];
    const dl = docTokens.length;
    const tfMap = {};
    for (const t of docTokens) tfMap[t] = (tfMap[t] || 0) + 1;

    let score = 0;
    const seen = new Set();
    for (const qt of queryTokens) {
        if (seen.has(qt)) continue;
        seen.add(qt);
        if (!(qt in tfMap)) continue;
        const tf = tfMap[qt];
        const df = dfMap[qt] || 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);
        score += idf * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));
    }
    return score;
}

// --- Step 4: Cosine Similarity ---
function cosineSim(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// --- Step 5: Main Pipeline ---
const results = {};

for (const q of queries) {
    const qid = q.query_id;
    const qTokens = tokenize(q.text);
    const qEmb = queryEmbeddings[qid];

    // BM25 ranking (sort desc, tie-break localeCompare)
    const bm25Scores = chunks.map(c => ({ id: c.id, score: bm25Score(qTokens, c.id) }));
    bm25Scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const bm25Rank = {};
    bm25Scores.forEach((item, idx) => { bm25Rank[item.id] = idx + 1; });

    // Dense ranking (sort desc, tie-break localeCompare)
    const denseScores = chunks.map(c => ({ id: c.id, score: cosineSim(qEmb, chunkEmbeddings[c.id]) }));
    denseScores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const denseRank = {};
    denseScores.forEach((item, idx) => { denseRank[item.id] = idx + 1; });

    // RRF fusion
    const rrfScores = chunks.map(c => ({
        id: c.id,
        score: 1.0 / (rrf_k + bm25Rank[c.id]) + 1.0 / (rrf_k + denseRank[c.id])
    }));
    rrfScores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    results[qid] = rrfScores.slice(0, top_k).map(item => item.id);
}

// Output
console.log(JSON.stringify(results));
```

---

## Common Mistakes to Avoid

| ❌ Mistake | ✅ Fix |
|-----------|--------|
| Using Python's `<` for string sort | Use JS `localeCompare` or Python equivalent |
| Using `k1 = 1.2` | Use `k1 = 1.5` (default) |
| Using classic IDF `log((N-df+0.5)/(df+0.5))` | Use Lucene IDF `log((N-df+0.5)/(df+0.5) + 1.0)` |
| Competition ranking (tied items get same rank) | Sequential ranking (each item gets unique rank 1,2,3...) |
| Stable sort without explicit tie-breaking | Always use `localeCompare` for tie-breaking |
| Using `\b[a-z0-9]+\b` for tokenization | Use `[a-z0-9]+` (no word boundary needed) |

---

## Key Concepts (for viva/understanding)

### BM25 (Best Matching 25)
- A probabilistic ranking function used in information retrieval
- **k1** controls term frequency saturation (higher = more weight to repeated terms)
- **b** controls document length normalization (b=1 means full normalization, b=0 means no normalization)
- IDF penalizes common terms and boosts rare terms

### Cosine Similarity
- Measures angle between two vectors in embedding space
- Range: [-1, 1] (for normalized vectors) or [0, 1] (for positive embeddings)
- Higher = more similar

### RRF (Reciprocal Rank Fusion)
- Combines rankings from multiple retrievers (sparse BM25 + dense embeddings)
- Formula: `Score(d) = Σ 1/(k + rank_i(d))`
- k=60 dampens the effect of high ranks
- Does NOT use raw scores — only rank positions matter
- Robust because it doesn't need score calibration between different retrievers

### Sentence Chunking with Overlap
- **Why overlap?** Prevents information loss at chunk boundaries
- With size=3, overlap=1: chunks share 1 sentence with their neighbors
- Step = size - overlap = 2 (advance by 2 sentences each time)
