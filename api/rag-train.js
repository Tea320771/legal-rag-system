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

// 2. Pinecone에서 유사 사례 검색 (불량 데이터 방어 강화)
async function fetchPastExamples(queryText) {
    try {
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embedResult = await embedModel.embedContent(queryText);
        const vector = embedResult.embedding.values;

        const index = pinecone.index("legal-rag-db");
        
        try {
            const queryResponse = await index.query({
                vector: vector,
                topK: 3,
                includeMetadata: true
            });

            // 1. 검색 결과 자체가 없는 경우 방어
            if (!queryResponse || !queryResponse.matches || queryResponse.matches.length === 0) {
                return "관련된 과거 사례가 없습니다.";
            }

            const pastContext = queryResponse.matches.map(match => {
                // 2. [핵심 수정] 검색은 됐는데 '메타데이터'가 비어있는 '불량 데이터' 방어
                // match.metadata가 없으면 빈 객체 {}를 대신 사용하여 에러 방지
                const meta = match.metadata || {}; 
                
                // 속성이 없으면 '알 수 없음' 등으로 대체
                const docType = meta.docType || '문서유형 미상';
                const feedback = meta.userFeedback || meta.fullContent || "내용 없음";
                
                return `- 과거 유사 사례 (${docType}): ${feedback}`;
            }).join("\n");

            return pastContext;

        } catch (pineconeError) {
            console.warn("⚠️ Pinecone 검색 중 문제 발생 (무시하고 진행):", pineconeError.message);
            return "과거 사례 검색 실패 (DB 연결 또는 데이터 문제)";
        }

    } catch (error) {
        console.error("RAG 로직 내부 오류:", error);
        return "과거 데이터 검색 불가.";
    }
}

export default async function handler(req, res) {
    // CORS 설정
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*'); 
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        // [수정] files (배열) 수신
        const { step, files, docType, extraction, analysis, userFeedback } = req.body;

        // =========================================================
        // STEP 1: 분석 요청 (다중 파일 처리)
        // =========================================================
        if (step === 'analyze') {
            const { readingGuide, logicGuideline } = await fetchGithubRules();
            const specificReading = readingGuide[docType] || readingGuide["default"] || {};
            const specificLogic = logicGuideline[docType] || logicGuideline["default"] || {};

            // 파일명들을 합쳐서 검색 컨텍스트 생성
            const fileNameList = files.map(f => f.fileName).join(", ");
            const searchContext = `문서 종류: ${docType}, 파일명: ${fileNameList}에 대한 해석 오류 및 피드백`;
            const pastExperiences = await fetchPastExamples(searchContext);

            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const analysisPrompt = `
            너는 법률 문서 분석 AI야. 
            제공된 **총 ${files.length}개의 이미지(문서)**를 종합적으로 읽고 분석해.

            1. [Resources]
               - GitHub Rules (Standard): ${JSON.stringify(specificLogic)}
               - Extraction Guide: ${JSON.stringify(specificReading)}
               - RAG History (Past Experience): ${pastExperiences}

            2. [Tasks]
               - Task A: 오직 "GitHub Rules"만 적용해서 분석해. (Standard Logic)
               - Task B: "GitHub Rules"에 "RAG History"까지 반영해서 분석해. (Advanced Logic)

            **중요: 반드시 아래의 JSON 포맷으로만 답변해.**
            {
                "extracted_facts": "모든 문서에서 취합한 팩트 (공통)",
                "logic_baseline": "Task A 결과 (GitHub 규칙만 적용)",
                "logic_rag": "Task B 결과 (GitHub 규칙 + RAG DB 적용)"
            }
            `;

            // [핵심 수정] 텍스트 프롬프트 + 여러 개의 이미지 파트 결합
            const promptParts = [{ text: analysisPrompt }];
            
            files.forEach(file => {
                promptParts.push({
                    inlineData: {
                        data: file.fileBase64,
                        mimeType: file.mimeType
                    }
                });
            });

            const result = await model.generateContent(promptParts);
            
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
                    logic_rag: textResult
                };
            }

            return res.status(200).json({
                success: true,
                step: 'analyze',
                data: {
                    extraction: aiResponse.extracted_facts,
                    analysis_baseline: aiResponse.logic_baseline,
                    analysis_rag: aiResponse.logic_rag
                }
            });
        }

        // =========================================================
        // STEP 2: 저장 요청 (파일명 목록 저장)
        // =========================================================
        else if (step === 'save') {
            // 저장 시 파일명을 콤마로 구분하여 기록
            const fileNameStr = Array.isArray(files) ? files.map(f => f.fileName).join(", ") : "Unknown File";

            const contentForEmbedding = `
            [Doc Type]: ${docType}
            [Verified Extraction]: ${extraction}
            [Verified Analysis (Final)]: ${analysis} 
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
                    fileName: fileNameStr,
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