// /api/rag-train.js
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. GitHub Raw 데이터 가져오기
async function fetchGithubRules() {
    const BASE_URL = 'https://raw.githubusercontent.com/Tea320771/myweb/main';
    try {
        const [readingRes, logicRes] = await Promise.all([
            fetch(`${BASE_URL}/reading_guide.json`),
            fetch(`${BASE_URL}/guideline.json`)
        ]);

        if (!readingRes.ok || !logicRes.ok) throw new Error("GitHub fetch failed");

        const readingGuide = await readingRes.json();
        const logicGuideline = await logicRes.json();

        return { readingGuide, logicGuideline };
    } catch (error) {
        console.error("GitHub 규칙 로드 실패:", error);
        return { readingGuide: {}, logicGuideline: {} };
    }
}

// 2. Pinecone에서 유사 사례 검색
async function fetchPastExamples(queryText) {
    try {
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embedResult = await embedModel.embedContent(queryText);
        const vector = embedResult.embedding.values;

        const index = pinecone.index("legal-rag-db");
        
        const queryResponse = await index.query({
            vector: vector,
            topK: 3,
            includeMetadata: true
        });

        const pastContext = queryResponse.matches.map(match => {
            return `- 과거 유사 사례 (${match.metadata.docType}): ${match.metadata.userFeedback || "피드백 없음"}`;
        }).join("\n");

        return pastContext || "유사한 과거 사례 없음.";
    } catch (error) {
        console.error("RAG 검색 실패:", error);
        return "과거 데이터 검색 불가.";
    }
}

export default async function handler(req, res) {
// ==================================================================
    // [필수] CORS 설정 (다른 도메인에서의 접속 허용)
    // ==================================================================
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); // 보안을 위해 나중엔 실제 프론트엔드 주소로 변경 권장
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // OPTIONS 요청(Preflight) 처리: 브라우저가 "보내도 돼?" 하고 찔러보는 요청
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }
    // ==================================================================

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const { step, fileBase64, mimeType, fileName, docType, extraction, analysis, userFeedback } = req.body;

        // =========================================================
        // STEP 1: 분석 요청 (비교 분석 수행)
        // =========================================================
        if (step === 'analyze') {
            const { readingGuide, logicGuideline } = await fetchGithubRules();
            const specificReading = readingGuide[docType] || readingGuide["default"] || {};
            const specificLogic = logicGuideline[docType] || logicGuideline["default"] || {};

            const searchContext = `문서 종류: ${docType}, 파일명: ${fileName}에 대한 해석 오류 및 피드백`;
            const pastExperiences = await fetchPastExamples(searchContext);

            // [안전 모드] 일반 텍스트로 받아서 수동 파싱
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const analysisPrompt = `
            너는 법률 문서 분석 AI야. 
            이미지를 읽고 다음 두 가지 관점에서 각각 분석을 수행해.

            1. [Resources]
               - GitHub Rules (Standard): ${JSON.stringify(specificLogic)}
               - Extraction Guide: ${JSON.stringify(specificReading)}
               - RAG History (Past Experience): ${pastExperiences}

            2. [Tasks]
               - Task A: 오직 "GitHub Rules"만 적용해서 분석해. (Standard Logic)
               - Task B: "GitHub Rules"에 "RAG History"까지 반영해서 분석해. (Advanced Logic)
                 (만약 과거 사례에서 "A가 아니라 B로 해석해"라고 했다면 Task B는 그걸 따라야 함)

            **중요: 반드시 아래의 JSON 포맷으로만 답변해.**
            {
                "extracted_facts": "문서에서 보이는 팩트 (공통)",
                "logic_baseline": "Task A 결과 (GitHub 규칙만 적용)",
                "logic_rag": "Task B 결과 (GitHub 규칙 + RAG DB 적용)"
            }
            `;

            const result = await model.generateContent([
                analysisPrompt,
                { inlineData: { data: fileBase64, mimeType: mimeType } }
            ]);
            
            let textResult = result.response.text();
            textResult = textResult.replace(/```json/g, "").replace(/```/g, "").trim();

            let aiResponse;
            try {
                aiResponse = JSON.parse(textResult);
            } catch (e) {
                console.error("JSON Parsing Error:", e);
                aiResponse = {
                    extracted_facts: "파싱 실패",
                    logic_baseline: "파싱 실패",
                    logic_rag: textResult // 원본이라도 보여줌
                };
            }

            return res.status(200).json({
                success: true,
                step: 'analyze',
                data: {
                    extraction: aiResponse.extracted_facts,
                    analysis_baseline: aiResponse.logic_baseline, // 규칙 only
                    analysis_rag: aiResponse.logic_rag            // 규칙 + DB
                }
            });
        }

        // =========================================================
        // STEP 2: 저장 요청 (기존과 동일)
        // =========================================================
        else if (step === 'save') {
            const contentForEmbedding = `
            [Doc Type]: ${docType}
            [Verified Extraction]: ${extraction}
            [Verified Analysis (Final)]: ${analysis} 
            [User Instruction]: ${userFeedback}
            `;
            // *Verified Analysis는 사용자가 최종적으로 선택/수정한 내용을 저장

            const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const embedResult = await embedModel.embedContent(contentForEmbedding);
            const vector = embedResult.embedding.values;

            const index = pinecone.index("legal-rag-db");
            const uniqueId = `manual-train-${Date.now()}`;

            await index.upsert([{
                id: uniqueId,
                values: vector,
                metadata: {
                    fileName,
                    docType,
                    type: "verified_instruction",
                    userFeedback: userFeedback, 
                    fullContent: contentForEmbedding,
                    createdAt: new Date().toISOString()
                }
            }]);

            return res.status(200).json({ success: true, step: 'save', upsertId: uniqueId });
        }

    } catch (error) {
        console.error("Handler Error:", error);
        res.status(500).json({ error: error.message });
    }
}