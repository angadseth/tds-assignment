/*
 * Q2: RAG Evaluation Harness — RAGAS-style Metrics
 *
 * Computes four quality metrics for each of 96 RAG traces:
 *   1. Faithfulness    — is the answer grounded in retrieved chunks?
 *   2. Answer Relevance — does the answer address the question?
 *   3. Context Recall   — are all reference-answer facts covered by retrieval?
 *   4. Context Precision — AP@K for retrieved chunk ordering
 *
 * Run: node q2_evaluation_harness.js
 */

const fs = require('fs');

// ──────────────────────────── Load Data ────────────────────────────

const DATA_DIR = 'rag_eval';

const traces = fs.readFileSync(`${DATA_DIR}/traces.jsonl`, 'utf8')
    .trim().split('\n').map(JSON.parse);

const groundTruth = fs.readFileSync(`${DATA_DIR}/ground_truth.jsonl`, 'utf8')
    .trim().split('\n').map(JSON.parse);

const answerEmbeddings = JSON.parse(
    fs.readFileSync(`${DATA_DIR}/answer_embeddings.json`, 'utf8')
);
const questionEmbeddings = JSON.parse(
    fs.readFileSync(`${DATA_DIR}/question_embeddings.json`, 'utf8')
);

console.log(`Loaded ${traces.length} traces, ${groundTruth.length} ground truth entries`);

// index ground truth by trace_id for quick lookup
const gtMap = {};
for (const gt of groundTruth) {
    gtMap[gt.trace_id] = gt;
}

// ──────────────────────── Helper Functions ──────────────────────────

/**
 * Tokenize text into lowercase alphanumeric tokens.
 * Matches the same pattern used across the pipeline.
 */
function tokenize(text) {
    return (text.toLowerCase().match(/[a-z0-9]+/g)) || [];
}

/**
 * Split text into sentences using [.!?]\s+ and filter out
 * very short segments (<=5 chars) which are likely artifacts.
 */
function splitSentences(text) {
    return text.split(/[.!?]\s+/).filter(s => s.trim().length > 5);
}

/**
 * Cosine similarity between two embedding vectors.
 */
function cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Round a float to exactly 2 decimal places.
 */
function round2(val) {
    return Math.round(val * 100) / 100;
}

/**
 * Compute the maximum token overlap ratio between a sentence
 * and any individual chunk from a list of retrieved chunks.
 * 
 * For each chunk, we count how many of the sentence's tokens
 * appear in the chunk's token set, then take the max across chunks.
 * Returns the ratio (0 to 1).
 */
function maxChunkOverlap(sentTokens, retrievedChunks) {
    if (sentTokens.length === 0) return 1.0;

    let best = 0;
    for (const chunk of retrievedChunks) {
        const chunkTokenSet = new Set(tokenize(chunk.text));
        const overlap = sentTokens.filter(t => chunkTokenSet.has(t)).length;
        best = Math.max(best, overlap);
    }
    return best / sentTokens.length;
}

// ──────────────────── Metric Implementations ────────────────────────

/**
 * FAITHFULNESS
 * 
 * Measures how well the generated answer is supported by retrieved chunks.
 * - Split generated answer into sentences
 * - For each sentence, check if >=50% of its tokens appear in any single chunk
 * - Faithfulness = (supported sentences) / (total sentences)
 */
function computeFaithfulness(trace) {
    const sentences = splitSentences(trace.generated_answer);
    if (sentences.length === 0) return 1.0;

    let supported = 0;
    for (const sent of sentences) {
        const tokens = tokenize(sent);
        if (tokens.length === 0) {
            supported++;
            continue;
        }
        const overlapRatio = maxChunkOverlap(tokens, trace.retrieved_chunks);
        if (overlapRatio >= 0.5) supported++;
    }

    return supported / sentences.length;
}

/**
 * ANSWER RELEVANCE
 * 
 * Measures semantic similarity between the generated answer and the question.
 * Simply the cosine similarity of their pre-computed embeddings.
 */
function computeAnswerRelevance(traceId) {
    return cosineSimilarity(
        answerEmbeddings[traceId],
        questionEmbeddings[traceId]
    );
}

/**
 * CONTEXT RECALL
 * 
 * Measures whether the retrieved chunks contain information from the reference answer.
 * - Split reference answer into sentences
 * - For each sentence, check if >=50% of its tokens appear in any retrieved chunk
 * - Context Recall = (supported ref sentences) / (total ref sentences)
 */
function computeContextRecall(trace, gt) {
    const refSentences = splitSentences(gt.reference_answer);
    if (refSentences.length === 0) return 1.0;

    let supported = 0;
    for (const sent of refSentences) {
        const tokens = tokenize(sent);
        if (tokens.length === 0) {
            supported++;
            continue;
        }
        const overlapRatio = maxChunkOverlap(tokens, trace.retrieved_chunks);
        if (overlapRatio >= 0.5) supported++;
    }

    return supported / refSentences.length;
}

/**
 * CONTEXT PRECISION (Average Precision @ K)
 * 
 * Measures if relevant chunks are ranked higher in the retrieved list.
 * - Walk through retrieved chunks in order
 * - At each position where a relevant chunk appears, compute precision
 * - AP = sum of these precisions / total number of relevant chunks
 */
function computeContextPrecision(trace, gt) {
    const relevantSet = new Set(gt.relevant_chunk_ids);
    if (relevantSet.size === 0) return 1.0;

    const retrieved = trace.retrieved_chunks.map(c => c.chunk_id);

    let hits = 0;
    let precisionSum = 0;

    for (let i = 0; i < retrieved.length; i++) {
        if (relevantSet.has(retrieved[i])) {
            hits++;
            precisionSum += hits / (i + 1);  // precision at this position
        }
    }

    return precisionSum / relevantSet.size;
}

// ──────────────────────── Main Evaluation Loop ──────────────────────

const results = {};

for (const trace of traces) {
    const tid = trace.trace_id;
    const gt = gtMap[tid];

    results[tid] = {
        faithfulness:      round2(computeFaithfulness(trace)),
        answer_relevance:  round2(computeAnswerRelevance(tid)),
        context_recall:    round2(computeContextRecall(trace, gt)),
        context_precision: round2(computeContextPrecision(trace, gt))
    };
}

// ──────────────────────────── Output ────────────────────────────

const output = JSON.stringify(results);
console.log(output);

fs.writeFileSync(`${DATA_DIR}/results.json`, output);
console.log(`\nResults saved to ${DATA_DIR}/results.json`);
