export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const apiKey = process.env.GEMINI_API_KEY;
    const tmdbApiKey = process.env.TMDB_API_KEY;

    // STEP 1: Gemini를 통한 검색어 보정 (작품 확정 X)
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

    const correctedTitle = geminiData?.correctedTitle || query;

    // TMDb 검색 헬퍼 함수
    async function fetchTMDb(term) {
        if (!term || !tmdbApiKey) return [];
        try {
            const [tvRes, movieRes] = await Promise.all([
                fetch(`https://api.themoviedb.org/3/search/tv?api_key=${tmdbApiKey}&language=ko-KR&query=${encodeURIComponent(term)}`),
                fetch(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&language=ko-KR&query=${encodeURIComponent(term)}`)
            ]);
            const tvData = await tvRes.json();
            const movieData = await movieRes.json();
            return [
                ...(tvData.results || []).map(r => ({ ...r, media_type: 'tv' })),
                ...(movieData.results || []).map(r => ({ ...r, media_type: 'movie' }))
            ];
        } catch(e) {
            return [];
        }
    }

    function mergeAndDedupe(arr1, arr2) {
        const map = new Map();
        arr1.forEach(item => map.set(item.id, item));
        arr2.forEach(item => map.set(item.id, item));
        return Array.from(map.values());
    }

    // STEP 2: 원문 + 보정어 이중 검색
    let initialResults = await fetchTMDb(query);
    if (query !== correctedTitle) {
        initialResults = mergeAndDedupe(initialResults, await fetchTMDb(correctedTitle));
    }

    // STEP 3: 1차 필터 (애니메이션 장르 포함)
    let animeResults = initialResults.filter(r => (r.genre_ids || []).includes(16));

    // STEP 4: 재시도 로직 (최대 5회)
    if (animeResults.length === 0) {
        const aliasMap = {
            "윈브레": ["WINBRE", "WIND BREAKER", "윈드 브레이커"],
            "진격거": ["진격의 거인", "Attack on Titan"],
            "헌헌": ["헌터x헌터", "Hunter x Hunter"],
            "프리렌": ["장송의 프리렌", "Frieren"],
            "슈타게": ["슈타인즈 게이트", "Steins;Gate"]
        };

        const variations = [
            query.replace(/\s+/g, ''), 
            query.split('').join(' '), 
            query.toUpperCase(), 
            ...(aliasMap[query] || aliasMap[query.replace(/\s+/g, '')] || []), 
            correctedTitle.replace(/\s+/g, '')
        ];

        const retryQueue = [...new Set(variations)]
            .filter(v => v && v !== query && v !== correctedTitle)
            .slice(0, 5);

        for (const term of retryQueue) {
            const res = await fetchTMDb(term);
            initialResults = mergeAndDedupe(initialResults, res);
            
            const filtered = initialResults.filter(r => (r.genre_ids || []).includes(16));
            if (filtered.length > 0) {
                animeResults = filtered;
                break;
            }
        }
    }

    // STEP 5: Fallback (애니메이션 결과가 전혀 없을 경우 전체 결과 사용)
    let finalResults = animeResults.length > 0 ? animeResults : initialResults;

    // STEP 6: 정렬 로직
    function calcSim(title, original_title, q) {
        const t = (title || "").toLowerCase();
        const ot = (original_title || "").toLowerCase();
        const qLower = q.toLowerCase();
        if (t === qLower || ot === qLower) return 100;
        if (t.includes(qLower) || ot.includes(qLower)) return 50;
        return 0;
    }

    finalResults.sort((a, b) => {
        // 1. 제목 유사도
        const simA = calcSim(a.name || a.title, a.original_name || a.original_title, query);
        const simB = calcSim(b.name || b.title, b.original_name || b.original_title, query);
        if (simA !== simB) return simB - simA; 

        // 2. 애니메이션 여부 (16번 장르)
        const animeA = (a.genre_ids || []).includes(16) ? 1 : 0;
        const animeB = (b.genre_ids || []).includes(16) ? 1 : 0;
        if (animeA !== animeB) return animeB - animeA; 

        // 3. 콜론(:) 없는 제목 우선
        const colonA = (a.name || a.title || "").includes(":") ? 1 : 0;
        const colonB = (b.name || b.title || "").includes(":") ? 1 : 0;
        if (colonA !== colonB) return colonA - colonB; 

        // 4. TV 시리즈 우선
        const tvA = a.media_type === 'tv' ? 1 : 0;
        const tvB = b.media_type === 'tv' ? 1 : 0;
        if (tvA !== tvB) return tvB - tvA; 

        // 5. 인기순
        if ((b.popularity || 0) !== (a.popularity || 0)) {
            return (b.popularity || 0) - (a.popularity || 0); 
        }

        // 6. 방영일 오래된 순
        const dateA = new Date(a.first_air_date || a.release_date || "9999-12-31").getTime();
        const dateB = new Date(b.first_air_date || b.release_date || "9999-12-31").getTime();
        return dateA - dateB; 
    });

    // STEP 7: 반환 객체 구성
    const genreMap = { 
        28: "액션", 12: "모험", 16: "애니메이션", 35: "코미디", 80: "범죄", 99: "다큐멘터리", 
        18: "드라마", 10751: "가족", 14: "판타지", 36: "역사", 27: "공포", 10402: "음악", 
        9648: "미스터리", 10749: "로맨스", 878: "SF", 10770: "TV 영화", 53: "스릴러", 10752: "전쟁", 
        37: "서부", 10759: "액션/어드벤처", 10762: "아동", 10763: "뉴스", 10764: "리얼리티", 
        10765: "SF/판타지", 10766: "소프", 10767: "토크", 10768: "전쟁/정치"
    };

    const results = finalResults.slice(0, 5).map(item => ({
        id: item.id,
        media_type: item.media_type,
        title: item.name || item.title || query,
        original_title: item.original_name || item.original_title || '',
        poster_url: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '',
        genres: (item.genre_ids || []).map(id => genreMap[id]).filter(g => g && g !== '애니메이션'),
        overview: item.overview || '',
        vote_average: item.vote_average || 0,
        release_date: item.first_air_date || item.release_date || ''
    }));

    return res.status(200).json({
        correctedTitle,
        results
    });
}
