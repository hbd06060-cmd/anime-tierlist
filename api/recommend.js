export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { titles } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;
    const tmdbApiKey = process.env.TMDB_API_KEY;

    const payload = {
        contents: [{
            parts: [{
                text: `사용자가 다음 애니메이션들을 시청했습니다: ${titles}. 이 취향과 장르 분포를 바탕으로, 아직 사용자가 안 봤을 만한 완전히 새로운 애니메이션 명작을 정확히 3개만 추천해.`
            }]
        }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        title: { type: "STRING" },
                        reason: { type: "STRING" }
                    }
                }
            }
        }
    };

    let recArray = null;
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3-flash', 'gemini-3.1-flash-lite'];

    for (const model of models) {
        try {
            const r = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }
            );

            if (!r.ok) continue;

            const json = await r.json();
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

            if (text) {
                recArray = JSON.parse(
                    text.replace(/```json/g, '').replace(/```/g, '').trim()
                );
                break;
            }
        } catch (e) {
            continue;
        }
    }

    if (!recArray) {
        return res.status(429).json({ error: 'AI limit reached' });
    }

    const genreMap = {
        28: "액션",
        12: "모험",
        16: "애니메이션",
        35: "코미디",
        80: "범죄",
        99: "다큐멘터리",
        18: "드라마",
        10751: "가족",
        14: "판타지",
        36: "역사",
        27: "공포",
        10402: "음악",
        9648: "미스터리",
        10749: "로맨스",
        878: "SF",
        10770: "TV 영화",
        53: "스릴러",
        10752: "전쟁",
        37: "서부",
        10759: "액션/어드벤처",
        10762: "아동",
        10763: "뉴스",
        10764: "리얼리티",
        10765: "SF/판타지",
        10766: "소프",
        10767: "토크",
        10768: "전쟁/정치"
    };

    async function correctTitleForTMDb(title) {
        if (!title || !apiKey) return title;

        const correctionPayload = {
            contents: [{
                parts: [{
                    text: `사용자가 애니메이션 "${title}"을(를) 추천받았습니다. 이 제목은 별칭, 오타, 비공식 명칭일 수 있습니다. TMDb에서 검색하기 가장 적합한 공식 한국어 제목으로 보정해서 JSON 객체로 반환하세요. 마크다운 없이 순수 JSON만 응답하세요.\n{"correctedTitle": "정확한 공식 한국어 제목"}`
                }]
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

        for (const model of models) {
            try {
                const r = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(correctionPayload)
                    }
                );

                if (!r.ok) continue;

                const json = await r.json();
                const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

                if (text) {
                    const parsed = JSON.parse(
                        text.replace(/```json/g, '').replace(/```/g, '').trim()
                    );
                    return parsed.correctedTitle || title;
                }
            } catch (e) {
                continue;
            }
        }

        return title;
    }

    async function fetchTMDbCandidates(term) {
        if (!term || !tmdbApiKey) return [];

        try {
            const [tvRes, movieRes] = await Promise.all([
                fetch(
                    `https://api.themoviedb.org/3/search/tv?api_key=${tmdbApiKey}&language=ko-KR&query=${encodeURIComponent(term)}`
                ),
                fetch(
                    `https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&language=ko-KR&query=${encodeURIComponent(term)}`
                )
            ]);

            const tvData = await tvRes.json();
            const movieData = await movieRes.json();

            return [
                ...(tvData.results || []).map(item => ({ ...item, media_type: 'tv' })),
                ...(movieData.results || []).map(item => ({ ...item, media_type: 'movie' }))
            ];
        } catch (e) {
            return [];
        }
    }

    function mergeAndDedupe(arr1, arr2) {
        const map = new Map();
        [...arr1, ...arr2].forEach(item => {
            map.set(`${item.media_type}-${item.id}`, item);
        });
        return Array.from(map.values());
    }

    function calcSim(title, originalTitle, q) {
        const t = (title || '').toLowerCase();
        const ot = (originalTitle || '').toLowerCase();
        const qLower = (q || '').toLowerCase();

        if (!qLower) return 0;
        if (t === qLower || ot === qLower) return 100;
        if (t.includes(qLower) || ot.includes(qLower)) return 50;
        return 0;
    }

    function getMetadataScore(item) {
        let score = 0;
        if (item.poster_path) score += 3;
        if (item.overview && item.overview.trim().length > 20) score += 3;
        if (item.vote_average && item.vote_average > 0) score += 2;
        if ((item.genre_ids || []).includes(16)) score += 2;
        if (item.media_type === 'tv') score += 1;
        return score;
    }

    async function resolveAnimeFromTMDb(rawTitle) {
        const correctedTitle = await correctTitleForTMDb(rawTitle);

        const aliasMap = {
            "윈브레": ["WINBRE", "WIND BREAKER", "윈드 브레이커"],
            "진격거": ["진격의 거인", "Attack on Titan"],
            "헌헌": ["헌터x헌터", "Hunter x Hunter"],
            "프리렌": ["장송의 프리렌", "Frieren"],
            "슈타게": ["슈타인즈 게이트", "Steins;Gate"],

            "기생수: 더 맥심": ["기생수", "기생수 세이의 격률", "Parasyte", "Parasyte -the maxim-"],
            "기생수 더 맥심": ["기생수", "기생수 세이의 격률", "Parasyte", "Parasyte -the maxim-"],
            "기생수": ["기생수 세이의 격률", "Parasyte", "Parasyte -the maxim-"],
            "기생수: 세이의 격률": ["기생수", "Parasyte", "Parasyte -the maxim-"],
            "Parasyte": ["기생수", "기생수 세이의 격률", "Parasyte -the maxim-"],
            "Parasyte -the maxim-": ["기생수", "기생수 세이의 격률", "Parasyte"]
        };

        let results = await fetchTMDbCandidates(rawTitle);

        if (correctedTitle && correctedTitle !== rawTitle) {
            results = mergeAndDedupe(results, await fetchTMDbCandidates(correctedTitle));
        }

        const normalizedRawTitle = rawTitle ? rawTitle.replace(/\s+/g, '') : '';
        const normalizedCorrectedTitle = correctedTitle ? correctedTitle.replace(/\s+/g, '') : '';

        const variations = [
            rawTitle,
            correctedTitle,
            normalizedRawTitle,
            normalizedCorrectedTitle,
            ...(aliasMap[rawTitle] || []),
            ...(aliasMap[correctedTitle] || []),
            ...(aliasMap[normalizedRawTitle] || []),
            ...(aliasMap[normalizedCorrectedTitle] || [])
        ].filter(Boolean);

        for (const term of [...new Set(variations)]) {
            results = mergeAndDedupe(results, await fetchTMDbCandidates(term));
        }

        if (results.length === 0) return null;

        const animeResults = results.filter(item => (item.genre_ids || []).includes(16));
        const finalResults = animeResults.length > 0 ? animeResults : results;

        finalResults.sort((a, b) => {
            const simA = Math.max(
                calcSim(a.name || a.title, a.original_name || a.original_title, rawTitle),
                calcSim(a.name || a.title, a.original_name || a.original_title, correctedTitle || '')
            );

            const simB = Math.max(
                calcSim(b.name || b.title, b.original_name || b.original_title, rawTitle),
                calcSim(b.name || b.title, b.original_name || b.original_title, correctedTitle || '')
            );

            if (simA !== simB) return simB - simA;

            const metaA = getMetadataScore(a);
            const metaB = getMetadataScore(b);
            if (metaA !== metaB) return metaB - metaA;

            const animeA = (a.genre_ids || []).includes(16) ? 1 : 0;
            const animeB = (b.genre_ids || []).includes(16) ? 1 : 0;
            if (animeA !== animeB) return animeB - animeA;

            const colonA = (a.name || a.title || '').includes(':') ? 1 : 0;
            const colonB = (b.name || b.title || '').includes(':') ? 1 : 0;
            if (colonA !== colonB) return colonA - colonB;

            const tvA = a.media_type === 'tv' ? 1 : 0;
            const tvB = b.media_type === 'tv' ? 1 : 0;
            if (tvA !== tvB) return tvB - tvA;

            return (b.popularity || 0) - (a.popularity || 0);
        });

        const usableResult = finalResults.find(item =>
            item.poster_path ||
            (item.overview && item.overview.trim().length > 20) ||
            (item.vote_average && item.vote_average > 0)
        );

        return usableResult || finalResults[0];
    }

    const finalRecs = [];

    for (const rec of recArray.slice(0, 3)) {
        let tmdbInfo = null;

        if (tmdbApiKey) {
            try {
                const bestMatch = await resolveAnimeFromTMDb(rec.title);

                if (bestMatch) {
                    tmdbInfo = {
                        title: bestMatch.name || bestMatch.title || rec.title,
                        originalTitle: bestMatch.original_name || bestMatch.original_title || '',
                        overview: bestMatch.overview || '',
                        rating: bestMatch.vote_average || 0,
                        releaseDate: bestMatch.first_air_date || bestMatch.release_date || '',
                        genres: (bestMatch.genre_ids || [])
                            .map(id => genreMap[id])
                            .filter(g => g && g !== '애니메이션'),
                        posterUrl: bestMatch.poster_path
                            ? `https://image.tmdb.org/t/p/w500${bestMatch.poster_path}`
                            : ''
                    };
                }
            } catch (e) {
                console.error('TMDb Error:', e);
            }
        }

        finalRecs.push({
            title: tmdbInfo ? tmdbInfo.title : rec.title,
            originalTitle: tmdbInfo?.originalTitle || '',
            posterUrl: tmdbInfo?.posterUrl || '',
            genres: tmdbInfo?.genres || [],
            overview: tmdbInfo?.overview || '',
            rating: tmdbInfo?.rating || 0,
            releaseDate: tmdbInfo?.releaseDate || '',
            reason: rec.reason
        });
    }

    return res.status(200).json(finalRecs);
}