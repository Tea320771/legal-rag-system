// /api/check-new-docs.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Pinecone } from '@pinecone-database/pinecone';

// 1. 환경변수 로드 및 검증
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // service_role key
const apiKey = process.env.GEMINI_API_KEY;
const pineconeKey = process.env.PINECONE_API_KEY;

if (!supabaseUrl || !supabaseKey || !apiKey || !pineconeKey) {
    console.error("❌ [Critical] 환경변수 누락!");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(apiKey);
const pinecone = new Pinecone({ apiKey: pineconeKey });

// =========================================================
// [Helper 1] GitHub 규칙 가져오기 (기존 로직 유지)
// =========================================================
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

// =========================================================
// [Helper 2] Pinecone 유사 사례 검색 (기존 로직 유지)
// =========================================================
async function searchPinecone(queryText) {
    try {
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embedResult = await embedModel.embedContent(queryText);
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

// =========================================================
// Main Handler
// =========================================================
export default async function handler(req, res) {
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    try {
        // [기존 기능] 단순 조회 모드 (프론트엔드 알림용)
        if (req.query.mode === 'count') {
            const { count, error } = await supabase
                .from('document_queue')
                .select('*', { count: 'exact', head: true })
                .in('status', ['pending', 'error']); // pending 또는 error 상태

            if (error) throw error;
            return res.status(200).json({ success: true, count: count || 0 });
        }

        // [신규 기능 1] 리스트 조회 모드 (모달 목록 출력용)
        // 파일명과 날짜만 가볍게 가져옵니다.
        if (req.query.mode === 'list') {
            const { data, error } = await supabase
                .from('document_queue')
                .select('id, filename, status, created_at')
                .in('status', ['pending', 'error'])
                .order('created_at', { ascending: true });
            
            if (error) throw error;
            return res.status(200).json({ success: true, list: data });
        }

        // =========================================================
        // [RAG 파이프라인] 문서 분석 처리 (전체 또는 개별)
        // =========================================================
        console.log("🚀 [RAG Pipeline] 문서 처리 시작...");

        // [신규 기능 2] 특정 문서 ID가 지정되었는지 확인 (아코디언 클릭 시)
        let query = supabase.from('document_queue').select('*').in('status', ['pending', 'error']);

        if (req.body.docId) {
            // 특정 문서 하나만 콕 집어서 처리
            console.log(`🎯 개별 처리 요청: ID ${req.body.docId}`);
            query = query.eq('id', req.body.docId);
        } else {
            // 지정된 게 없으면 기존처럼 오래된 순서대로 3개 처리
            query = query.order('created_at', { ascending: true }).limit(3);
        }

        const { data: pendingDocs, error: dbError } = await query;

        if (dbError) throw new Error(`DB 조회 실패: ${dbError.message}`);

        if (!pendingDocs || pendingDocs.length === 0) {
            console.log("✅ 처리할 문서가 없습니다.");
            return res.status(200).json({ success: true, count: 0, processed: [] });
        }

        console.log(`⚡ ${pendingDocs.length}개의 문서를 RAG 분석합니다.`);
        
        // GitHub 규칙 로드
        const { readingGuide, logicGuideline } = await fetchGithubRules();
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        const results = [];

        for (const doc of pendingDocs) {
            console.log(`📄 분석 시작: ${doc.filename} (ID: ${doc.id})`);

            try {
                // (A) 파일 다운로드
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
                // Phase 1: Extraction & Baseline Analysis (GitHub Rules)
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

                const result1 = await model.generateContent([
                    { text: phase1Prompt },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]);
                
                let phase1Data;
                try {
                    phase1Data = JSON.parse(result1.response.text().replace(/```json/g, "").replace(/```/g, "").trim());
                } catch(e) {
                    phase1Data = { extraction: "Error", baseline_analysis: "Error", search_context: "" };
                }

                // ---------------------------------------------------------
                // Phase 2: Vector Search (Pinecone)
                // ---------------------------------------------------------
                let pastCases = "검색된 유사 사례 없음";
                if (phase1Data.search_context) {
                    pastCases = await searchPinecone(phase1Data.search_context);
                }

                // ---------------------------------------------------------
                // Phase 3: Final RAG Analysis
                // ---------------------------------------------------------
                const phase2Prompt = `
                [Baseline]: ${JSON.stringify(phase1Data.baseline_analysis)}
                [Past Cases]: ${pastCases}
                
                위 내용을 종합하여 관리자용 최종 분석 보고서를 작성해.
                JSON 포맷: { "final_rag_analysis": "...", "issues": ["..."], "rag_reference_used": boolean }
                `;

                const result2 = await model.generateContent([{ text: phase2Prompt }]);
                
                let phase2Data;
                try {
                    phase2Data = JSON.parse(result2.response.text().replace(/```json/g, "").replace(/```/g, "").trim());
                } catch(e) {
                    phase2Data = { final_rag_analysis: result2.response.text(), issues: [], rag_reference_used: false };
                }

                // DB 업데이트
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
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', doc.id);

                if (updateError) throw updateError;
                console.log(`✅ 처리 완료: ${doc.filename}`);
                results.push({ filename: doc.filename, status: 'processed', result: finalResult });

            } catch (docError) {
                console.error(`💥 에러 발생 (${doc.filename}):`, docError.message);
                
                // 에러 상태 DB 저장
                await supabase.from('document_queue')
                    .update({ status: 'error', ai_result: { error: docError.message } })
                    .eq('id', doc.id);
                    
                // 프론트엔드에 에러 내용 전달을 위해 결과 배열에 포함
                results.push({ filename: doc.filename, status: 'error', error: docError.message });
            }
        }

        return res.status(200).json({ success: true, processed: results });

    } catch (error) {
        console.error("Handler Error:", error);
        return res.status(500).json({ error: error.message });
    }
}