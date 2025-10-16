let expiredAt = null;
let endpoint = null;
let clientId = "76a75279-2ffa-4c3d-8db8-7b47252aa41c";

/**
 * OpenAI Compatible TTS API Handler
 * Endpoint: /v1/audio/speech
 * Format: OpenAI TTS API compatible
 * Platform: Cloudflare Pages Functions
 */
export async function onRequest(context) {
  const { request } = context;
  
  // Handle OPTIONS request (preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      }
    });
  }

  // Only allow POST method
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ 
      error: { 
        message: "Method not allowed. Use POST.",
        type: "invalid_request_error",
        code: "method_not_allowed"
      } 
    }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    });
  }

  try {
    const body = await request.json();
    
    // OpenAI format parameters
    const input = body.input || "";
    const voiceName = body.voice || "zh-CN-XiaoxiaoMultilingualNeural";
    const speed = Number(body.speed) || 1.0; // OpenAI default is 1.0
    const responseFormat = body.response_format || "mp3";
    const model = body.model || "tts-1"; // Ignored, but kept for compatibility
    
    // Validate input
    if (!input || input.trim() === "") {
      return new Response(JSON.stringify({ 
        error: { 
          message: "Invalid input: text cannot be empty",
          type: "invalid_request_error",
          code: "invalid_input"
        } 
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        }
      });
    }
    
    // Validate speed (OpenAI accepts 0.25 to 4.0)
    if (speed < 0.25 || speed > 4.0) {
      return new Response(JSON.stringify({ 
        error: { 
          message: "Invalid speed: must be between 0.25 and 4.0",
          type: "invalid_request_error",
          code: "invalid_speed"
        } 
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        }
      });
    }
    
    // Convert OpenAI parameters to Edge TTS format
    // OpenAI speed: 0.25 (25%) to 4.0 (400%)
    // Edge rate: -50% to +50% (where 0 is 100%)
    // Conversion: rate = (speed - 1.0) * 100, clamped to [-50, 50]
    let rate = (speed - 1.0) * 100;
    rate = Math.max(-50, Math.min(50, rate));
    
    // Map response format to Edge TTS output format
    const formatMap = {
      "mp3": "audio-24khz-48kbitrate-mono-mp3",
      "opus": "audio-24khz-16kbitrate-mono-opus",
      "aac": "audio-24khz-48kbitrate-mono-mp3", // Fallback to mp3
      "flac": "audio-24khz-48kbitrate-mono-mp3", // Fallback to mp3
      "wav": "riff-24khz-16bit-mono-pcm",
      "pcm": "raw-24khz-16bit-mono-pcm"
    };
    
    const outputFormat = formatMap[responseFormat] || formatMap["mp3"];
    
    // Use existing TTS handler with converted parameters
    return await handleTTS(input, voiceName, rate, 0, outputFormat, responseFormat);
    
  } catch (error) {
    console.error("OpenAI TTS API Error:", error);
    return new Response(JSON.stringify({ 
      error: { 
        message: error.message || "Internal Server Error",
        type: "internal_error",
        code: "internal_error"
      } 
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    });
  }
}

async function handleTTS(text, voiceName, rate, pitch, outputFormat, responseFormat) {
  try {
    await refreshEndpoint();
    
    // Generate SSML
    const ssml = generateSsml(text, voiceName, rate, pitch);
    
    // Get URL from endpoint
    const url = `https://${endpoint.r}.tts.speech.microsoft.com/cognitiveservices/v1`;
    
    // Set up headers
    const headers = {
      "Authorization": endpoint.t,
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": outputFormat,
      "User-Agent": "okhttp/4.5.0",
      "Origin": "https://azure.microsoft.com",
      "Referer": "https://azure.microsoft.com/"
    };
    
    // Make the request to Microsoft's TTS service
    const response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: ssml
    });
  
    // Handle errors
    if (!response.ok) {
      throw new Error(`TTS request failed with status ${response.status}`);
    }
  
    // Set appropriate content type based on response format
    const contentTypeMap = {
      "mp3": "audio/mpeg",
      "opus": "audio/opus",
      "aac": "audio/aac",
      "flac": "audio/flac",
      "wav": "audio/wav",
      "pcm": "audio/pcm"
    };
    
    const contentType = contentTypeMap[responseFormat] || "audio/mpeg";
    
    // Get the audio data
    const audioData = await response.arrayBuffer();
    
    // Return the audio response
    return new Response(audioData, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Access-Control-Allow-Origin": "*",
      }
    });
  } catch (error) {
    console.error("TTS Error:", error);
    return new Response(JSON.stringify({ 
      error: { 
        message: error.message,
        type: "internal_error",
        code: "tts_generation_failed"
      } 
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      }
    });
  }
}

function generateSsml(text, voiceName, rate, pitch) {
  return `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"> 
              <voice name="${voiceName}"> 
                  <mstts:express-as style="general" styledegree="1.0" role="default"> 
                      <prosody rate="${rate}%" pitch="${pitch}%" volume="50">${text}</prosody> 
                  </mstts:express-as> 
              </voice> 
          </speak>`;
}

async function refreshEndpoint() {
  if (!expiredAt || Date.now() / 1000 > expiredAt - 60) {
    try {
      endpoint = await getEndpoint();
      
      // Parse JWT token to get expiry time
      const parts = endpoint.t.split(".");
      if (parts.length >= 2) {
        const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const padding = '='.repeat((4 - base64.length % 4) % 4);
        const base64Padded = base64 + padding;
        const jsonPayload = atob(base64Padded);
        
        const decodedJwt = JSON.parse(jsonPayload);
        expiredAt = decodedJwt.exp;
      } else {
        // Default expiry if we can't parse the token
        expiredAt = (Date.now() / 1000) + 3600;
      }
      
      clientId = crypto.randomUUID().replace(/-/g, "");
      console.log(`获取 Endpoint, 过期时间剩余: ${((expiredAt - Date.now() / 1000) / 60).toFixed(2)} 分钟`);
    } catch (error) {
      console.error("无法获取或解析Endpoint:", error);
      throw error;
    }
  } else {
    console.log(`过期时间剩余: ${((expiredAt - Date.now() / 1000) / 60).toFixed(2)} 分钟`);
  }
}

async function getEndpoint() {
  const endpointUrl = "https://dev.microsofttranslator.com/apps/endpoint?api-version=1.0";
  const headers = {
    "Accept-Language": "zh-Hans",
    "X-ClientVersion": "4.0.530a 5fe1dc6c",
    "X-UserId": "0f04d16a175c411e",
    "X-HomeGeographicRegion": "zh-Hans-CN",
    "X-ClientTraceId": clientId || "76a75279-2ffa-4c3d-8db8-7b47252aa41c",
    "X-MT-Signature": await generateSignature(endpointUrl),
    "User-Agent": "okhttp/4.5.0",
    "Content-Type": "application/json; charset=utf-8",
    "Accept-Encoding": "gzip"
  };
  
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: headers
  });
  
  if (!response.ok) {
    throw new Error(`获取 Endpoint 失败，状态码 ${response.status}`);
  }
  
  return await response.json();
}

async function generateSignature(urlStr) {
  try {
    const url = urlStr.split("://")[1];
    const encodedUrl = encodeURIComponent(url);
    const uuidStr = crypto.randomUUID().replace(/-/g, "");
    const formattedDate = formatDate();
    const bytesToSign = `MSTranslatorAndroidApp${encodedUrl}${formattedDate}${uuidStr}`.toLowerCase();
    
    // Import the key for signing
    const keyData = base64ToArrayBuffer("oik6PdDdMnOXemTbwvMn9de/h9lFnfBaCWbGMMZqqoSaQaqUOqjVGm5NqsmjcBI1x+sS9ugjB55HEJWRiFXYFw==");
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: { name: 'SHA-256' } },
      false,
      ['sign']
    );
    
    // Sign the data
    const signature = await crypto.subtle.sign(
      'HMAC',
      key,
      new TextEncoder().encode(bytesToSign)
    );
    
    // Convert the signature to base64
    const signatureBase64 = arrayBufferToBase64(signature);
    
    return `MSTranslatorAndroidApp::${signatureBase64}::${formattedDate}::${uuidStr}`;
  } catch (error) {
    console.error("Generate signature error:", error);
    throw error;
  }
}

function formatDate() {
  const date = new Date();
  const utcString = date.toUTCString().replace(/GMT/, "").trim() + " GMT";
  return utcString.toLowerCase();
}

// Helper functions
function base64ToArrayBuffer(base64) {
  const binary_string = atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
