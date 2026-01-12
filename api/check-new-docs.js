// /api/check-new-docs.js
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Supabase 클라이언트 설정 (환경변수 필요)
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
    // 보안: POST 요청만 허용
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        // 1. Supabase Storage의 'legal-docs' 버킷에서 파일 목록 가져오기
        const { data: files, error: storageError } = await supabase
            .storage
            .from('legal-docs')
            .list();

        if (storageError) throw storageError;

        // 2. 이미 처리된 파일인지 DB에서 확인
        const { data: processedDocs } = await supabase
            .from('document_queue')
            .select('filename');
        
        const processedNames = new Set(processedDocs.map(d => d.filename));

        // 3. 새로운 파일만 필터링
        const newFiles = files.filter(f => !processedNames.has(f.name) && f.name !== '.emptyFolderPlaceholder');

        if (newFiles.length === 0) {
            return res.status(200).json({ message: "새로운 파일이 없습니다." });
        }

        // 4. 새로운 파일 하나씩 분석 (Gemini)
        const results = [];
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        for (const file of newFiles) {
            // 파일 다운로드
            const { data: fileBlob } = await supabase.storage.from('legal-docs').download(file.name);
            const arrayBuffer = await fileBlob.arrayBuffer();
            const base64 = Buffer.from(arrayBuffer).toString('base64');

            // Gemini 분석 요청 (기존 프롬프트 재사용)
            const prompt = `
            이 법률 문서를 분석해서 다음 JSON 포맷으로 추출해.
            { "extracted_facts": "...", "logic_analysis": "..." }
            `;
            
            const result = await model.generateContent([
                { text: prompt },
                { inlineData: { data: base64, mimeType: file.metadata.mimetype || 'application/pdf' } }
            ]);

            let aiData = result.response.text().replace(/```json/g, "").replace(/```/g, "").trim();
            try { aiData = JSON.parse(aiData); } catch (e) { aiData = { error: "Parsing Failed", raw: aiData }; }

            // 5. 대기열(DB)에 저장
            const { error: insertError } = await supabase.from('document_queue').insert({
                filename: file.name,
                file_url: `https://[YOUR_PROJECT_ID].supabase.co/storage/v1/object/public/legal-docs/${file.name}`,
                status: 'pending',
                ai_result: aiData
            });

            if (!insertError) results.push(file.name);
        }

        return res.status(200).json({ success: true, processed: results });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}