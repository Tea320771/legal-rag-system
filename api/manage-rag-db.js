// /api/manage-rag-db.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Pinecone } from '@pinecone-database/pinecone';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { action, docId, payload } = req.body; 
    // action: 'list', 'get', 'update', 'delete'

    try {
        const index = pinecone.index("legal-rag-db");

        // 1. 목록 조회 (Supabase 기준)
        if (action === 'list') {
            const { data, error } = await supabase
                .from('document_queue')
                .select('id, filename, status, created_at, updated_at')
                .eq('status', 'completed') // 완료된 문서만 RAG DB에 있음
                .order('updated_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, list: data });
        }

        // 2. 상세 조회 (Pinecone 기준)
        if (action === 'get') {
            // Pinecone에서 벡터 데이터와 메타데이터를 직접 가져옴
            const fetchResult = await index.fetch([docId]);
            const vectorData = fetchResult.records[docId];

            if (!vectorData) return res.status(404).json({ error: "Pinecone에서 데이터를 찾을 수 없습니다." });

            return res.status(200).json({ success: true, data: vectorData.metadata });
        }

        // 3. 수정 (Update) - 텍스트 수정 시 재임베딩 필요
        if (action === 'update') {
            const { fullContent, userFeedback, docType } = payload;
            
            // 3-1. 텍스트가 변경되었으므로 다시 임베딩 생성 (Gemini)
            const textToEmbed = `
            [문서 유형]: ${docType}
            [핵심 내용]: ${fullContent}
            [사용자 피드백]: ${userFeedback}
            `.trim();

            const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const embedResult = await embedModel.embedContent(textToEmbed);
            const newVector = embedResult.embedding.values;

            // 3-2. Pinecone 업데이트 (벡터 + 메타데이터 덮어쓰기)
            await index.upsert([{
                id: docId,
                values: newVector,
                metadata: {
                    ...payload, // fullContent, docType 등 업데이트
                    updatedAt: new Date().toISOString() // 수정 시간 기록
                }
            }]);

            // 3-3. Supabase 백업 데이터도 업데이트 (선택 사항)
            await supabase
                .from('document_queue')
                .update({ user_feedback: userFeedback })
                .eq('id', docId);

            return res.status(200).json({ success: true, message: "수정 및 재임베딩 완료" });
        }

        // 4. 삭제 (Delete)
        if (action === 'delete') {
            // 4-1. Pinecone에서 삭제
            await index.deleteOne(docId);

            // 4-2. Supabase 상태 변경 (deleted)
            await supabase
                .from('document_queue')
                .update({ status: 'deleted', pinecone_indexed: false })
                .eq('id', docId);

            return res.status(200).json({ success: true, message: "삭제 완료" });
        }

        return res.status(400).json({ error: "Invalid Action" });

    } catch (error) {
        console.error("RAG Management Error:", error);
        return res.status(500).json({ error: error.message });
    }
}