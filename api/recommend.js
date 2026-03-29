export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method Not Allowed' });
    }

    const { titles, preferenceInsights } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    const insightText = preferenceInsights ? `
[사용자 취향 요약]
상위 선호작:
${(preferenceInsights.topFavorites || []).map(x => `- ${x.title} (${x.tier}) : ${x.review || '리뷰 없음'}`).join('\n')}

비선호작:
${(preferenceInsights.dislikedTitles || []).map(x => `- ${x.title} (${x.tier}) : ${x.review || '리뷰 없음'}`).join('\n')}

좋아하는 요소:
${(preferenceInsights.likedFeatures || []).map(x => `- ${x.feature} / 평균 ${x.average} / 신뢰도 ${x.confidence}`).join('\n')}

싫어하거나 민감한 요소:
${(preferenceInsights.dislikedFeatures || []).map(x => `- ${x.feature} / 평균 ${x.average} / 신뢰도 ${x.confidence}`).join('\n')}

장르 참고:
${(preferenceInsights.genrePreferences || []).map(x => `- ${x.genre} / 평균 ${x.average} / count ${x.count}`).join('\n')}

리뷰 근거:
${(preferenceInsights.reviewEvidence || []).slice(0, 12).map(x => `- ${x.title} (${x.tier}) : ${x.review}`).join('\n')}
` : '';

    const payload = {
        contents: [{
            parts: [{
                text: `사용자가 이미 본 작품 목록:
${titles || '없음'}

${insightText}

할 일:
- 이 사용자가 좋아할 만한 애니메이션을 반드시 정확히 4개 추천하라.
- 이미 본 작품은 절대 추천하지 말 것.
- 단순히 장르만 비슷한 작품을 추천하지 말 것.
- preferenceInsights를 가장 중요한 근거로 사용하라.
- 단순 장르 분포보다 사용자 리뷰에서 드러난 취향을 우선 반영하라.
- 특히 아래 요소를 중요하게 고려하라:
  1. 서사/전개
  2. 캐릭터와 주인공 성격
  3. 감성/분위기
  4. 작화/연출/음악
  5. 결말과 시즌별 완성도
- 추천 이유는 반드시 이 사용자의 취향 특징과 연결해서 구체적으로 작성하라.
- 너무 뻔한 국민작만 고르지 말고, 취향 적합도를 우선하라.
- 포스터 URL, 평점, 줄거리, 장르, 개봉일은 작성하지 말고 제목과 원제, 추천 이유만 반환하라.
- 반드시 아래 JSON 배열 형식으로만 응답하라.

각 항목 형식:
{
  "title": "작품명",
  "originalTitle": "원제",
  "reason": "이 사용자는 ...을 좋아하고 ...에는 민감하기 때문에 이 작품이 잘 맞을 가능성이 높다."
}`
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
                        originalTitle: { type: "STRING" },
                        reason: { type: "STRING" }
                    },
                    required: ["title", "originalTitle", "reason"]
                }
            }
        }
    };

    let result = null;
    const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

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
                result = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
                break;
            }
        } catch (e) {
            continue;
        }
    }

    if (!result) {
        return res.status(429).json({ error: 'AI limit reached' });
    }

    return res.status(200).json(result);
}