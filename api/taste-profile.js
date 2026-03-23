export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const { s, a, b, c } = req.body;
    const apiKey = process.env.GEMINI_API_KEY;

    const payload = {
        contents: [{
            parts: [{ text: `사용자의 티어리스트 (S: ${s}, A: ${a}, B: ${b}, C: ${c}). 이 데이터를 바탕으로 사용자의 애니메이션 취향을 나타내는 별명을 만들고 짧게 설명해.` }]
        }],
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
                type: "OBJECT",
                properties: {
                    titleKo: { type: "STRING" },
                    titleEn: { type: "STRING" },
                    description: { type: "STRING" }
                }
            }
        }
    };

    let result = null;
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
                result = JSON.parse(text.replace(/```json/g, '').replace(/```/g, '').trim());
                break;
            }
        } catch(e) {
            continue;
        }
    }

    if (!result) {
        return res.status(429).json({ error: 'AI limit reached' });
    }

    return res.status(200).json(result);
}