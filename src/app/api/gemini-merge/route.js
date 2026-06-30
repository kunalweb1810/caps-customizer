import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';

// Constants and CORS config
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://kacaps.myshopify.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

/**
 * Dynamically construct CORS headers to support local development alongside production.
 */
function getCorsHeaders(req) {
  const origin = req.headers.get('origin');
  if (origin && (origin === 'https://kacaps.myshopify.com' || origin.includes('localhost') || origin.includes('127.0.0.1'))) {
    return {
      ...CORS_HEADERS,
      'Access-Control-Allow-Origin': origin,
    };
  }
  return CORS_HEADERS;
}

const MAX_PAYLOAD_SIZE = 15 * 1024 * 1024; // 15MB limit

/**
 * Normalizes protocol-relative image URLs.
 */
function normalizeImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  return url;
}

/**
 * Safely decodes base64 string to Buffer, removing prefix and newlines/spaces.
 */
function base64ToBuffer(base64String) {
  if (base64String.startsWith('data:')) {
    const commaIndex = base64String.indexOf(',');
    if (commaIndex !== -1) {
      const cleanData = base64String.slice(commaIndex + 1).replace(/[\s\r\n]+/g, '');
      return Buffer.from(cleanData, 'base64');
    }
  }
  const cleanData = base64String.replace(/[\s\r\n]+/g, '');
  return Buffer.from(cleanData, 'base64');
}

/**
 * Converts image Buffer back to data URL for frontend consumption.
 */
function bufferToDataUrl(buffer, mimeType = 'image/png') {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Loads an image from URL or base64 data string into a Buffer.
 */
async function loadImageBuffer(imageInput, label = 'image') {
  if (!imageInput) return null;
  if (typeof imageInput === 'string') {
    const trimmed = imageInput.trim();
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://') || trimmed.startsWith('//')) {
      const response = await fetch(normalizeImageUrl(trimmed));
      if (!response.ok) {
        throw new Error(`Unable to download ${label} from URL: ${trimmed}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } else {
      return base64ToBuffer(trimmed);
    }
  }
  throw new Error(`Invalid image input type for ${label}`);
}

/**
 * Deterministic fallback that overlays the transparent sticker canvas on top of the product image using Sharp.
 */
async function compositeImages(productBuffer, canvasBuffer) {
  const productMeta = await sharp(productBuffer).metadata();
  const resizedCanvasBuffer = await sharp(canvasBuffer)
    .resize(productMeta.width, productMeta.height, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();

  return sharp(productBuffer)
    .composite([{ input: resizedCanvasBuffer }])
    .png()
    .toBuffer();
}

/**
 * Utilizes the Gemini 2.5 Flash Image model to realistically blend the canvas stickers onto the product cap.
 */
async function enhanceWithGemini(productBuffer, canvasBuffer, promptText) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY environment variable is not set. Falling back to Sharp compositing.');
    return null;
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  const modelsToTry = ['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'];

  for (const model of modelsToTry) {
    try {
      console.log(`Attempting image generation with model: ${model}`);
      const response = await ai.models.generateContent({
        model: model,
        contents: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: productBuffer.toString('base64'),
            },
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: canvasBuffer.toString('base64'),
            },
          },
          promptText,
        ],
      });

      const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (part?.inlineData?.data) {
        console.log(`Successfully generated image using ${model}`);
        return Buffer.from(part.inlineData.data, 'base64');
      }
      console.warn(`Model ${model} completed but did not return inline image data.`);
    } catch (err) {
      console.error(`Error calling Gemini API with model ${model}:`, err.message || err);
    }
  }

  console.warn('All Gemini image-to-image models failed. Falling back to Sharp compositing.');
  return null;
}

export async function OPTIONS(req) {
  return new NextResponse(null, { headers: getCorsHeaders(req), status: 200 });
}

export async function POST(req) {
  const headers = getCorsHeaders(req);
  try {
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
      return NextResponse.json(
        { success: false, error: 'Payload too large' },
        { status: 413, headers }
      );
    }

    const body = await req.json();
    const { product_image, canvas_image, prompt } = body;

    if (!product_image || !canvas_image) {
      return NextResponse.json(
        { success: false, error: 'Missing product_image or canvas_image in payload' },
        { status: 400, headers }
      );
    }

    const productBuffer = await loadImageBuffer(product_image, 'product_image');
    const canvasBuffer = await loadImageBuffer(canvas_image, 'canvas_image');

    // Optimized blending prompt for realistic 3D projecting and shadow mapping
    const optimizedPrompt = prompt || `You are given two images:
1. A real product photo of a blank white cap (the target).
2. A transparent canvas layout containing only the custom stickers placed by the user (the layout guide).

Your goal: Isolate the stickers from the layout guide (Image 2) and project them onto the real product cap (Image 1) in the exact same positions.

CRITICAL REQUIREMENTS:
- Identify and isolate ONLY the stickers from Image 2. Completely ignore and discard any transparent space.
- Count the stickers in Image 2. You must place EXACTLY the same stickers in the EXACT same quantity and relative positions on the real cap in Image 1. Do NOT duplicate, multiply, or add any extra stickers. For example, if there is only one sticker on the front-right of the layout, place exactly one sticker on the front-right of the real cap.
- Adapt the stickers to the 3D surface, contours, orientation, and perspective of the real cap. Since the real cap is angled/rotated, warp, rotate, and skew the stickers so they look perfectly flat on the fabric of the real cap.
- Subtly blend the stickers into the fabric texture, adjusting local lighting, highlights, and adding realistic drop shadows to match the lighting direction in the real product photo.
- Keep the real cap's background, shape, texture, color, and design completely unchanged.
- The final output must be a single, photorealistic, high-quality product photo of the customized real cap.`;

    const aiResult = await enhanceWithGemini(productBuffer, canvasBuffer, optimizedPrompt);

    // Fallback to Sharp if API failed or key was not present
    const finalBuffer = aiResult || (await compositeImages(productBuffer, canvasBuffer));
    const finalDataUrl = bufferToDataUrl(finalBuffer, 'image/png');

    return NextResponse.json(
      { success: true, image: finalDataUrl },
      { status: 200, headers }
    );
  } catch (error) {
    console.error('Error processing gemini-merge request:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to process image merge', details: error.message },
      { status: 500, headers }
    );
  }
}
