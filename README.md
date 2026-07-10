# TDS Assignment — RAG Pipeline & Evaluation

This repository contains my solutions for the TDS (Tools in Data Science) graded assignment on building a Retrieval-Augmented Generation (RAG) system.

## Questions Covered

### Q1: Hybrid Retrieval Pipeline
Built an end-to-end chunking and hybrid retrieval pipeline:
- Sentence-based chunking with sliding window (size=3, overlap=1)
- BM25 sparse retrieval (Okapi BM25 with Lucene IDF)  
- Dense retrieval using pre-computed embeddings (cosine similarity)
- Reciprocal Rank Fusion (RRF) to combine rankings
- Returns top-5 chunks per query across 80 test queries

### Q2: RAG Evaluation Harness (RAGAS-style Metrics)
Implemented an offline evaluation harness computing four metrics per trace:
- **Faithfulness**: Token overlap between generated answer sentences and retrieved chunks
- **Answer Relevance**: Cosine similarity between answer and question embeddings
- **Context Recall**: How well retrieved chunks cover the reference answer
- **Context Precision**: Average Precision (AP@K) for chunk ranking quality

## Project Structure

```
├── q1_retrieval_pipeline.js    # Q1: Hybrid retrieval pipeline (Node.js)
├── q2_evaluation_harness.js    # Q2: RAGAS evaluation metrics (Node.js)
├── docs/
│   ├── q1_guide.md             # Step-by-step guide for Q1
│   └── q2_guide.md             # Step-by-step guide for Q2
├── rag_pipeline/               # Q1 dataset (student-specific)
│   ├── documents.jsonl
│   ├── chunk_rules.json
│   ├── chunk_embeddings.json
│   ├── queries.json
│   └── query_embeddings.json
└── rag_eval/                   # Q2 dataset (student-specific)
    ├── traces.jsonl
    ├── ground_truth.jsonl
    ├── answer_embeddings.json
    └── question_embeddings.json
```

## How to Run

```bash
# Q1 — outputs JSON mapping query IDs to top-5 chunk IDs
node q1_retrieval_pipeline.js

# Q2 — outputs JSON mapping trace IDs to 4 evaluation metrics
node q2_evaluation_harness.js
```

Requires Node.js 14+ (for stable sort guarantee and modern JS features).

## Guides

Detailed walkthroughs of the approach, formulas, and common pitfalls:
- [Q1 Guide — Chunking & Hybrid Retrieval Pipeline](docs/q1_guide.md)
- [Q2 Guide — RAG Evaluation Harness (RAGAS-style Metrics)](docs/q2_guide.md)

## Technical Notes

### BM25 Configuration
- IDF formula: Lucene variant `log((N - df + 0.5) / (df + 0.5) + 1)` (always non-negative)
- Parameters: k1=1.5, b=0.75
- Tokenization: lowercase + extract `[a-z0-9]+` matches

### RRF Parameters
- k=60 (from `chunk_rules.json`)
- Tie-breaking: `localeCompare` for chunk ID ordering

### Evaluation Metrics
- Sentence splitting: `[.!?]\s+` regex, filtered for length > 5 chars
- Token overlap threshold: 50% for faithfulness and context recall
- All values rounded to 2 decimal places
