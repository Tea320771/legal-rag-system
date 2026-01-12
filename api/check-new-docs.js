// /api/check-new-docs.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 1. 환경변수 로드
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // service_role key (필수)
const apiKey = process.env.GEMINI_API_KEY;

if (!supabaseUrl || !supabaseKey || !apiKey) {
    console.error("❌ [Critical] 환경변수 누락! Vercel 설정을 확인하세요.");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(apiKey);

export default async function handler(req, res) {
    // GET, POST 모두 허용
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        console.log("🚀 [Processing Mode] 승인 대기 문서 처리 시작...");

        // ============================================================
        // 1. DB에서 'pending' 상태인 문서 조회 (오래된 순서대로 5개씩)
        // ============================================================
        const { data: pendingDocs, error: dbError } = await supabase
            .from('document_queue')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true }) 
            .limit(5); // 타임아웃 방지를 위해 한 번에 5개만 처리

        if (dbError) throw new Error(`DB 조회 실패: ${dbError.message}`);

        if (!pendingDocs || pendingDocs.length === 0) {
            console.log("✅ 현재 대기 중인 문서가 없습니다.");
            return res.status(200).json({ success: true, message: "대기 문서 없음", count: 0 });
        }

        console.log(`⚡ ${pendingDocs.length}개의 대기 문서 발견. 처리를 시작합니다.`);
        
        const results = [];
        // Gemini 2.0 Flash 모델 사용 (속도/성능 최적화)
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

        // ============================================================
        // 2. 문서 순차 처리 루프
        // ============================================================
        for (const doc of pendingDocs) {
            console.log(`📄 처리 중: ${doc.filename} (ID: ${doc.id})`);

            try {
                // (A) 파일 다운로드
                // 주의: 예전 데이터("판결문 6.pdf")는 Storage에 실제 파일이 없을 수도 있습니다.
                // 이 경우 에러 처리하고 넘어가도록 작성했습니다.
                const { data: fileBlob, error: downloadError } = await supabase.storage
                    .from('legal-docs')
                    .download(doc.filename);

                if (downloadError) {
                    console.error(`❌ 다운로드 실패 (스킵): ${doc.filename}`);
                    // 파일이 없으면 'error' 상태로 변경하여 계속 재시도하는 것을 방지
                    await supabase.from('document_queue')
                        .update({ 
                            status: 'error', 
                            ai_result: { error: "File not found in Storage" } 
                        })
                        .eq('id', doc.id);
                    continue;
                }

                // (B) Gemini 분석 준비
                const arrayBuffer = await fileBlob.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');

                // (C) 요약 및 분석 수행
                const prompt = `
                이 문서는 비식별화 처리가 완료된 판결문입니다.
                내용을 분석하여 다음 JSON 포맷으로 핵심을 요약해주세요.
                { 
                    "summary": "사건 요약 (3문장 이내)", 
                    "issues": ["주요 쟁점 1", "주요 쟁점 2"],
                    "judgment_logic": "판결의 주된 논리 요약" 
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

                // (D) 처리 완료! DB 업데이트 (pending -> processed)
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
                results.push({ filename: doc.filename, status: 'processed' });

            } catch (docError) {
                console.error(`💥 개별 에러 (${doc.filename}):`, docError.message);
                // 에러 발생 시 상태 기록
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
            message: `${results.length}건 처리 완료`, 
            processed: results 
        });

    } catch (error) {
        console.error("Handler Error:", error);
        return res.status(500).json({ error: error.message });
    }
}