import React, { useState, useEffect } from 'react';
import { FileText, Trash2, Upload, AlertCircle, Plus } from 'lucide-react';

interface PersonalContextDoc {
    id: string;
    fileName: string;
    fileType: string;
    chunkCount: number;
    createdAt: string;
}

export const PersonalContextSettings: React.FC = () => {
    const [docs, setDocs] = useState<PersonalContextDoc[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        loadDocs();
    }, []);

    const loadDocs = async () => {
        try {
            const res = await window.electronAPI?.getPersonalContextDocs?.();
            if (res.success) {
                setDocs(res.docs || []);
            } else {
                setError(res.error || 'Failed to load documents');
            }
        } catch (e: any) {
            setError(e.message);
        }
    };

    const handleUpload = async () => {
        setError(null);
        try {
            const selRes = await window.electronAPI?.selectPersonalContextFile?.();
            if (selRes.success && selRes.filePath) {
                setIsLoading(true);
                const addRes = await window.electronAPI?.addPersonalContextDoc?.(selRes.filePath);
                if (addRes.success) {
                    await loadDocs();
                } else if (addRes.alreadyIndexed) {
                    setError('Document is already indexed.');
                } else {
                    setError(addRes.error || 'Failed to ingest document');
                }
            } else if (selRes.error !== 'canceled') {
                setError(selRes.error || 'Failed to select file');
            }
        } catch (e: any) {
            setError(e.message);
        } finally {
            setIsLoading(false);
        }
    };

    const handleRemove = async (docId: string) => {
        try {
            const res = await window.electronAPI?.removePersonalContextDoc?.(docId);
            if (res.success) {
                await loadDocs();
            } else {
                setError(res.error || 'Failed to remove document');
            }
        } catch (e: any) {
            setError(e.message);
        }
    };

    return (
        <div className="space-y-6 animated fadeIn">
            <div className="flex items-center gap-3 mb-6">
                <FileText className="text-accent-primary" size={24} />
                <div>
                    <h2 className="text-xl font-bold text-text-primary">Personal Context (RAG)</h2>
                    <p className="text-sm text-text-secondary mt-1">Upload files to give the AI factual background context about you.</p>
                </div>
            </div>

            <div className="bg-bg-component rounded-xl border border-border-subtle p-6 space-y-6">
                <div>
                    <h3 className="text-base font-semibold text-text-primary">Your Documents</h3>
                    <p className="text-xs text-text-secondary mt-1">Documents uploaded here are stored locally and only sent to cloud models when relevant to your prompt.</p>
                </div>

                {error && (
                    <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 flex items-start gap-3">
                        <AlertCircle size={16} className="text-red-500 mt-0.5" />
                        <div className="text-sm text-red-500">{error}</div>
                    </div>
                )}

                <div className="space-y-3">
                    {docs.length === 0 && !isLoading && (
                        <div className="text-center py-8 bg-bg-main rounded-lg border border-border-subtle border-dashed">
                            <p className="text-sm text-text-secondary">No documents uploaded yet.</p>
                        </div>
                    )}
                    
                    {docs.map(doc => (
                        <div key={doc.id} className="flex items-center justify-between p-3 bg-bg-main rounded-lg border border-border-subtle hover:bg-bg-item-surface transition-colors">
                            <div className="flex items-center gap-3">
                                <FileText size={18} className="text-text-secondary" />
                                <div>
                                    <div className="text-sm font-medium text-text-primary">{doc.fileName}</div>
                                    <div className="text-xs text-text-secondary flex gap-2">
                                        <span>{doc.chunkCount} chunks</span>
                                        <span>&bull;</span>
                                        <span>{new Date(doc.createdAt).toLocaleDateString()}</span>
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={() => handleRemove(doc.id)}
                                className="p-2 text-text-secondary hover:text-red-500 hover:bg-red-500/10 rounded-md transition-colors"
                                title="Remove document"
                            >
                                <Trash2 size={16} />
                            </button>
                        </div>
                    ))}
                </div>

                <div className="pt-2 border-t border-border-subtle">
                    <button
                        onClick={handleUpload}
                        disabled={isLoading}
                        className="flex items-center gap-2 px-4 py-2 bg-accent-primary hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors w-full justify-center disabled:opacity-50"
                    >
                        {isLoading ? <span className="animate-spin h-4 w-4 border-2 border-white/20 border-t-white rounded-full" /> : <Plus size={16} />}
                        {isLoading ? 'Processing...' : 'Add Document'}
                    </button>
                    <p className="text-[11px] text-text-secondary text-center mt-3">Supported formats: PDF, DOCX, TXT, MD</p>
                </div>
            </div>
        </div>
    );
};
