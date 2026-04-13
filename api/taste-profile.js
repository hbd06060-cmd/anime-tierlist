export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { ss, s, a, b, c, d, preferenceInsights } = req.body || {};
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'Missing GEMINI_API_KEY' });
  }

  const safeList = (arr, formatter) => {
    try {
      return (Array.isArray(arr) ? arr : []).map(formatter).join('\n') || '없음';
    } catch (_) {
      return '없음';
    }
  };

  const insightText = preferenceInsights ? `
[사용자 취향 요약]
상위 선호작:
${safeList(preferenceInsights.topFavorites, x => `- ${x.title} (${x.tier}) : ${x.review || '리뷰 없음'}`)}

비선호작:
${safeList(preferenceInsights.dislikedTitles, x => `- ${x.title} (${x.tier}) : ${x.review || '리뷰 없음'}`)}

좋아하는 평가 요소:
${safeList(preferenceInsights.likedFeatures, x => `- ${x.feature} / 평균 ${x.average} / 신뢰도 ${x.confidence}`)}

민감하게 싫어하는 평가 요소:
${safeList(preferenceInsights.dislikedFeatures, x => `- ${x.feature} / 평균 ${x.average} / 신뢰도 ${x.confidence}`)}

장르 참고:
${safeList(preferenceInsights.genrePreferences, x => `- ${x.genre} / 평균 ${x.average} / count ${x.count}`)}
` : '';

  const prompt = `
사용자의 애니메이션 티어리스트는 다음과 같습니다.

SS: ${ss || '없음'}
S: ${s || '없음'}
A: ${a || '없음'}
B: ${b || '없음'}
C: ${c || '없음'}
D: ${d || '없음'}

${insightText}

너의 역할:
- 사용자의 애니메이션 취향을 한 줄 별명과 짧은 설명으로 정리한다.
- SS는 핵심 선호, D는 강한 비선호로 가장 중요하게 반영한다.
- 장르만으로 단정하지 말고, 리뷰와 preferenceInsights를 최우선 근거로 삼는다.
- 특히 서사, 캐릭터, 주인공 성격, 감성, 작화/연출, 음악, 결말, 시즌별 편차를 고려한다.

매우 중요:
- 반드시 JSON 객체만 반환한다.
- 마크다운 코드블록을 절대 쓰지 마라.
- 설명문 안에 "json", "schema", "titleKo", "description", "예시", "provided examples" 같은 메타 설명을 절대 쓰지 마라.
- 한국어 중심으로 작성하되, titleEn만 자연스러운 영어 별명으로 작성한다.
- titleKo는 8-20자 정도의 짧은 별명이어야 한다.
- titleEn은 10-40자 정도의 짧은 영어 별명이어야 한다.
- description은 1-3문장, 90-220자 내외로만 작성한다.
- 설명은 결과만 말하고, 분석 과정이나 내부 규칙 설명은 절대 포함하지 마라.
`;

  const payload = {
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.4,
      topP: 0.8,
      topK: 20,
      maxOutputTokens: 220,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        required: ['titleKo', 'titleEn', 'description'],
        properties: {
          titleKo: { type: 'STRING' },
          titleEn: { type: 'STRING' },
          description: { type: 'STRING' }
        }
      }
    }
  };

  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite'
  ];

  const isBadProfileText = (value) => {
    const text = String(value || '').trim();
    if (!text) return true;

    return (
      text.includes('```') ||
      text.includes('titleKo') ||
      text.includes('titleEn') ||
      text.includes('"description"') ||
      text.includes('schema') ||
      text.includes('provided examples') ||
      text.includes('generation process') ||
      text.includes('must be') ||
      text.includes('{') ||
      text.includes('}')
    );
  };

  const sanitizeProfile = (raw) => {
    if (!raw || typeof raw !== 'object') return null;

    const titleKo = String(raw.titleKo || '').trim();
    const titleEn = String(raw.titleEn || '').trim();
    const description = String(raw.description || '').trim();

    if (!titleKo || !titleEn || !description) return null;
    if (titleKo.length > 40 || titleEn.length > 60 || description.length > 320) return null;
    if (isBadProfileText(titleKo) || isBadProfileText(titleEn) || isBadProfileText(description)) return null;

    return {
      titleKo,
      titleEn,
      description
    };
  };

  const parseGeminiJson = (text) => {
    const cleaned = String(text || '')
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();

    return JSON.parse(cleaned);
  };

  let lastError = null;

  for (const model of models) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 40000);

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        lastError = `Model ${model} failed: ${response.status} ${errText}`;
        continue;
      }

      const json = await response.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        lastError = `Model ${model} returned empty text`;
        continue;
      }

      let parsed;
      try {
        parsed = parseGeminiJson(text);
      } catch (parseErr) {
        lastError = `Model ${model} JSON parse failed: ${parseErr.message}`;
        continue;
      }

      const sanitized = sanitizeProfile(parsed);
      if (!sanitized) {
        lastError = `Model ${model} returned invalid profile shape/content`;
        continue;
      }

      return res.status(200).json(sanitized);
    } catch (err) {
      lastError = `Model ${model} error: ${err.message}`;
      continue;
    }
  }

  console.error('taste-profile failed:', lastError);
  return res.status(502).json({
    error: 'taste_profile_generation_failed',
    detail: lastError || 'Unknown error'
  });
}
