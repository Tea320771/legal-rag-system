// /api/check-new-docs.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 1. 환경변수 로드
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const apiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey || !apiKey) {
    console.error("❌ [Critical] 환경변수 누락! Vercel 설정을 확인하세요.");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(apiKey);

export default async function handler(req, res) {
    // GET, POST 모두 허용 (브라우저 접속 테스트 용이)
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("🔍 [Check-New-Docs] 승인 대기 중인 문서(Pending) 조회 시작...");

        // ============================================================
        // 1. DB에서 'pending' 상태인 문서들 조회 (오래된 순)
        // ============================================================
        const { data: pendingDocs, error: dbError } = await supabase
            .from('document_queue')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true }) 
            .limit(10); // 한 번에 최대 10개 처리

        if (dbError) throw new Error(`DB 조회 실패: ${dbError.message}`);

        // 대기 중인 문서가 없으면 종료
        if (!pendingDocs || pendingDocs.length === 0) {
            console.log("✅ 현재 승인 대기 중인 문서가 없습니다.");
            return res.status(200).json({ 
                success: true, 
                message: "승인 대기 중인 문서가 없습니다.", 
                count: 0 
            });
        }

        console.log(`⚡ ${pendingDocs.length}개의 대기 문서를 발견! 처리 시작...`);
        
        const results = [];
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // 최신 모델

        // ============================================================
        // 2. 대기 문서 순차 처리
        // ============================================================
        for (const doc of pendingDocs) {
            console.log(`📄 문서 처리 중: ${doc.filename} (ID: ${doc.id})`);

            try {
                // (A) 실제 파일 다운로드 (redact-document.js가 저장한 파일명 사용)
                const { data: fileBlob, error: downloadError } = await supabase.storage
                    .from('legal-docs')
                    .download(doc.filename);

                if (downloadError) {
                    console.error(`❌ 파일 다운로드 실패 (${doc.filename}):`, downloadError.message);
                    // 파일이 없으면 에러 처리
                    await supabase.from('document_queue')
                        .update({ 
                            status: 'error', 
                            ai_result: { error: `Download failed: ${downloadError.message}` } 
                        })
                        .eq('id', doc.id);
                    continue;
                }

                // (B) Gemini 분석을 위한 데이터 준비
                const arrayBuffer = await fileBlob.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');

                // (C) 요약 및 분석 수행
                const prompt = `
                이 문서는 비식별화된 판결문이야. 내용을 분석해서 JSON으로 요약해줘.
                { 
                    "summary": "사건 요약 (3문장)", 
                    "issues": "핵심 법적 쟁점 리스트",
                    "judgment_logic": "주요 판결 논리" 
                }
                `;
                
                const result = await model.generateContent([
                    { text: prompt },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]);

                let aiDataText = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                let aiData;
                try { aiData = JSON.parse(aiDataText); } catch (e) { aiData = { raw: aiDataText }; }

                // (D) 처리 완료 상태로 업데이트 (pending -> processed)
                const { error: updateError } = await supabase
                    .from('document_queue')
                    .update({ 
                        status: 'processed', 
                        ai_result: aiData,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', doc.id);

                if (updateError) throw updateError;
                
                console.log(`✅ 처리 완료: ${doc.filename}`);
                results.push({ filename: doc.filename, status: 'processed', summary: aiData.summary });

            } catch (docError) {
                console.error(`💥 개별 문서 처리 에러 (${doc.filename}):`, docError);
                // 에러 발생 시 상태 업데이트
                await supabase.from('document_queue')
                    .update({ 
                        status: 'error', 
                        ai_result: { error: docError.message } 
                    })
                    .eq('id', doc.id);
            }
        }

        return res.status(200).json({ 
            success: true, 
            message: `${results.length}개의 문서를 처리 완료했습니다.`, 
            processed_docs: results 
        });

    } catch (error) {
        console.error("Handler Error:", error);
        return res.status(500).json({ error: error.message });
    }
}