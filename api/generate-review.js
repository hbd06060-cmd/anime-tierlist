export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { title, originalTitle, overview, genres, releaseDate, voteAverage } = req.body;
    
    if (!title) return res.status(400).json({ error: 'Title required' });

    const apiKey = process.env.GEMINI_API_KEY;

    const animeInfo = `
    제목: ${title}
    원제: ${originalTitle || '정보없음'}
    개봉/방영일: ${releaseDate || '정보없음'}
    장르: ${(genres || []).join(', ')}
    평점: ${voteAverage || '정보없음'}
    줄거리: ${overview || '정보없음'}
    `;

    const payload = {
        contents: [{
            parts: [{ text: `아래 제공된 애니메이션 정보를 바탕으로 해당 작품의 핵심 매력이나 평가를 나타내는 15자 이내의 아주 짧은 한줄평을 작성해주세요. 반드시 아래 형식의 순수 JSON 객체로만 응답하세요. 마크다운 없이 순수 JSON만 응답하세요.\n\n[작품 정보]\n${animeInfo}\n\n{"shortReview": "15자 이내의 한줄평"}` }]
        }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    shortReview: { type: "STRING" }
                }
            }
        }
    };

    let geminiData = null;
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash', 'gemini-3.1-flash-lite'];
    
    for (const model of models) {
        try {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (!r.ok) continue; 
            const json = await r.json();
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
                geminiData = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
                break;
            }
        } catch(e) {
            continue;
        }
    }

    if (!geminiData || !geminiData.shortReview) {
        return res.status(200).json({
            success: true,
            shortReview: "인상적인 작품입니다."
        });
    }

    return res.status(200).json({
        success: true,
        shortReview: geminiData.shortReview
    });
}