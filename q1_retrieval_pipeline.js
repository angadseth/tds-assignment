/*
 * Q1: End-to-End Chunking & Hybrid Retrieval Pipeline
 * 
 * Pipeline overview:
 *   Documents → Sentence Chunking → BM25 + Dense Retrieval → RRF Fusion → Top-K Results
 * 
 * Run: node q1_retrieval_pipeline.js
 */

const fs = require('fs');

// ──────────────────────────── Load Data ────────────────────────────

const DATA_DIR = 'rag_pipeline';

const documents = fs.readFileSync(`${DATA_DIR}/documents.jsonl`, 'utf8')
    .trim().split('\n').map(JSON.parse);

const rules = JSON.parse(fs.readFileSync(`${DATA_DIR}/chunk_rules.json`, 'utf8'));
const chunkEmbeddings = JSON.parse(fs.readFileSync(`${DATA_DIR}/chunk_embeddings.json`, 'utf8'));
const queries = JSON.parse(fs.readFileSync(`${DATA_DIR}/queries.json`, 'utf8'));
const queryEmbeddings = JSON.parse(fs.readFileSync(`${DATA_DIR}/query_embeddings.json`, 'utf8'));

const { chunk_size, overlap, rrf_k, top_k } = rules;
const step = chunk_size - overlap;

console.log(`Loaded ${documents.length} documents, ${queries.length} queries`);
console.log(`Chunk params: size=${chunk_size}, overlap=${overlap}, rrf_k=${rrf_k}, top_k=${top_k}`);

// ──────────────────────────── Chunking ────────────────────────────
// Split each document into sentences using [.!?]\s+ and create
// overlapping chunks of `chunk_size` sentences with `overlap` shared.

const chunks = [];
let globalIdx = 0;

for (const doc of documents) {
    // sentence splitting — regex splits on sentence-ending punctuation followed by whitespace
    const sentences = doc.text.split(/[.!?]\s+/).filter(s => s.trim().length > 0);

    for (let i = 0; i < sentences.length; i += step) {
        const chunkSents = sentences.slice(i, i + chunk_size);
        if (chunkSents.length > 0) {
            const chunkId = `${doc.doc_id}_CHUNK_${String(globalIdx).padStart(3, '0')}`;
            chunks.push({ id: chunkId, text: chunkSents.join(' ') });
            globalIdx++;
        }
    }
}

console.log(`Created ${chunks.length} chunks`);

// verify our chunk IDs match the provided embeddings
const embKeys = new Set(Object.keys(chunkEmbeddings));
const ourKeys = new Set(chunks.map(c => c.id));
if (embKeys.size !== ourKeys.size || [...embKeys].some(k => !ourKeys.has(k))) {
    console.error('WARNING: chunk ID mismatch with embeddings!');
}

// ──────────────────────── Tokenization + BM25 Setup ──────────────────────

function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9]+/g)) || [];
}

const N = chunks.length;
const corpusTokens = {};  // chunk_id -> token list
const dfMap = {};          // term -> document frequency
let totalDocLen = 0;

for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    corpusTokens[chunk.id] = tokens;
    totalDocLen += tokens.length;

    // count df — each term counted once per document (chunk)
    const uniqueTerms = new Set(tokens);
    for (const term of uniqueTerms) {
        dfMap[term] = (dfMap[term] || 0) + 1;
    }
}

const avgdl = totalDocLen / N;

// ──────────────────────────── BM25 Scoring ────────────────────────────
// Using Lucene/ES-style IDF: log((N - df + 0.5) / (df + 0.5) + 1)
// This variant guarantees non-negative IDF values.
// Default parameters: k1=1.5, b=0.75

function bm25Score(queryTokens, chunkId) {
    const k1 = 1.5, b = 0.75;
    const docTokens = corpusTokens[chunkId];
    const dl = docTokens.length;

    // build term frequency map for this document
    const tfMap = {};
    for (const t of docTokens) {
        tfMap[t] = (tfMap[t] || 0) + 1;
    }

    let score = 0;
    const processedTerms = new Set();

    for (const qt of queryTokens) {
        if (processedTerms.has(qt)) continue;  // each query term counted once
        processedTerms.add(qt);

        if (!(qt in tfMap)) continue;  // term not in document

        const tf = tfMap[qt];
        const df = dfMap[qt] || 0;

        // Lucene IDF — always non-negative
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1.0);

        // BM25 TF normalization
        const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * dl / avgdl));

        score += idf * tfNorm;
    }

    return score;
}

// ──────────────────────── Cosine Similarity ──────────────────────────

function cosineSimilarity(vecA, vecB) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ──────────────────────── Main Retrieval Loop ────────────────────────

const results = {};

for (const query of queries) {
    const qid = query.query_id;
    const qTokens = tokenize(query.text);
    const qEmb = queryEmbeddings[qid];

    // Step 1: BM25 ranking — descending score, ties broken by localeCompare on chunk ID
    const sparseScores = chunks.map(c => ({
        id: c.id,
        score: bm25Score(qTokens, c.id)
    }));
    sparseScores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const sparseRank = {};
    sparseScores.forEach((item, idx) => { sparseRank[item.id] = idx + 1; });

    // Step 2: Dense ranking — same sorting logic
    const denseScores = chunks.map(c => ({
        id: c.id,
        score: cosineSimilarity(qEmb, chunkEmbeddings[c.id])
    }));
    denseScores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    const denseRank = {};
    denseScores.forEach((item, idx) => { denseRank[item.id] = idx + 1; });

    // Step 3: RRF fusion — combine sparse and dense ranks
    const rrfScores = chunks.map(c => ({
        id: c.id,
        score: 1.0 / (rrf_k + sparseRank[c.id]) + 1.0 / (rrf_k + denseRank[c.id])
    }));
    rrfScores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

    // take top_k
    results[qid] = rrfScores.slice(0, top_k).map(item => item.id);
}

// ──────────────────────────── Output ────────────────────────────

const output = JSON.stringify(results);
console.log(output);

// also save to file for reference
fs.writeFileSync(`${DATA_DIR}/final_results.json`, output);
console.log(`\nResults saved to ${DATA_DIR}/final_results.json`);
