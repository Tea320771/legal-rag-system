// /api/check-new-docs.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Pinecone } from '@pinecone-database/pinecone';

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
// [추가 2] API 호출이 실패(429)하면 대기 후 재시도하는 함수
async function callGeminiWithRetry(fn, retries = 3, delayMs = 10000) {
    try {
        return await fn();
    } catch (error) {
        if (error.message.includes('429') && retries > 0) {
            console.warn(`⚠️ Quota exceeded. Retrying in ${delayMs / 1000}s... (${retries} left)`);
            await delay(delayMs);
            return callGeminiWithRetry(fn, retries - 1, delayMs * 2); // 대기 시간 2배로 늘림
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

async function searchPinecone(queryData) { // 1. 변수명 변경 (queryText -> queryData)
    try {
        // 2. 이 부분 추가: 객체로 들어오면 강제로 문자열로 변환
        const queryText = typeof queryData === 'object' 
            ? JSON.stringify(queryData) 
            : String(queryData);

        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        
        // [수정] 임베딩 호출에도 재시도 로직 적용
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

export default async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        if (req.query.mode === 'count') {
            const { count, error } = await supabase
                .from('document_queue')
                .select('*', { count: 'exact', head: true })
                .in('status', ['pending', 'error']); 

            if (error) throw error;
            return res.status(200).json({ success: true, count: count || 0 });
        }

        if (req.query.mode === 'list') {
            const { data, error } = await supabase
                .from('document_queue')
                .select('id, filename, status, created_at')
                .in('status', ['pending', 'error'])
                .order('created_at', { ascending: true });
            
            if (error) throw error;
            return res.status(200).json({ success: true, list: data });
        }

        console.log("🚀 [RAG Pipeline] 문서 처리 시작...");

        let query = supabase.from('document_queue').select('*').in('status', ['pending', 'error']);

        if (req.body.docId) {
            console.log(`🎯 개별 처리 요청: ID ${req.body.docId}`);
            query = query.eq('id', req.body.docId);
        } else {
            // [수정 3] 한 번에 1개씩만 처리 (무료 티어 한도 보호)
            // 기존 limit(3) -> limit(1)
            query = query.order('created_at', { ascending: true }).limit(1);
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
            console.log(`📄 분석 시작: ${doc.filename} (ID: ${doc.id})`);

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

                // ---------------------------------------------------------
                // Phase 1: Gemini Call
                // ---------------------------------------------------------
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

                // [수정] 재시도 로직 적용 (가장 토큰 소모가 큼)
                const result1 = await callGeminiWithRetry(() => model.generateContent([
                    { text: phase1Prompt },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]));
                
                // [추가] 연속 호출 방지를 위한 안전 지연 (5초)
                await delay(5000); 

                let phase1Data;
                try {
                    phase1Data = JSON.parse(result1.response.text().replace(/```json/g, "").replace(/```/g, "").trim());
                } catch(e) {
                    phase1Data = { extraction: "Error", baseline_analysis: "Error", search_context: "" };
                }

                // ---------------------------------------------------------
                // Phase 2: Vector Search
                // ---------------------------------------------------------
                let pastCases = "검색된 유사 사례 없음";
                if (phase1Data.search_context) {
                    pastCases = await searchPinecone(phase1Data.search_context);
                    // [추가] 검색 후에도 잠시 지연 (2초)
                    await delay(2000);
                }

                // ---------------------------------------------------------
                // Phase 3: Final Analysis
                // ---------------------------------------------------------
                const phase2Prompt = `
                [Baseline]: ${JSON.stringify(phase1Data.baseline_analysis)}
                [Past Cases]: ${pastCases}
                
                위 내용을 종합하여 관리자용 최종 분석 보고서를 작성해.
                JSON 포맷: { "final_rag_analysis": "...", "issues": ["..."], "rag_reference_used": boolean }
                `;

                // [수정] 재시도 로직 적용
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

                // [추가] 문서 하나 처리가 완전히 끝난 후 다음 문서 처리 전 긴 휴식 (10초)
                // 현재 limit(1)이라 루프가 한 번만 돌겠지만, 추후 확장을 위해 남겨둡니다.
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