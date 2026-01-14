// /api/confirm-review.js
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pinecone } = require('@pinecone-database/pinecone');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { docId, userFeedback } = req.body;

    if (!docId) return res.status(400).json({ error: '문서 ID가 필요합니다.' });

    try {
        // 1. DB에서 분석 완료된 데이터 가져오기
        const { data: doc, error } = await supabase
            .from('document_queue')
            .select('*')
            .eq('id', docId)
            .single();

        if (error || !doc) throw new Error("문서를 찾을 수 없습니다.");

        const aiResult = doc.ai_result || {};
        
        // 2. 임베딩할 텍스트 구성 (AI 분석 결과 + 사용자 피드백)
        // RAG 검색 품질을 위해 핵심 내용 위주로 구성합니다.
        const textToEmbed = `
        [문서 유형]: ${aiResult.step1_extraction?.doc_type || '법률 문서'}
        [핵심 요약]: ${aiResult.step3_rag_analysis || ''}
        [사용자 검토 의견]: ${userFeedback || '없음'}
        [전체 내용]: ${JSON.stringify(aiResult.step1_extraction || {})}
        `.trim();

        // 3. 임베딩 생성 (Gemini)
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embedResult = await embedModel.embedContent(textToEmbed);
        const vector = embedResult.embedding.values;

        // 4. Pinecone에 저장 (Upsert)
        const index = pinecone.index("legal-rag-db");
        
        await index.upsert([{
            id: doc.id, // 문서 ID를 벡터 ID로 사용
            values: vector,
            metadata: {
                filename: doc.filename,
                docType: aiResult.step1_extraction?.doc_type || 'Unknown',
                uploadDate: new Date().toISOString(),
                userFeedback: userFeedback || '',
                // 검색 결과에 띄워줄 요약본 저장
                fullContent: (aiResult.step3_rag_analysis || '').substring(0, 1000) 
            }
        }]);

        // 5. DB 상태 업데이트 (검토 완료 -> archived or completed)
        await supabase
            .from('document_queue')
            .update({ 
                status: 'completed', // 상태 변경
                user_feedback: userFeedback,
                pinecone_indexed: true // 인덱싱 여부 체크
            })
            .eq('id', docId);

        return res.status(200).json({ success: true, message: "RAG DB 저장 완료" });

    } catch (error) {
        console.error("Confirm Review Error:", error);
        return res.status(500).json({ error: error.message });
    }
}