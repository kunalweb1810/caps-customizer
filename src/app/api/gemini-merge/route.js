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
 * Safely decodes base64 string to Buffer.
 */
function base64ToBuffer(base64String) {
  const matches = base64String.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (matches && matches.length === 3) {
    return Buffer.from(matches[2], 'base64');
  }
  return Buffer.from(base64String, 'base64');
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
  if (typeof imageInput === 'string' && (imageInput.startsWith('data:') || !imageInput.startsWith('http'))) {
    try {
      return base64ToBuffer(imageInput);
    } catch (e) {
      if (imageInput.startsWith('http')) {
        // Fall through to fetch if it looks like a URL
      } else {
        throw new Error(`Invalid base64 format for ${label}`);
      }
    }
  }

  const response = await fetch(normalizeImageUrl(imageInput));
  if (!response.ok) {
    throw new Error(`Unable to download ${label} from URL: ${imageInput}`);
  }
  return Buffer.from(await response.arrayBuffer());
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

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
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
      return Buffer.from(part.inlineData.data, 'base64');
    }
    console.warn('Gemini response did not contain inline image data.');
    return null;
  } catch (err) {
    console.error('Error calling Gemini API:', err);
    return null;
  }
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
    const optimizedPrompt = prompt || `This is a product photo of a cap with crochet stickers on it. 
Analyze the two input images:
- The first image is the cap product photo (which can be tilted, rotated, or angled).
- The second image is a transparent canvas guide containing crochet stickers.

Your goal is to realistically project the crochet stickers from the second image onto the cap in the first image, placing them in the exact relative positions as shown on the canvas.

CRITICAL REQUIREMENTS:
- Align the stickers to the 3D surface, contours, folds, and perspective of the cap. If the cap is angled or tilted, warp and rotate the stickers to match the cap's surface perfectly.
- Subtly enhance the local lighting, highlights, textures, and drop shadows of the stickers so they look physically attached (crocheted) onto the fabric of the cap.
- Do NOT alter the background, shape, color, or design of the original cap.
- Do NOT change the identity, design, or relative arrangement of the stickers.
- Make the final output look like a single, photorealistic product photo of the customized cap.`;

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
