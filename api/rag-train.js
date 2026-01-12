// /api/rag-train.js
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// 1. GitHub Raw 데이터 가져오기 (정적 규칙)
async function fetchGithubRules() {
    // 사용자 GitHub Raw URL (main 브랜치 기준)
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
        return { readingGuide: {}, logicGuideline: {} }; // 실패 시 빈 객체 반환
    }
}

// 2. Pinecone에서 유사 사례 검색 (동적 경험)
async function fetchPastExamples(queryText) {
    try {
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embedResult = await embedModel.embedContent(queryText);
        const vector = embedResult.embedding.values;

        const index = pinecone.index("legal-rag-db");
        
        // 가장 유사한 과거 처리 사례 3개 조회
        const queryResponse = await index.query({
            vector: vector,
            topK: 3,
            includeMetadata: true
        });

        // 메타데이터에서 과거 피드백이나 처리 결과를 텍스트로 추출
        const pastContext = queryResponse.matches.map(match => {
            return `- 과거 유사 사례 (${match.metadata.docType}): ${match.metadata.userFeedback || match.metadata.fullContent}`;
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
        const { step, fileBase64, mimeType, fileName, docType, analysisResult, userFeedback } = req.body;

        // ---------------------------------------------------------
        // STEP 1: [분석 단계] GitHub 규칙 + RAG 과거 사례 -> Gemini 분석
        // ---------------------------------------------------------
        if (step === 'analyze') {
            
            // A. GitHub 규칙 가져오기
            const { readingGuide, logicGuideline } = await fetchGithubRules();
            const specificReading = readingGuide[docType] || readingGuide["default"];
            const specificLogic = logicGuideline[docType] || logicGuideline["default"];

            // B. RAG DB에서 유사 사례 검색
            // "이 문서는 [docType]이고 파일명은 [fileName]이다"라는 맥락으로 과거 데이터를 찾음
            const searchContext = `문서 종류: ${docType}, 파일명: ${fileName}에 대한 해석 지침`;
            const pastExperiences = await fetchPastExamples(searchContext);

            // C. Gemini 모델 준비 및 프롬프트 구성
            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const analysisPrompt = `
            너는 숙련된 법률 문서 분석 AI야. 아래 제공된 3가지 정보를 종합하여 문서를 분석해.

            1. [Standard Rules - GitHub 매뉴얼]
               - 읽기 전략: ${JSON.stringify(specificReading)}
               - 해석 논리: ${JSON.stringify(specificLogic)}

            2. [Historical Context - 우리 회사의 과거 유사 사례]
               이전에 사용자가 피드백했던 내용을 참고해서 실수를 반복하지 마:
               ${pastExperiences}

            3. [Instruction]
               위 '매뉴얼'을 기준으로 분석하되, '과거 사례'에서 지적된 사항을 특히 주의하여 문서를 해석해줘.
               결과는 사용자가 검토하기 좋게 [핵심 내용], [법적 쟁점], [해석 결과]로 구조화해서 출력해.
            `;

            // D. 분석 실행
            const result = await model.generateContent([
                analysisPrompt,
                { inlineData: { data: fileBase64, mimeType: mimeType } }
            ]);
            const aiDraftText = result.response.text();

            return res.status(200).json({
                success: true,
                step: 'analyze',
                data: {
                    aiDraftText,
                    references: {
                        githubRules: "Applied",
                        ragContext: pastExperiences.substring(0, 100) + "..." // 참고한 과거 사례 요약
                    }
                }
            });
        }

        // ---------------------------------------------------------
        // STEP 2: [저장 단계] 검토 완료된 데이터 저장 (기존과 동일)
        // ---------------------------------------------------------
        else if (step === 'save') {
            // (STEP 2 코드는 이전 답변과 동일하게 유지 - 사용자의 최종 피드백을 저장)
            const contentForEmbedding = `
            [Document Type]: ${docType}
            [User Feedback]: ${userFeedback}
            [Final Content]: ${analysisResult}
            `;

            const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const embedResult = await embedModel.embedContent(contentForEmbedding);
            const vector = embedResult.embedding.values;

            const index = pinecone.index("legal-rag-db");
            const uniqueId = `feedback-${Date.now()}`;

            await index.upsert([{
                id: uniqueId,
                values: vector,
                metadata: {
                    fileName,
                    docType,
                    type: "verified_instruction",
                    userFeedback,
                    fullContent: analysisResult,
                    createdAt: new Date().toISOString()
                }
            }]);

            return res.status(200).json({ success: true, step: 'save', message: "Saved" });
        }

    } catch (error) {
        console.error("Error:", error);
        res.status(500).json({ error: error.message });
    }
}