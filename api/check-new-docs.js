// /api/check-new-docs.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Pinecone } from '@pinecone-database/pinecone';

// 1. 환경변수 로드 및 검증
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY; // service_role key (필수)
const apiKey = process.env.GEMINI_API_KEY;
const pineconeKey = process.env.PINECONE_API_KEY;

if (!supabaseUrl || !supabaseKey || !apiKey || !pineconeKey) {
    console.error("❌ [Critical] 환경변수 누락! (SUPABASE, GEMINI, PINECONE 확인 필요)");
}

const supabase = createClient(supabaseUrl, supabaseKey);
const genAI = new GoogleGenerativeAI(apiKey);
const pinecone = new Pinecone({ apiKey: pineconeKey });

// =========================================================
// [Helper 1] GitHub 규칙 가져오기
// =========================================================
async function fetchGithubRules() {
    const BASE_URL = 'https://raw.githubusercontent.com/Tea320771/myweb/main';
    try {
        const [readingRes, logicRes] = await Promise.all([
            fetch(`${BASE_URL}/reading_guide.json`),
            fetch(`${BASE_URL}/guideline.json`)
        ]);

        if (!readingRes.ok || !logicRes.ok) throw new Error("GitHub fetch failed");

        return {
            readingGuide: await readingRes.json(),
            logicGuideline: await logicRes.json()
        };
    } catch (error) {
        console.error("⚠️ GitHub 규칙 로드 실패 (기본값 사용):", error.message);
        return { readingGuide: "Load Failed", logicGuideline: "Load Failed" };
    }
}

// =========================================================
// [Helper 2] Pinecone 유사 사례 검색
// =========================================================
async function searchPinecone(queryText) {
    try {
        // 텍스트를 벡터로 변환 (Embedding)
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embedResult = await embedModel.embedContent(queryText);
        const vector = embedResult.embedding.values;

        // Pinecone 검색
        const index = pinecone.index("legal-rag-db");
        const queryResponse = await index.query({
            vector: vector,
            topK: 3,
            includeMetadata: true
        });

        if (!queryResponse.matches || queryResponse.matches.length === 0) {
            return "유사한 과거 사례가 없습니다.";
        }

        // 검색 결과 텍스트로 변환
        return queryResponse.matches.map((match, i) => {
            const meta = match.metadata || {};
            return `[사례 ${i + 1}] (유형: ${meta.docType || 'N/A'})\n내용: ${meta.fullContent || meta.userFeedback || '내용 없음'}`;
        }).join("\n\n");

    } catch (error) {
        console.warn("⚠️ Pinecone 검색 실패 (무시하고 진행):", error.message);
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
        console.log("🚀 [RAG Pipeline] 승인 대기 문서 처리 시작...");

        // 1. DB에서 'pending' 문서 조회
        const { data: pendingDocs, error: dbError } = await supabase
            .from('document_queue')
            .select('*')
            .eq('status', 'pending')
            .order('created_at', { ascending: true })
            .limit(3); // RAG 처리는 무거우므로 한 번에 3개까지만 제한

        if (dbError) throw new Error(`DB 조회 실패: ${dbError.message}`);

        if (!pendingDocs || pendingDocs.length === 0) {
            console.log("✅ 대기 중인 문서가 없습니다.");
            return res.status(200).json({ success: true, message: "No pending docs", count: 0 });
        }

        console.log(`⚡ ${pendingDocs.length}개의 문서를 RAG 파이프라인으로 분석합니다.`);
        
        // GitHub 규칙 로드 (한 번만 로드해서 재사용)
        const { readingGuide, logicGuideline } = await fetchGithubRules();
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // 속도/성능 균형

        const results = [];

        // 2. 문서 순차 처리 루프
        for (const doc of pendingDocs) {
            console.log(`📄 분석 시작: ${doc.filename} (ID: ${doc.id})`);

            try {
                // (A) PDF 다운로드
                const { data: fileBlob, error: downloadError } = await supabase.storage
                    .from('legal-docs')
                    .download(doc.filename);

                if (downloadError) {
                    console.error(`❌ 다운로드 실패 (Skip): ${doc.filename}`);
                    await supabase.from('document_queue').update({ status: 'error', ai_result: { error: "File not found" } }).eq('id', doc.id);
                    continue;
                }

                const arrayBuffer = await fileBlob.arrayBuffer();
                const base64 = Buffer.from(arrayBuffer).toString('base64');

                // =========================================================
                // Phase 1: Extraction & Baseline Analysis (GitHub Rules)
                // =========================================================
                console.log("   -> Phase 1: 기본 분석 및 추출 수행...");
                
                const phase1Prompt = `
                너는 법률 문서 분석 전문가야. 다음 판결문을 제공된 가이드라인에 맞춰 분석해.
                
                [Resource 1: Extraction Rules]
                ${JSON.stringify(readingGuide)}

                [Resource 2: Logic Guidelines]
                ${JSON.stringify(logicGuideline)}

                [Task]
                1. 'Extraction Rules'를 사용하여 문서의 사실 관계(당사자, 청구취지 등)를 추출해.
                2. 'Logic Guidelines'를 사용하여 1차적인 해석(Baseline Analysis)을 수행해.
                3. 이 사건의 핵심 내용(검색용)을 3문장으로 요약해.

                반드시 아래 JSON 포맷으로 출력해:
                {
                    "extraction": "추출된 사실관계 요약",
                    "baseline_analysis": "가이드라인 기반 1차 해석",
                    "search_context": "유사 사례 검색을 위한 핵심 요약 문구"
                }
                `;

                const result1 = await model.generateContent([
                    { text: phase1Prompt },
                    { inlineData: { data: base64, mimeType: 'application/pdf' } }
                ]);

                let phase1Data;
                try {
                    let text = result1.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                    phase1Data = JSON.parse(text);
                } catch (e) {
                    console.error("Phase 1 JSON Parse Error");
                    phase1Data = { extraction: "Error", baseline_analysis: "Error", search_context: "" };
                }

                // =========================================================
                // Phase 2: Vector Search (Pinecone)
                // =========================================================
                console.log("   -> Phase 2: 유사 판례 검색 (Pinecone)...");
                let pastCases = "검색된 유사 사례 없음";
                
                if (phase1Data.search_context) {
                    pastCases = await searchPinecone(phase1Data.search_context);
                }

                // =========================================================
                // Phase 3: Final RAG Analysis
                // =========================================================
                console.log("   -> Phase 3: 최종 RAG 분석 (Baseline + Past Cases)...");

                const phase2Prompt = `
                이전 단계에서 분석한 'Baseline Analysis'와 '과거 유사 사례(Past Cases)'를 종합하여 최종 분석을 수행해.

                [Current Analysis]
                - Extraction: ${JSON.stringify(phase1Data.extraction)}
                - Baseline: ${JSON.stringify(phase1Data.baseline_analysis)}

                [Past Similar Cases (RAG)]
                ${pastCases}

                [Task]
                위 정보를 바탕으로 관리자가 검토할 최종 보고서를 작성해.
                과거 사례와 비교했을 때 특이점이나, 가이드라인 적용 시 주의할 점을 포함해.

                반드시 아래 JSON 포맷으로 출력해:
                {
                    "final_rag_analysis": "과거 사례를 반영한 최종 심층 분석 결과",
                    "issues": ["쟁점 1", "쟁점 2"],
                    "rag_reference_used": true 또는 false (과거 사례가 유의미하게 쓰였는지)
                }
                `;

                const result2 = await model.generateContent([
                    { text: phase2Prompt }
                    // 이미 추출된 텍스트 기반이므로 PDF 다시 안 보내도 됨 (토큰 절약)
                ]);

                let phase2Data;
                try {
                    let text = result2.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
                    phase2Data = JSON.parse(text);
                } catch (e) {
                    phase2Data = { final_rag_analysis: result2.response.text(), issues: [], rag_reference_used: false };
                }

                // =========================================================
                // 3. DB 업데이트 (관리자 검토용 데이터 저장)
                // =========================================================
                const finalResult = {
                    step1_extraction: phase1Data.extraction,
                    step2_baseline: phase1Data.baseline_analysis,
                    step3_rag_analysis: phase2Data.final_rag_analysis,
                    issues: phase2Data.issues,
                    past_cases_summary: pastCases.substring(0, 500) + "..." // 너무 길면 자름
                };

                const { error: updateError } = await supabase
                    .from('document_queue')
                    .update({ 
                        status: 'processed', 
                        ai_result: finalResult, // 여기에 모든 단계의 데이터가 저장됨
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', doc.id);

                if (updateError) throw updateError;
                
                console.log(`✅ 처리 완료: ${doc.filename}`);
                results.push({ filename: doc.filename, status: 'processed' });

            } catch (docError) {
                console.error(`💥 개별 처리 에러 (${doc.filename}):`, docError.message);
                await supabase.from('document_queue')
                    .update({ status: 'error', ai_result: { error: docError.message } })
                    .eq('id', doc.id);
            }
        }

        return res.status(200).json({ success: true, processed: results });

    } catch (error) {
        console.error("Global Handler Error:", error);
        return res.status(500).json({ error: error.message });
    }
}