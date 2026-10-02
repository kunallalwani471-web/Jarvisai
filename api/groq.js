export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'GROQ_API_KEY is not configured in Vercel.'
    });
  }

  try {
    const { contents = [], tools = [] } = req.body || {};

    if (!Array.isArray(contents) || contents.length === 0) {
      return res.status(400).json({
        error: 'Missing conversation contents.'
      });
    }

    const messages = [
      {
        role: 'system',
        content: `You are JARVIS, a highly capable personal AI assistant.

Personality:
- Polite, intelligent, calm, helpful and natural.
- Address the user as "sir" naturally, not in every sentence.
- Understand English, Hindi and Hinglish.
- Reply in the same language/style the user uses.
- Keep voice responses concise unless the user asks for detail.
- Never say "As an AI".
- Answer normal questions, coding questions, calculations, explanations and daily tasks.

Tool rules:
- Play music/videos: use playYouTube.
- Open a website: use openWebsiteInTV.
- Clear the display: use clearTV.
- Prediction requests: use runBigSmallPrediction.
- Current date/time: use getCurrentTime.
- When a tool is clearly required, call it instead of pretending you performed the action.
- After a tool result, give a short natural response to the user.`
      }
    ];

    // Convert the existing frontend Gemini-style history into
    // Groq/OpenAI-compatible chat messages.
    const pendingToolCallIds = new Map();

    for (let i = 0; i < contents.length; i++) {
      const item = contents[i] || {};
      const role = item.role === 'model' ? 'assistant' : 'user';
      const parts = Array.isArray(item.parts) ? item.parts : [];

      const functionCalls = parts.filter(p => p && p.functionCall);
      const functionResponses = parts.filter(p => p && p.functionResponse);
      const textParts = parts
        .filter(p => p && typeof p.text === 'string')
        .map(p => p.text)
        .filter(Boolean);

      if (functionCalls.length) {
        const toolCalls = functionCalls.map((p, j) => {
          const name = p.functionCall.name;
          const id = `call_${i}_${j}_${String(name).replace(/[^a-zA-Z0-9_-]/g, '')}`;
          const args = p.functionCall.args || {};
          const key = name;
          const queue = pendingToolCallIds.get(key) || [];
          queue.push(id);
          pendingToolCallIds.set(key, queue);

          return {
            id,
            type: 'function',
            function: {
              name,
              arguments: JSON.stringify(args)
            }
          };
        });

        messages.push({
          role: 'assistant',
          content: textParts.length ? textParts.join('\n') : null,
          tool_calls: toolCalls
        });
        continue;
      }

      if (functionResponses.length) {
        for (const p of functionResponses) {
          const name = p.functionResponse?.name || 'unknown_tool';
          const queue = pendingToolCallIds.get(name) || [];
          const toolCallId = queue.shift() || `call_fallback_${i}_${name}`;

          const result = p.functionResponse?.response?.result;
          messages.push({
            role: 'tool',
            tool_call_id: toolCallId,
            content: typeof result === 'string'
              ? result
              : JSON.stringify(result ?? {})
          });
        }
        continue;
      }

      if (textParts.length) {
        messages.push({
          role,
          content: textParts.join('\n')
        });
      }
    }

    const groqTools = Array.isArray(tools)
      ? tools
          .filter(t => t && t.name)
          .map(t => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description || '',
              parameters: t.parameters || {
                type: 'object',
                properties: {}
              }
            }
          }))
      : [];

    const requestBody = {
      model: 'openai/gpt-oss-20b',
      messages,
      temperature: 0.7,
      max_completion_tokens: 1200,
      tool_choice: groqTools.length ? 'auto' : 'none'
    };

    if (groqTools.length) {
      requestBody.tools = groqTools;
    }

    const response = await fetch(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      }
    );

    const raw = await response.text();

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      data = { error: raw || 'Invalid response from Groq.' };
    }

    if (!response.ok) {
      console.error('Groq API error:', response.status, data);

      return res.status(response.status).json({
        error:
          data?.error?.message ||
          data?.error ||
          `Groq API returned HTTP ${response.status}`,
        status: response.status
      });
    }

    const message = data?.choices?.[0]?.message;

    if (!message) {
      return res.status(502).json({
        error: 'Groq returned no assistant message.'
      });
    }

    // Convert Groq's response back to the Gemini-style shape
    // already expected by the existing frontend.
    const parts = [];

    if (message.content) {
      parts.push({ text: message.content });
    }

    if (Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call.type !== 'function') continue;

        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }

        parts.push({
          functionCall: {
            name: call.function?.name,
            args
          }
        });
      }
    }

    return res.status(200).json({
      candidates: [
        {
          content: {
            role: 'model',
            parts
          },
          finishReason: message.tool_calls?.length
            ? 'TOOL_CALLS'
            : 'STOP'
        }
      ]
    });

  } catch (error) {
    console.error('Groq server error:', error);

    return res.status(500).json({
      error: error?.message || 'Groq request failed.'
    });
  }
}
