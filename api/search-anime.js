export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const apiKey = process.env.GEMINI_API_KEY;
    const tmdbApiKey = process.env.TMDB_API_KEY;

    // 1단계: Gemini를 통한 검색어 보정 (작품 확정 X)
    const payload = {
        contents: [{
            parts: [{ text: `사용자가 애니메이션 "${query}"을(를) 찾으려 합니다. 줄임말, 오타, 비공식 명칭일 수 있습니다. TMDb에서 검색하기 가장 적합한 공식 한국어 제목으로 보정해서 JSON 객체로 반환하세요. 마크다운 없이 순수 JSON만 응답하세요.\n{"correctedTitle": "정확한 공식 한국어 제목"}` }]
        }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    correctedTitle: { type: "STRING" }
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

    const correctedTitle = geminiData.correctedTitle || query;
    let results = [];

    // 2단계: TMDb에서 TV와 Movie 모두 검색 후 후보 리스트 반환
    if (tmdbApiKey) {
        const genreMap = { 
            28: "액션", 12: "모험", 16: "애니메이션", 35: "코미디", 80: "범죄", 99: "다큐멘터리", 
            18: "드라마", 10751: "가족", 14: "판타지", 36: "역사", 27: "공포", 10402: "음악", 
            9648: "미스터리", 10749: "로맨스", 878: "SF", 10770: "TV 영화", 53: "스릴러", 10752: "전쟁", 
            37: "서부", 10759: "액션/어드벤처", 10762: "아동", 10763: "뉴스", 10764: "리얼리티", 
            10765: "SF/판타지", 10766: "소프", 10767: "토크", 10768: "전쟁/정치"
        };
        
        try {
            const [tvRes, movieRes] = await Promise.all([
                fetch(`https://api.themoviedb.org/3/search/tv?api_key=${tmdbApiKey}&language=ko-KR&query=${encodeURIComponent(correctedTitle)}`),
                fetch(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&language=ko-KR&query=${encodeURIComponent(correctedTitle)}`)
            ]);

            const tvData = await tvRes.json();
            const movieData = await movieRes.json();

            const allItems = [...(tvData.results || []), ...(movieData.results || [])];

            // 정렬 기준: 애니메이션 장르 우대, 인기도순
            allItems.sort((a, b) => {
                const aIsAnime = (a.genre_ids || []).includes(16) ? 1 : 0;
                const bIsAnime = (b.genre_ids || []).includes(16) ? 1 : 0;
                if (aIsAnime !== bIsAnime) return bIsAnime - aIsAnime;
                return (b.popularity || 0) - (a.popularity || 0);
            });

            // 상위 5개 후보 추출
            const topCandidates = allItems.slice(0, 5);

            results = topCandidates.map(item => ({
                id: item.id,
                mediaType: item.name ? 'tv' : 'movie',
                title: item.name || item.title || correctedTitle,
                originalTitle: item.original_name || item.original_title || '',
                overview: item.overview || '',
                rating: item.vote_average || 0,
                popularity: item.popularity || 0,
                releaseDate: item.first_air_date || item.release_date || '',
                genres: (item.genre_ids || []).map(id => genreMap[id]).filter(g => g && g !== '애니메이션'),
                posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : ''
            }));

        } catch(e) {
            console.error('TMDb Error:', e);
        }
    }

    return res.status(200).json({
        correctedTitle: correctedTitle,
        results: results
    });
}
