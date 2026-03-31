export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'Query required' });

    const apiKey = process.env.GEMINI_API_KEY;
    const tmdbApiKey = process.env.TMDB_API_KEY;

    async function callGeminiJSON(promptText, schema) {
        const payload = {
            contents: [{
                parts: [{ text: promptText }]
            }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema
            }
        };

        const models = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];

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
                if (!text) continue;

                return JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
            } catch (e) {
                continue;
            }
        }

        return null;
    }

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
        } catch (e) {
            return [];
        }
    }

    function mergeAndDedupe(...arrays) {
        const map = new Map();
        arrays.flat().forEach(item => {
            if (item?.id != null) map.set(item.id, item);
        });
        return Array.from(map.values());
    }

    function onlyAnime(results) {
        return results.filter(r => (r.genre_ids || []).includes(16));
    }

    function normalizeSimple(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[：:]/g, ' ')
            .replace(/[-‐-‒–—―~]/g, ' ')
            .replace(/[()\[\]{}【】「」『』<>〈〉]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // STEP 1: 1차 제목 보정
    const correctedData = await callGeminiJSON(
        `사용자가 애니메이션 "${query}"을(를) 찾으려 합니다.
줄임말, 오타, 비공식 명칭일 수 있습니다.
TMDb에서 검색하기 가장 적합한 공식 제목 1개를 JSON으로 반환하세요.
작품을 새로 창작하지 말고, 실제로 존재하는 제목 기준으로만 답하세요.
마크다운 없이 순수 JSON만 응답하세요.

{"correctedTitle": "TMDb 검색용 제목"}`,
        {
            type: "OBJECT",
            properties: {
                correctedTitle: { type: "STRING" }
            }
        }
    );

    const correctedTitle = correctedData?.correctedTitle || query;

    // STEP 2: 기본 검색들
    const baseTerms = [
        query,
        correctedTitle,
        query.replace(/\s+/g, ''),
        correctedTitle.replace(/\s+/g, ''),
        query.split(':')[0].trim(),
        correctedTitle.split(':')[0].trim(),
        query.split('：')[0].trim(),
        correctedTitle.split('：')[0].trim()
    ];

    let initialResults = [];
    for (const term of [...new Set(baseTerms)].filter(Boolean)) {
        const fetched = await fetchTMDb(term);
        initialResults = mergeAndDedupe(initialResults, fetched);
    }

    let animeResults = onlyAnime(initialResults);

    // STEP 3: 결과가 약하면 Gemini에게 유사 검색어 여러 개 요청
    if (animeResults.length === 0) {
        const altData = await callGeminiJSON(
            `사용자가 애니메이션 "${query}"을 찾고 있습니다.
현재 1차 보정 제목은 "${correctedTitle}" 입니다.
TMDb에서 검색이 잘 될 가능성이 높은 제목 후보를 최대 6개 만들어 주세요.

규칙:
- 실제 존재하는 작품 기준의 제목만
- 제목을 새로 창작하지 말 것
- 한국어/영어/짧은 공식명/부제 제거형 제목 가능
- 특히 콜론(:)이 붙은 긴 제목은, 필요하면 메인 제목만 따로 후보에 포함할 것
- 예: "기생수: 세이의 격률" 같은 경우 "기생수" 같은 짧은 제목도 후보에 포함 가능

마크다운 없이 순수 JSON만 응답하세요.

{
  "alternatives": ["후보1", "후보2", "후보3"]
}`,
            {
                type: "OBJECT",
                properties: {
                    alternatives: {
                        type: "ARRAY",
                        items: { type: "STRING" }
                    }
                }
            }
        );

        const aliasMap = {
            "윈브레": ["WINBRE", "WIND BREAKER", "윈드 브레이커"],
            "진격거": ["진격의 거인", "Attack on Titan"],
            "헌헌": ["헌터×헌터", "헌터x헌터", "Hunter x Hunter"],
            "프리렌": ["장송의 프리렌", "Frieren"],
            "슈타게": ["슈타인즈 게이트", "Steins;Gate"],
            "리제로": ["Re:제로부터 시작하는 이세계 생활", "Re:Zero", "Re Zero"],
            "기생수": ["기생수", "기생수: 세이의 격률", "Parasyte", "Parasyte -the maxim-"]
        };

        const geminiAlternatives = altData?.alternatives || [];

        const fallbackTerms = [
            ...geminiAlternatives,
            ...(aliasMap[query] || []),
            ...(aliasMap[normalizeSimple(query)] || []),
            query.toUpperCase(),
            correctedTitle.toUpperCase(),
            normalizeSimple(query),
            normalizeSimple(correctedTitle),
            query.replace(/\s+/g, ''),
            correctedTitle.replace(/\s+/g, ''),
            query.split(':')[0].trim(),
            correctedTitle.split(':')[0].trim()
        ];

        const retryQueue = [...new Set(fallbackTerms)]
            .filter(v => v && normalizeSimple(v) !== normalizeSimple(query))
            .slice(0, 10);

        for (const term of retryQueue) {
            const fetched = await fetchTMDb(term);
            initialResults = mergeAndDedupe(initialResults, fetched);
            const filtered = onlyAnime(initialResults);
            if (filtered.length > 0) {
                animeResults = filtered;
                break;
            }
        }
    }

    let finalResults = animeResults.length > 0 ? animeResults : initialResults;

    function calcSim(title, original_title, q) {
        const t = normalizeSimple(title);
        const ot = normalizeSimple(original_title);
        const qLower = normalizeSimple(q);

        if (t === qLower || ot === qLower) return 100;
        if (t.includes(qLower) || ot.includes(qLower)) return 50;

        const qMain = qLower.split(':')[0].trim();
        if (qMain && (t === qMain || ot === qMain)) return 90;
        if (qMain && (t.includes(qMain) || ot.includes(qMain))) return 40;

        return 0;
    }

    finalResults.sort((a, b) => {
        const simA = calcSim(a.name || a.title, a.original_name || a.original_title, query);
        const simB = calcSim(b.name || b.title, b.original_name || b.original_title, query);
        if (simA !== simB) return simB - simA;

        const animeA = (a.genre_ids || []).includes(16) ? 1 : 0;
        const animeB = (b.genre_ids || []).includes(16) ? 1 : 0;
        if (animeA !== animeB) return animeB - animeA;

        const titleA = normalizeSimple(a.name || a.title || '');
        const titleB = normalizeSimple(b.name || b.title || '');
        const mainQuery = normalizeSimple(query).split(':')[0].trim();

        const exactMainA = titleA === mainQuery ? 1 : 0;
        const exactMainB = titleB === mainQuery ? 1 : 0;
        if (exactMainA !== exactMainB) return exactMainB - exactMainA;

        const tvA = a.media_type === 'tv' ? 1 : 0;
        const tvB = b.media_type === 'tv' ? 1 : 0;
        if (tvA !== tvB) return tvB - tvA;

        if ((b.popularity || 0) !== (a.popularity || 0)) {
            return (b.popularity || 0) - (a.popularity || 0);
        }

        const dateA = new Date(a.first_air_date || a.release_date || "9999-12-31").getTime();
        const dateB = new Date(b.first_air_date || b.release_date || "9999-12-31").getTime();
        return dateA - dateB;
    });

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