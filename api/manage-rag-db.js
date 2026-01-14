// /api/manage-rag-db.js
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pinecone } = require('@pinecone-database/pinecone');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { action, docId, payload } = req.body; 

    try {
        const index = pinecone.index("legal-rag-db");

        // =========================================================
        // 1. 목록 조회 (Supabase 원장 기준)
        // =========================================================
        if (action === 'list') {
            const { data, error } = await supabase
                .from('document_queue')
                .select('id, filename, status, created_at, updated_at')
                // [수정 포인트] 'completed'만 보는 게 아니라, 삭제된 것 빼고 다 조회
                .neq('status', 'deleted') 
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, list: data });
        }

        // =========================================================
        // 2. 상세 조회 (Pinecone 데이터 우선)
        // =========================================================
        if (action === 'get') {
            // Pinecone에서 실제 벡터에 저장된 메타데이터를 가져옴
            const fetchResult = await index.fetch([docId]);
            const vectorData = fetchResult.records[docId];

            if (!vectorData) {
                // 만약 Pinecone에 없다면 Supabase에서라도 가져오도록 예외 처리 가능
                // 여기서는 Pinecone 데이터를 기준으로 함
                return res.status(404).json({ error: "Pinecone에 벡터 데이터가 없습니다. (재학습 필요)" });
            }

            return res.status(200).json({ success: true, data: vectorData.metadata });
        }

        // =========================================================
        // 3. 수정 (Update) - 동기화 (Sync)
        // =========================================================
        if (action === 'update') {
            const { fullContent, userFeedback, docType } = payload;
            
            // 3-1. 텍스트 임베딩 재생성 (Gemini)
            const textToEmbed = `
            [문서 유형]: ${docType}
            [핵심 내용]: ${fullContent}
            [사용자 피드백]: ${userFeedback}
            `.trim();

            const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const embedResult = await embedModel.embedContent(textToEmbed);
            const newVector = embedResult.embedding.values;

            // 3-2. Pinecone 업데이트 (벡터 + 메타데이터)
            await index.upsert([{
                id: docId,
                values: newVector,
                metadata: {
                    docType,
                    fullContent, // Pinecone에도 텍스트 저장 (검색 결과 미리보기용)
                    userFeedback,
                    updatedAt: new Date().toISOString()
                }
            }]);

            // 3-3. [중요] Supabase 원본 데이터도 함께 수정 (Sync)
            // 이렇게 해야 나중에 Supabase 데이터만 보고도 내용을 알 수 있음
            const { error: dbError } = await supabase
                .from('document_queue')
                .update({ 
                    status: 'completed', // 수정했으므로 완료 상태로 확정
                    ai_result: { 
                        // ai_result 필드 내부 구조를 유지하며 업데이트 (기존 데이터 손실 방지 로직 필요시 개선 가능)
                        manual_update: true,
                        docType,
                        fullContent,
                        userFeedback 
                    },
                    updated_at: new Date().toISOString()
                })
                .eq('id', docId);

            if (dbError) throw dbError;

            return res.status(200).json({ success: true, message: "DB와 Pinecone 모두 수정 완료" });
        }

        // =========================================================
        // 4. 삭제 (Delete) - 동기화 (Sync)
        // =========================================================
        if (action === 'delete') {
            // 4-1. Pinecone에서 영구 삭제
            await index.deleteOne(docId);

            // 4-2. Supabase에서는 'deleted' 상태로 변경 (Soft Delete)
            const { error: dbError } = await supabase
                .from('document_queue')
                .update({ 
                    status: 'deleted',
                    ai_result: { note: "사용자에 의해 삭제됨" } 
                })
                .eq('id', docId);

            if (dbError) throw dbError;

            return res.status(200).json({ success: true, message: "삭제 완료 (DB: deleted 상태)" });
        }

        return res.status(400).json({ error: "Invalid Action" });

    } catch (error) {
        console.error("RAG Management Error:", error);
        return res.status(500).json({ error: error.message });
    }
};