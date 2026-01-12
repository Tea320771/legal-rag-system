// /api/rag-train.js
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. GitHub Raw 데이터 가져오기 (정적 규칙)
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

// 2. Pinecone에서 유사 사례 검색 (동적 경험)
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
            // 과거에 사용자가 수정했던 피드백 내용을 가져옴
            return `- 과거 유사 사례 (${match.metadata.docType}): ${match.metadata.userFeedback || "피드백 없음"}`;
        }).join("\n");

        return pastContext || "유사한 과거 사례 없음.";
    } catch (error) {
        console.error("RAG 검색 실패:", error);
        return "과거 데이터 검색 불가.";
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        // step: 'analyze' (분석만) | 'save' (저장)
        const { step, fileBase64, mimeType, fileName, docType, extraction, analysis, userFeedback } = req.body;

        // =========================================================
        // STEP 1: 분석 요청 (저장 X, 결과만 반환)
        // =========================================================
        if (step === 'analyze') {
            // A. 외부 규칙 및 과거 사례 수집
            const { readingGuide, logicGuideline } = await fetchGithubRules();
            const specificReading = readingGuide[docType] || readingGuide["default"] || {};
            const specificLogic = logicGuideline[docType] || logicGuideline["default"] || {};

            const searchContext = `문서 종류: ${docType}, 파일명: ${fileName}에 대한 해석 오류 및 피드백`;
            const pastExperiences = await fetchPastExamples(searchContext);

            // B. JSON 출력을 위한 모델 설정
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                generationConfig: { responseMimeType: "application/json" }
            });

            // C. 프롬프트 구성
            const analysisPrompt = `
            너는 법률 문서 분석 AI야. 
            이미지를 읽고 [Rules]와 [History]를 참고하여 정확하게 정보를 추출하고 해석해.

            1. [Rules - GitHub]
               - Extraction Strategy: ${JSON.stringify(specificReading)}
               - Logic Rules: ${JSON.stringify(specificLogic)}

            2. [History - Past Feedback]
               과거에 사용자가 지적한 내용이야. 같은 실수를 반복하지 마:
               ${pastExperiences}

            반드시 아래 JSON 스키마에 맞춰서 답변해:
            {
                "extracted_facts": "문서에서 보이는 그대로의 팩트 (주문, 청구취지, 금액, 날짜 등)",
                "logic_analysis": "위 팩트를 바탕으로 한 법적 해석 결과, 계산 결과, 혹은 쟁점 분석"
            }
            `;

            // D. 실행
            const result = await model.generateContent([
                analysisPrompt,
                { inlineData: { data: fileBase64, mimeType: mimeType } }
            ]);
            
            const aiResponse = JSON.parse(result.response.text());

            return res.status(200).json({
                success: true,
                step: 'analyze',
                data: {
                    extraction: aiResponse.extracted_facts,
                    analysis: aiResponse.logic_analysis
                }
            });
        }

        // =========================================================
        // STEP 2: 저장 요청 (사용자 검토 후 최종 데이터 저장)
        // =========================================================
        else if (step === 'save') {
            // 사용자가 수정한 extraction과 analysis, 그리고 추가 피드백을 모두 합쳐서 임베딩
            const contentForEmbedding = `
            [Doc Type]: ${docType}
            [Verified Extraction]: ${extraction}
            [Verified Analysis]: ${analysis}
            [User Instruction]: ${userFeedback}
            `;

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
                    userFeedback: userFeedback, // 나중에 "과거 사례"로 검색될 핵심 데이터
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