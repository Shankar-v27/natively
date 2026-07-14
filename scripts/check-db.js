const Database = require('better-sqlite3');
const db = new Database('C:\\Users\\shank\\AppData\\Roaming\\natively\\natively.db');

try {
    const docs = db.prepare(`
        SELECT d.id, d.file_name, d.chunk_count, 
               COUNT(c.rowid) as embedded_chunks, d.embedding_model 
        FROM personal_context_docs d 
        LEFT JOIN personal_context_chunks c ON c.doc_id = d.id AND c.embedding IS NOT NULL 
        GROUP BY d.id;
    `).all();
    
    console.log("Docs:", docs);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_personal_chunks_%'").all();
    console.log("Vector Tables:", tables);
    
    for (const t of tables) {
        const rows = db.prepare(`SELECT count(*) as cnt FROM ${t.name}`).get();
        console.log(t.name, "count:", rows.cnt);
    }
} catch (e) {
    console.error(e);
}
db.close();
