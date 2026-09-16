const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const { imageBase64, mimeType = 'image/jpeg', expectedKm, lrvId } = await request.json()
    if (!imageBase64 || typeof imageBase64 !== 'string') return json({ error: 'An image is required.' }, 400)
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(mimeType)) return json({ error: 'Unsupported image type.' }, 400)
    if (imageBase64.length > 12_000_000) return json({ error: 'Image exceeds the 8 MB limit.' }, 413)

    const apiKey = Deno.env.get('OPENAI_API_KEY')
    if (!apiKey) return json(demoResult(lrvId, expectedKm))

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: Deno.env.get('OPENAI_OCR_MODEL') || 'gpt-4.1-mini',
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: 'Read only the numeric kilometre value shown on this rail-vehicle hubometer. Preserve one decimal place when visible. Return a confidence from 0 to 1 based on digit visibility, glare, crop and ambiguity. Do not infer hidden digits from the expected value.' },
            { type: 'input_image', image_url: `data:${mimeType};base64,${imageBase64}`, detail: 'high' },
          ],
        }],
        text: {
          format: {
            type: 'json_schema', name: 'hubometer_reading', strict: true,
            schema: {
              type: 'object', additionalProperties: false,
              properties: {
                valueKm: { type: 'number', minimum: 0 },
                confidence: { type: 'number', minimum: 0, maximum: 1 },
              },
              required: ['valueKm', 'confidence'],
            },
          },
        },
      }),
    })
    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`OCR provider returned ${response.status}: ${detail.slice(0, 180)}`)
    }
    const payload = await response.json()
    const outputText = payload.output?.flatMap((item: { content?: Array<{ type?: string; text?: string }> }) => item.content || []).find((item: { type?: string }) => item.type === 'output_text')?.text
    const parsed = JSON.parse(outputText || '{}')
    if (!Number.isFinite(Number(parsed.valueKm)) || !Number.isFinite(Number(parsed.confidence))) throw new Error('OCR provider returned an invalid reading.')
    return json({ valueKm: Number(parsed.valueKm), confidence: Number(parsed.confidence), mode: 'openai_vision' })
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : 'OCR processing failed.' }, 500)
  }
})

function demoResult(lrvId: string, expectedKm: number) {
  const vehicleNumber = Number(String(lrvId || '').replace(/\D/g, '')) || 1
  const expected = Number(expectedKm) || 100000
  return {
    valueKm: Math.round((expected + (vehicleNumber % 5 - 2) * 0.1) * 10) / 10,
    confidence: vehicleNumber % 3 === 0 ? 0.68 : 0.94,
    mode: 'edge_demo',
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
