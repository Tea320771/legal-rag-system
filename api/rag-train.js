// /api/rag-train.js
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';

// 환경 변수 확인
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    try {
        const { fileBase64, mimeType, fileName, readingStrategy, logicRule } = req.body;

        // ---------------------------------------------------------
        // 1. [문서 이해] Gemini가 문서에서 핵심 텍스트를 추출 (OCR)
        // ---------------------------------------------------------
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
        
        // 프롬프트: 사용자가 지적한 부분(Reading Strategy)을 특히 주의해서 읽으라고 지시
        const ocrPrompt = `
        너는 법률 문서 분석 AI야. 제공된 이미지(PDF)에서 텍스트를 추출해.
        특히 사용자가 다음 부분에 주의하라고 했어: "${readingStrategy || '없음'}"
        
        문서의 '주문(Order)' 부분과 '청구 취지', 그리고 당사자 목록을 중점적으로, 
        사용자의 조언을 반영하여 정확한 텍스트로 추출해줘.
        불필요한 설명 없이 추출된 텍스트만 출력해.
        `;

        const result = await model.generateContent([
            ocrPrompt,
            { inlineData: { data: fileBase64, mimeType: mimeType } }
        ]);
        const extractedText = result.response.text();

        // ---------------------------------------------------------
        // 2. [데이터 구조화] 저장할 RAG 데이터 조립
        // ---------------------------------------------------------
        // 검색(임베딩)에 사용될 텍스트: "규칙 + 원본내용"을 합쳐야 검색이 잘 됨
        const contentForEmbedding = `
        [Instruction Type: User Learned Rule]
        [Reading Strategy]: ${readingStrategy}
        [Logic Rule]: ${logicRule}
        [Context/Source Text]: ${extractedText.substring(0, 1000)}... (생략)
        `;

        // ---------------------------------------------------------
        // 3. [임베딩] 텍스트 -> 벡터 변환 (Gemini text-embedding-004)
        // ---------------------------------------------------------
        const embedModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
        const embedResult = await embedModel.embedContent(contentForEmbedding);
        const vector = embedResult.embedding.values;

        // ---------------------------------------------------------
        // 4. [저장] Pinecone에 메타데이터와 함께 저장
        // ---------------------------------------------------------
        const index = pinecone.index("legal-rag-db"); // 미리 생성한 Index 이름

        const uniqueId = `manual-train-${Date.now()}`; // 고유 ID 생성

        await index.upsert([{
            id: uniqueId,
            values: vector,
            metadata: {
                fileName: fileName,
                type: "user_instruction", // 데이터 타입 구분
                readingStrategy: readingStrategy, // 나중에 AI가 참조할 읽기 비법
                logicRule: logicRule,             // 나중에 AI가 참조할 해석 비법
                extractedContext: extractedText,  // AI가 참고할 원본 텍스트
                createdAt: new Date().toISOString()
            }
        }]);

        res.status(200).json({ 
            success: true, 
            message: "Training data saved successfully", 
            upsertId: uniqueId 
        });

    } catch (error) {
        console.error("RAG Training Error:", error);
        res.status(500).json({ error: error.message });
    }
}