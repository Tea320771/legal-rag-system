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
            return `- 과거 유사 사례 (${match.metadata.docType}): ${match.metadata.userFeedback || "피드백 없음"}`;
        }).join("\n");

        return pastContext || "유사한 과거 사례 없음.";
    } catch (error) {
        console.error("RAG 검색 실패:", error);
        return "과거 데이터 검색 불가.";
    }
}

export default async function handler(req, res) {
    // POST 요청만 허용
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const { step, fileBase64, mimeType, fileName, docType, extraction, analysis, userFeedback } = req.body;

        // =========================================================
        // STEP 1: 분석 요청 (저장 X, 결과만 반환)
        // =========================================================
        if (step === 'analyze') {
            const { readingGuide, logicGuideline } = await fetchGithubRules();
            const specificReading = readingGuide[docType] || readingGuide["default"] || {};
            const specificLogic = logicGuideline[docType] || logicGuideline["default"] || {};

            const searchContext = `문서 종류: ${docType}, 파일명: ${fileName}에 대한 해석 오류 및 피드백`;
            const pastExperiences = await fetchPastExamples(searchContext);

            // [안전 모드] responseMimeType 옵션을 제거하고 일반 텍스트로 받음 (버전 호환성 해결)
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const analysisPrompt = `
            너는 법률 문서 분석 AI야. 
            이미지를 읽고 [Rules]와 [History]를 참고하여 정확하게 정보를 추출하고 해석해.

            1. [Rules - GitHub]
               - Extraction Strategy: ${JSON.stringify(specificReading)}
               - Logic Rules: ${JSON.stringify(specificLogic)}

            2. [History - Past Feedback]
               과거에 사용자가 지적한 내용이야. 같은 실수를 반복하지 마:
               ${pastExperiences}

            **중요: 반드시 아래의 JSON 포맷으로만 답변해. 마크다운(\`\`\`)이나 다른 설명은 절대 쓰지 마.**
            
            {
                "extracted_facts": "문서에서 보이는 그대로의 팩트 (주문, 청구취지, 금액, 날짜 등)",
                "logic_analysis": "위 팩트를 바탕으로 한 법적 해석 결과, 계산 결과, 혹은 쟁점 분석"
            }
            `;

            const result = await model.generateContent([
                analysisPrompt,
                { inlineData: { data: fileBase64, mimeType: mimeType } }
            ]);
            
            // 결과 텍스트 정제 (마크다운 제거)
            let textResult = result.response.text();
            textResult = textResult.replace(/```json/g, "").replace(/```/g, "").trim();

            let aiResponse;
            try {
                aiResponse = JSON.parse(textResult);
            } catch (e) {
                console.error("JSON Parsing Error:", e);
                // 파싱 실패 시 원본 텍스트를 그대로 보여줌
                aiResponse = {
                    extracted_facts: "데이터 파싱 실패 (원본 참조)",
                    logic_analysis: textResult
                };
            }

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
                    userFeedback: userFeedback, 
                    fullContent: contentForEmbedding,
                    createdAt: new Date().toISOString()
                }
            }]);

            return res.status(200).json({ success: true, step: 'save', upsertId: uniqueId });
        }

    } catch (error) {
        console.error("Handler Error:", error);
        // 에러 발생 시에도 반드시 JSON으로 응답해야 프론트엔드가 죽지 않음
        res.status(500).json({ error: error.message });
    }
}