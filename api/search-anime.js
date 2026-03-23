export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const apiKey = process.env.GEMINI_API_KEY;
    const tmdbApiKey = process.env.TMDB_API_KEY;

    const payload = {
        contents: [{
            parts: [{ text: `애니메이션 "${query}"에 대한 정보를 찾아주세요. 반드시 아래 형식의 순수 JSON 객체로만 응답하세요. 마크다운이나 다른 설명은 절대 추가하지 마세요.\n{"correctedTitle": "정확한 공식 한국어 제목", "shortReview": "해당 작품의 핵심을 나타내는 15자 이내의 아주 짧은 한줄평"}` }]
        }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    correctedTitle: { type: "STRING" },
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

    if (!geminiData) {
        return res.status(429).json({ error: 'AI limit reached' });
    }

    let tmdbInfo = null;
    if (tmdbApiKey) {
        const searchTitle = geminiData.correctedTitle || query;
        const genreMap = { 
            28: "액션", 12: "모험", 16: "애니메이션", 35: "코미디", 80: "범죄", 99: "다큐멘터리", 
            18: "드라마", 10751: "가족", 14: "판타지", 36: "역사", 27: "공포", 10402: "음악", 
            9648: "미스터리", 10749: "로맨스", 878: "SF", 10770: "TV 영화", 53: "스릴러", 10752: "전쟁", 
            37: "서부", 10759: "액션/어드벤처", 10762: "아동", 10763: "뉴스", 10764: "리얼리티", 
            10765: "SF/판타지", 10766: "소프", 10767: "토크", 10768: "전쟁/정치"
        };
        
        try {
            let tmdbRes = await fetch(`https://api.themoviedb.org/3/search/tv?api_key=${tmdbApiKey}&language=ko-KR&query=${encodeURIComponent(searchTitle)}`);
            let tmdbData = await tmdbRes.json();
            let bestMatch = tmdbData.results?.[0];

            if (!bestMatch) {
                tmdbRes = await fetch(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&language=ko-KR&query=${encodeURIComponent(searchTitle)}`);
                tmdbData = await tmdbRes.json();
                bestMatch = tmdbData.results?.[0];
            }

            if (bestMatch) {
                tmdbInfo = {
                    title: bestMatch.name || bestMatch.title || searchTitle,
                    originalTitle: bestMatch.original_name || bestMatch.original_title || '',
                    overview: bestMatch.overview || '',
                    rating: bestMatch.vote_average || 0,
                    popularity: bestMatch.popularity || 0,
                    releaseDate: bestMatch.first_air_date || bestMatch.release_date || '',
                    genres: (bestMatch.genre_ids || []).map(id => genreMap[id]).filter(g => g && g !== '애니메이션'),
                    posterUrl: bestMatch.poster_path ? `https://image.tmdb.org/t/p/w500${bestMatch.poster_path}` : ''
                };
            }
        } catch(e) {
            console.error('TMDb Error:', e);
        }
    }

    return res.status(200).json({
        correctedTitle: geminiData.correctedTitle,
        shortReview: geminiData.shortReview,
        tmdbInfo
    });
}