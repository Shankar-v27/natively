import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseManager } from '../db/DatabaseManager';
import { AppState } from '../main';

// Basic wrapper timeout for parsers
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// We cannot easily import pinPdfjsWorkerSrcOnce from ipcHandlers, so we reproduce it here to ensure PDFParse works.
let pdfjsWorkerSrcPinned = false;
async function pinPdfjsWorkerSrcOnce(): Promise<void> {
    if (pdfjsWorkerSrcPinned) return;
    try {
        const { pathToFileURL } = require('url');
        const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs');
        pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
        pdfjsWorkerSrcPinned = true;
    } catch (e: any) {
        console.warn('[PersonalContextService] pdfjs-dist workerSrc pin failed:', e.message);
    }
}

export interface PersonalContextDoc {
    id: string;
    fileName: string;
    fileType: string;
    sourcePath: string;
    contentHash: string;
    chunkCount: number;
    createdAt: string;
    updatedAt: string;
}

export interface PersonalContextChunk {
    id: string;
    docId: string;
    chunkIndex: number;
    text: string;
    tokenCount: number;
}

export class PersonalContextService {
    private static instance: PersonalContextService;
    private dbManager = DatabaseManager.getInstance();

    private constructor() {}

    public static getInstance(): PersonalContextService {
        if (!PersonalContextService.instance) {
            PersonalContextService.instance = new PersonalContextService();
            PersonalContextService.instance.normalizeStoredVectors();
        }
        return PersonalContextService.instance;
    }

    private normalizeStoredVectors(): void {
        const db = this.dbManager.getDb();
        if (!db) return;
        try {
            const sample = db.prepare("SELECT rowid, embedding FROM personal_context_chunks WHERE embedding IS NOT NULL LIMIT 1").get() as { rowid: bigint, embedding: Buffer } | undefined;
            if (!sample) return;
            
            const buf = sample.embedding;
            const floatArr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
            let sumSq = 0;
            for (let i = 0; i < floatArr.length; i++) {
                sumSq += floatArr[i] * floatArr[i];
            }
            if (Math.abs(sumSq - 1.0) < 0.05) {
                return;
            }
            console.log(`[PersonalContextService] Unnormalized vectors detected (norm squared = ${sumSq}). Normalizing all stored vectors...`);
            
            const chunks = db.prepare("SELECT rowid, id, embedding FROM personal_context_chunks WHERE embedding IS NOT NULL").all() as { rowid: bigint, id: string, embedding: Buffer }[];
            const dim = floatArr.length;
            
            db.transaction(() => {
                // Delete existing vec virtual table rows first to prevent UNIQUE constraint errors
                db.prepare(`DELETE FROM vec_personal_chunks_${dim}`).run();
                
                const updateChunk = db.prepare("UPDATE personal_context_chunks SET embedding = ? WHERE id = ?");
                const insertVec = db.prepare(`INSERT INTO vec_personal_chunks_${dim} (chunk_id, embedding) VALUES (?, ?)`);
                
                for (const chunk of chunks) {
                    const originalFloat = new Float32Array(chunk.embedding.buffer, chunk.embedding.byteOffset, chunk.embedding.byteLength / 4);
                    let sum = 0;
                    for (let i = 0; i < originalFloat.length; i++) {
                        sum += originalFloat[i] * originalFloat[i];
                    }
                    const norm = Math.sqrt(sum);
                    const normalizedFloat = new Float32Array(originalFloat.length);
                    if (norm > 0) {
                        for (let i = 0; i < originalFloat.length; i++) {
                            normalizedFloat[i] = originalFloat[i] / norm;
                        }
                    }
                    const blob = Buffer.from(normalizedFloat.buffer);
                    updateChunk.run(blob, chunk.id);
                    insertVec.run(BigInt(chunk.rowid), blob);
                }
            })();
            console.log(`[PersonalContextService] Successfully normalized ${chunks.length} stored vectors.`);
        } catch (e: any) {
            console.warn('[PersonalContextService] Failed to normalize stored vectors:', e.message);
        }
    }

    private computeHash(buffer: Buffer): string {
        return crypto.createHash('sha256').update(buffer).digest('hex');
    }

    private estimateTokens(text: string): number {
        return Math.ceil(text.length / 4);
    }

    /**
     * Chunk text respecting Markdown headings.
     */
    private chunkText(text: string): string[] {
        const lines = text.split('\n');
        const chunks: string[] = [];
        let currentChunk = '';
        let currentTokens = 0;
        const MAX_TOKENS = 400;

        for (const line of lines) {
            const isHeading = line.trim().startsWith('#');
            const lineTokens = this.estimateTokens(line);

            if ((isHeading && currentTokens > 100) || (currentTokens + lineTokens > MAX_TOKENS)) {
                if (currentChunk.trim()) {
                    chunks.push(currentChunk.trim());
                }
                currentChunk = '';
                currentTokens = 0;
            }

            currentChunk += line + '\n';
            currentTokens += lineTokens;
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
        }

        return chunks;
    }

    public async ingestDocument(filePath: string): Promise<{ success: boolean; doc?: PersonalContextDoc; error?: string; alreadyIndexed?: boolean }> {
        try {
            const ext = path.extname(filePath).toLowerCase();
            const buffer = await fs.promises.readFile(filePath);
            const contentHash = this.computeHash(buffer);
            const db = this.dbManager.getDb();
            if (!db) return { success: false, error: 'Database unavailable' };

            // Check if exact file exists
            const existing = db.prepare('SELECT id FROM personal_context_docs WHERE content_hash = ?').get(contentHash) as any;
            if (existing) {
                return { success: true, alreadyIndexed: true };
            }

            // Extract Text
            let rawText = '';
            if (ext === '.pdf') {
                await pinPdfjsWorkerSrcOnce();
                const { PDFParse } = require('pdf-parse');
                const parser = new PDFParse({ data: buffer });
                const data: any = await withTimeout<any>(parser.getText(), 30000, 'PDF parse');
                rawText = data.text || '';
            } else if (ext === '.docx' || ext === '.doc') {
                const mammoth = require('mammoth');
                const result = await withTimeout<any>(mammoth.extractRawText({ path: filePath }), 30000, 'DOCX parse');
                rawText = result.value || '';
            } else {
                rawText = buffer.toString('utf-8');
            }

            if (!rawText.trim()) return { success: false, error: 'File is empty' };

            const chunks = this.chunkText(rawText);
            const docId = `pctx_${crypto.randomUUID()}`;
            const fileName = path.basename(filePath);
            
            const pipeline = AppState.getInstance().getRAGManager?.()?.getEmbeddingPipeline?.();
            if (!pipeline) return { success: false, error: 'Embedding pipeline not available' };

            await pipeline.waitForReady?.(20000);
            const dim = pipeline.getActiveDimensions();
            const activeSpaceKey = pipeline.getActiveSpaceKey?.() || 'unknown';
            this.dbManager.ensureVecTableForDim(dim);

            const tx = db.transaction(() => {
                db.prepare(`
                    INSERT INTO personal_context_docs (id, file_name, file_type, source_path, content_hash, chunk_count, embedding_model)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `).run(docId, fileName, ext, filePath, contentHash, chunks.length, activeSpaceKey);

                const chunkStmt = db.prepare(`
                    INSERT INTO personal_context_chunks (id, doc_id, chunk_index, text, token_count, embedding)
                    VALUES (?, ?, ?, ?, ?, ?)
                `);

                let chunkIndex = 0;
                for (const chunkText of chunks) {
                    const chunkIdStr = crypto.randomUUID();
                    chunkStmt.run(chunkIdStr, docId, chunkIndex++, chunkText, this.estimateTokens(chunkText), null);
                }
            });

            tx();

            // Background embed
            this.embedDocument(docId, chunks, pipeline, dim).catch(e => console.error('[PersonalContextService] Embed failed:', e));

            const doc = db.prepare('SELECT * FROM personal_context_docs WHERE id = ?').get(docId) as any;
            return {
                success: true,
                doc: {
                    id: doc.id,
                    fileName: doc.file_name,
                    fileType: doc.file_type,
                    sourcePath: doc.source_path,
                    contentHash: doc.content_hash,
                    chunkCount: doc.chunk_count,
                    createdAt: doc.created_at,
                    updatedAt: doc.updated_at
                }
            };
        } catch (e: any) {
            console.error('[PersonalContextService] ingestDocument error:', e);
            return { success: false, error: e.message };
        }
    }

    private async embedDocument(docId: string, chunks: string[], pipeline: any, dim: number): Promise<void> {
        const db = this.dbManager.getDb();
        if (!db) return;

        const rows = db.prepare('SELECT rowid, id, text FROM personal_context_chunks WHERE doc_id = ? ORDER BY chunk_index ASC').all(docId) as {rowid: bigint, id: string, text: string}[];
        
        for (const row of rows) {
            try {
                const emb = await pipeline.getEmbedding(row.text);
                const floatArr = new Float32Array(emb);
                const blob = Buffer.from(floatArr.buffer);
                
                db.prepare('UPDATE personal_context_chunks SET embedding = ? WHERE id = ?').run(blob, row.id);
                db.prepare(`INSERT OR REPLACE INTO vec_personal_chunks_${dim} (chunk_id, embedding) VALUES (?, ?)`).run(BigInt(row.rowid), blob);
            } catch (e) {
                console.error(`[PersonalContextService] Failed to embed chunk ${row.id}`, e);
            }
        }
    }

    public getDocuments(): PersonalContextDoc[] {
        const db = this.dbManager.getDb();
        if (!db) return [];
        const rows = db.prepare('SELECT * FROM personal_context_docs ORDER BY created_at DESC').all() as any[];
        return rows.map(r => ({
            id: r.id,
            fileName: r.file_name,
            fileType: r.file_type,
            sourcePath: r.source_path,
            contentHash: r.content_hash,
            chunkCount: r.chunk_count,
            createdAt: r.created_at,
            updatedAt: r.updated_at
        }));
    }

    public removeDocument(docId: string): boolean {
        const db = this.dbManager.getDb();
        if (!db) return false;
        try {
            const pipeline = AppState.getInstance().getRAGManager?.()?.getEmbeddingPipeline?.();
            const dim = pipeline?.getActiveDimensions?.();
            if (dim) {
                const chunks = db.prepare('SELECT rowid FROM personal_context_chunks WHERE doc_id = ?').all(docId) as {rowid: bigint}[];
                const stmt = db.prepare(`DELETE FROM vec_personal_chunks_${dim} WHERE chunk_id = ?`);
                db.transaction(() => {
                    for (const c of chunks) stmt.run(c.rowid);
                })();
            }
            db.prepare('DELETE FROM personal_context_docs WHERE id = ?').run(docId);
            return true;
        } catch (e) {
            console.error('[PersonalContextService] removeDocument error:', e);
            return false;
        }
    }

    public async retrieveRelevantContext(query: string, topK: number = 3): Promise<string> {
        try {
            const pipeline = AppState.getInstance().getRAGManager?.()?.getEmbeddingPipeline?.();
            const dim = pipeline?.getActiveDimensions() || 768;
            this.dbManager.ensureVecTableForDim(dim);
            
            let qEmb: number[];
            try {
                if (pipeline) {
                    qEmb = await pipeline.getEmbeddingForQuery(query);
                } else {
                    throw new Error('Pipeline not available');
                }
            } catch (embErr: any) {
                console.log(`[PersonalContextService] RAG pipeline embedding query failed (${embErr.message}), falling back to direct Ollama embedding provider`);
                const { OllamaEmbeddingProvider } = require('../rag/providers/OllamaEmbeddingProvider');
                const directProvider = new OllamaEmbeddingProvider('http://localhost:11434', 'nomic-embed-text');
                qEmb = await directProvider.embedQuery(query);
            }
            
            const floatArr = new Float32Array(qEmb);
            const blob = Buffer.from(floatArr.buffer);
            
            const db = this.dbManager.getDb();
            if (!db) return '';

            const activeSpaceKey = pipeline?.getActiveSpaceKey?.() || 'ollama:nomic-embed-text:768';
            console.log(`[PersonalContextService] Retrieving for query: "${query}" using space: ${activeSpaceKey}, dim: ${dim}`);

            // Using sqlite-vec KNN search
            const rows = db.prepare(`
                SELECT c.text, v.distance, d.embedding_model
                FROM vec_personal_chunks_${dim} v
                JOIN personal_context_chunks c ON c.rowid = v.chunk_id
                JOIN personal_context_docs d ON c.doc_id = d.id
                WHERE v.embedding MATCH ? AND k = ? AND d.embedding_model = ?
            `).all(blob, topK * 5, activeSpaceKey) as { text: string; distance: number; embedding_model: string }[];

            console.log(`[PersonalContextService] Found ${rows.length} rows matching space ${activeSpaceKey}.`);

            const snippets: string[] = [];
            const seen = new Set<string>();

            for (const r of rows) {
                const similarity = 1.0 - r.distance;
                console.log(`[PersonalContextService] Match distance: ${r.distance}, similarity: ${similarity.toFixed(4)}, model: ${r.embedding_model}, text snippet: ${r.text.substring(0, 50)}`);
                
                if (similarity < 0.14) {
                    console.log(`[PersonalContextService] Rejected chunk due to similarity threshold (similarity ${similarity.toFixed(4)} < 0.14)`);
                    continue;
                }
                
                if (!seen.has(r.text)) {
                    seen.add(r.text);
                    snippets.push(r.text);
                    if (snippets.length >= topK) break;
                }
            }

            if (snippets.length === 0) return '';
            
            return snippets.join('\n\n---\n\n');
        } catch (e) {
            console.error('[PersonalContextService] retrieveRelevantContext error:', e);
            return '';
        }
    }
}
