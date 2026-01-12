// /api/check-new-docs.js
import { createClient } from '@supabase/supabase-js';

// 1. 환경변수 로드
const supabaseUrl = process.env.SUPABASE_URL || "MISSING";
const supabaseKey = process.env.SUPABASE_KEY || "MISSING";

// [진단 1] 키 정보 일부 노출 (앞 10자리만)
// 로그에서 이 부분이 'ey...'로 시작하는지, 그리고 'service_role' 키와 일치하는지 확인해야 합니다.
const keyPrefix = supabaseKey.substring(0, 10);
const urlPrefix = supabaseUrl.substring(0, 15);

const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
    // GET, POST 모두 허용
    if (req.method !== 'POST' && req.method !== 'GET') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    console.log("==========================================");
    console.log("🚀 [진단 시작] check-new-docs");
    console.log(`🔗 DB URL: ${urlPrefix}...`);
    console.log(`pV Key Prefix: ${keyPrefix}... (새 키가 적용됐나요?)`);
    console.log("==========================================");

    try {
        // [진단 2] DB 연결 테스트 (status 상관없이 전체 개수 조회)
        // RLS(보안) 문제가 있다면 여기서 에러가 나거나 0개가 나옵니다.
        const { count, error: countError } = await supabase
            .from('document_queue')
            .select('*', { count: 'exact', head: true });

        if (countError) {
            console.error("❌ DB 접속 실패 (권한 또는 주소 문제):");
            console.error(countError);
            throw new Error(`DB Error: ${countError.message}`);
        }

        console.log(`📊 DB 전체 데이터 수: ${count}개`);

        // [진단 3] 'pending' 상태 데이터 조회
        const { data: pendingDocs, error: selectError } = await supabase
            .from('document_queue')
            .select('id, filename, status, created_at') // 일부 컬럼만 조회
            .eq('status', 'pending');

        if (selectError) throw new Error(`Pending 조회 실패: ${selectError.message}`);

        console.log(`⏳ 발견된 'pending' 문서: ${pendingDocs.length}개`);
        
        if (pendingDocs.length > 0) {
            console.log("📄 목록:");
            pendingDocs.forEach(d => console.log(` - [${d.id}] ${d.filename} (${d.created_at})`));
        } else {
            console.log("⚠️ 'pending' 문서가 0개입니다. (업로드가 안 됐거나, 이미 처리됨)");
            
            // [추가 확인] 혹시 'processed'나 'error'로 되어 있는지 확인
            const { data: allDocs } = await supabase.from('document_queue').select('status').limit(5);
            console.log("참고 - 최근 문서 상태들:", allDocs.map(d => d.status));
        }

        return res.status(200).json({
            success: true,
            diagnosis: {
                url_check: urlPrefix,
                key_check: keyPrefix,
                total_rows: count,
                pending_rows: pendingDocs.length,
                pending_files: pendingDocs.map(d => d.filename)
            }
        });

    } catch (error) {
        console.error("Handler Error:", error);
        return res.status(500).json({ error: error.message, stack: error.stack });
    }
}