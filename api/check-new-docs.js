// /api/check-new-docs.js
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pinecone } = require('@pinecone-database/pinecone');

// [추가 1] 강제 지연을 위한 헬퍼 함수
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const apiKey = process.env.GEMINI_API_KEY;
const pineconeKey = process.env.PINECONE_API_KEY;

if (!supabaseUrl || !supabaseKey || !apiKey || !pineconeKey) {
    console.error("❌ [Critical] 환경변수 누락!");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(apiKey);
const pinecone = new Pinecone({ apiKey: pineconeKey });

// =========================================================
// [Helper] Retry Wrapper (429 에러 대응용)
// =========================================================
async function callGeminiWithRetry(fn, retries = 3, delayMs = 10000) {
    try {
        return await fn();
    } catch (error) {
        if (error.message.includes('429') && retries > 0) {
            console.warn(`⚠️ Quota exceeded. Retrying in ${delayMs / 1000}s... (${retries} left)`);
            await delay(delayMs);
            return callGeminiWithRetry(fn, retries - 1, delayMs * 2);
        }
        throw error;
    }
}

async function fetchGithubRules() {
    const BASE_URL = 'https://raw.githubusercontent.com/Tea320771/myweb/main';
    try {
        const [readingRes, logicRes] = await Promise.all([
            fetch(`${BASE_URL}/reading_guide.json`),
            fetch(`${BASE_URL}/guideline.json`)
        ]);
        if (!readingRes.ok || !logicRes.ok) throw new Error("GitHub fetch failed");
        return { readingGuide: await readingRes.json(), logicGuideline: await logicRes.json() };
    } catch (error) {
        console.error("⚠️ GitHub 규칙 로드 실패:", error.message);
        return { readingGuide: "Load Failed", logicGuideline: "Load Failed" };
    }
}

async function searchPinecone(queryData) { 
    try {
        const queryText = typeof queryData === 'object' 
            ? JSON.stringify(queryData) 
            : String(queryData);

        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        
        const embedResult = await callGeminiWithRetry(() => embedModel.embedContent(queryText));
        const vector = embedResult.embedding.values;

        const index = pinecone.index("legal-rag-db");
        const queryResponse = await index.query({ vector, topK: 3, includeMetadata: true });

        if (!queryResponse.matches || queryResponse.matches.length === 0) return "유사한 과거 사례가 없습니다.";

        return queryResponse.matches.map((match, i) => {
            const meta = match.metadata || {};
            return `[사례 ${i + 1}] (유형: ${meta.docType || 'N/A'})\n내용: ${meta.fullContent || meta.userFeedback || '내용 없음'}`;
        }).join("\n\n");
    } catch (error) {
        console.warn("⚠️ Pinecone 검색 실패:", error.message);
        return "과거 사례 검색 중 오류 발생.";
    }
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const body = req.body || {};

    try {
        // ------------------------------------------------------------------
        // [GET] 목록 조회 (List Mode)
        // ------------------------------------------------------------------
        if (req.query.mode === 'list') {
            const { data, error } = await supabase
                .from('document_queue')
                .select('id, filename, status, created_at')
                // processed 상태도 목록에 포함되어야 사용자가 클릭 가능
                .in('status', ['pending', 'error', 'processed'])
                .order('created_at', { ascending: true });
            
            if (error) throw error;
            return res.status(200).json({ success: true, list: data });
        }

        // ------------------------------------------------------------------
        // [GET] 카운트 조회 (Count Mode)
        // ------------------------------------------------------------------
        if (req.query.mode === 'count') {
            const { count, error } = await supabase
                .from('document_queue')
                .select('*', { count: 'exact', head: true })
                .in('status', ['pending', 'error', 'processed']); 

            if (error) throw error;
            return res.status(200).json({ success: true, count: count || 0 });
        }

        // ------------------------------------------------------------------
        // [POST] 문서 분석 및 상세 조회 (Pipeline)
        // ------------------------------------------------------------------
        console.log("🚀 [RAG Pipeline] 문서 처리 시작...");

        let query = supabase.from('document_queue').select('*');

        // [핵심 변경 1] 특정 ID 요청 시, 상태 제한 없이 가져오기
        if (body.docId) {
            console.log(`🎯 개별 처리 요청: ID ${body.docId}`);
            query = query.eq('id', body.docId); // status 필터 제거 (processed도 가져옴)
        } else {
            // [자동 실행] 자동 실행일 때는 여전히 대기 중인 것만 처리
            query = query.in('status', ['pending', 'error'])
                         .order('created_at', { ascending: true })
                         .limit(1);
        }

        const { data: pendingDocs, error: dbError } = await query;

        if (dbError) throw new Error(`DB 조회 실패: ${dbError.message}`);

        if (!pendingDocs || pendingDocs.length === 0) {
            console.log("✅ 처리할 문서가 없습니다.");
            return res.status(200).json({ success: true, count: 0, processed: [] });
        }

        const { readingGuide, logicGuideline } = await fetchGithubRules();
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const results = [];

        for (const doc of pendingDocs) {
            
            // [핵심 변경 2] 이미 분석 완료된 문서는 재분석 없이 DB 결과 반환
            if (doc.status === 'processed' && doc.ai_result) {
                console.log(`ℹ️ [Cache] 이미 분석된 문서입니다: ${doc.filename}`);
                // 이미 저장된 ai_result를 그대로 반환
                results.push({ 
                    filename: doc.filename, 
                    status: 'processed', 
                    result: doc.ai_result 
                });
                continue; // 다음 루프로 건너뜀 (API 호출 생략)
            }

            // ---------------------------------------------------------
            // 아래부터는 'pending' 또는 'error' 상태인 문서의 실제 분석 로직
            // ---------------------------------------------------------
            console.log(`📄 신규 분석 시작: ${doc.filename} (ID: ${doc.id})`);

            try {
                const { data: fileBlob, error: downloadError } = await supabase.storage
                    .from('legal-docs')
                    .download(doc.filename);

                if (downloadError) {
                    console.error(`❌ 다운로드 실패: ${doc.filename}`);
                    continue; 
                }

                const arrayBuffer = await fileBlob.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');

                // Phase 1: Gemini Call
                const phase1Prompt = `
                너는 법률 문서 분석 전문가야. 
                [Extraction Rules]: ${JSON.stringify(readingGuide)}
                [Logic Guidelines]: ${JSON.stringify(logicGuideline)}
                
                위 규칙을 사용하여:
                1. 사실 관계 추출 (Extraction)
                2. 1차 해석 (Baseline Analysis)
                3. 검색용 요약 (Search Context)
                
                JSON 포맷: { "extraction": "...", "baseline_analysis": "...", "search_context": "..." }
                `;

                const result1 = await callGeminiWithRetry(() => model.generateContent([
                    { text: phase1Prompt },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]));
                
                await delay(5000); 

                let phase1Data;
                try {
                    phase1Data = JSON.parse(result1.response.text().replace(/```json/g, "").replace(/```/g, "").trim());
                } catch(e) {
                    phase1Data = { extraction: "Error", baseline_analysis: "Error", search_context: "" };
                }

                // Phase 2: Vector Search
                let pastCases = "검색된 유사 사례 없음";
                if (phase1Data.search_context) {
                    pastCases = await searchPinecone(phase1Data.search_context);
                    await delay(2000);
                }

                // Phase 3: Final Analysis
                const phase2Prompt = `
                [Baseline]: ${JSON.stringify(phase1Data.baseline_analysis)}
                [Past Cases]: ${pastCases}
                
                위 내용을 종합하여 관리자용 최종 분석 보고서를 작성해.
                JSON 포맷: { "final_rag_analysis": "...", "issues": ["..."], "rag_reference_used": boolean }
                `;

                const result2 = await callGeminiWithRetry(() => model.generateContent([{ text: phase2Prompt }]));
                
                let phase2Data;
                try {
                    phase2Data = JSON.parse(result2.response.text().replace(/```json/g, "").replace(/```/g, "").trim());
                } catch(e) {
                    phase2Data = { final_rag_analysis: result2.response.text(), issues: [], rag_reference_used: false };
                }

                const finalResult = {
                    step1_extraction: phase1Data.extraction,
                    step2_baseline: phase1Data.baseline_analysis,
                    step3_rag_analysis: phase2Data.final_rag_analysis,
                    issues: phase2Data.issues,
                    past_cases_summary: pastCases.substring(0, 500)
                };

                const { error: updateError } = await supabase
                    .from('document_queue')
                    .update({ 
                        status: 'processed', 
                        ai_result: finalResult,
                    })
                    .eq('id', doc.id);

                if (updateError) throw updateError;
                console.log(`✅ 처리 완료: ${doc.filename}`);
                results.push({ filename: doc.filename, status: 'processed', result: finalResult });

                await delay(10000); 

            } catch (docError) {
                console.error(`💥 에러 발생 (${doc.filename}):`, docError.message);
                
                await supabase.from('document_queue')
                    .update({ status: 'error', ai_result: { error: docError.message } })
                    .eq('id', doc.id);
                    
                results.push({ filename: doc.filename, status: 'error', error: docError.message });
            }
        }

        return res.status(200).json({ success: true, processed: results });

    } catch (error) {
        console.error("Handler Error:", error);
        return res.status(500).json({ error: error.message });
    }
}