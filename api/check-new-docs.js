// /api/check-new-docs.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        console.log("🔍 Pending 문서 확인 중...");

        // 1. DB에서 상태가 'pending'인 문서 가져오기
        const { data: pendingDocs, error: dbError } = await supabase
            .from('document_queue')
            .select('*')
            .eq('status', 'pending')
            .limit(5); // 한 번에 최대 5개씩 처리 (타임아웃 방지)

        if (dbError) throw dbError;

        if (!pendingDocs || pendingDocs.length === 0) {
            return res.status(200).json({ message: "대기 중인(pending) 문서가 없습니다." });
        }

        const results = [];
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        // 2. 각 문서 처리
        for (const doc of pendingDocs) {
            console.log(`⚡ 처리 중: ${doc.filename}`);

            try {
                // Storage에서 파일 다운로드 (filename 컬럼이 이제 실제 파일명과 일치함)
                const { data: fileBlob, error: downloadError } = await supabase.storage
                    .from('legal-docs')
                    .download(doc.filename);

                if (downloadError) {
                    console.error(`다운로드 실패 (${doc.filename}):`, downloadError.message);
                    // 다운로드 실패 시 상태를 'error'로 변경하여 무한 루프 방지
                    await supabase.from('document_queue')
                        .update({ status: 'error', ai_result: { error: "Download failed" } })
                        .eq('id', doc.id);
                    continue;
                }

                const arrayBuffer = await fileBlob.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');

                // Gemini 2차 분석 (예: 법적 쟁점 추출 등)
                const prompt = `
                이 법률 문서(판결문)를 분석하여 아래 JSON으로 요약해.
                { 
                    "summary": "사건 요약 (3문장)", 
                    "issues": "주요 법적 쟁점 리스트",
                    "judgment_logic": "판결의 주요 논리" 
                }
                `;
                
                const result = await model.generateContent([
                    { text: prompt },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]);

                let aiDataText = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                let aiData;
                try {
                    aiData = JSON.parse(aiDataText);
                } catch (e) {
                    aiData = { raw_text: aiDataText };
                }

                // 3. 결과 업데이트 및 상태 변경 (pending -> processed)
                const { error: updateError } = await supabase
                    .from('document_queue')
                    .update({ 
                        status: 'processed', 
                        ai_result: aiData 
                    })
                    .eq('id', doc.id);

                if (updateError) throw updateError;
                results.push({ filename: doc.filename, status: 'processed' });

            } catch (docError) {
                console.error(`문서 처리 중 에러 (${doc.filename}):`, docError);
                await supabase.from('document_queue')
                    .update({ status: 'error', ai_result: { error: docError.message } })
                    .eq('id', doc.id);
            }
        }

        return res.status(200).json({ success: true, processed: results });

    } catch (error) {
        console.error("Handler Error:", error);
        return res.status(500).json({ error: error.message });
    }
}