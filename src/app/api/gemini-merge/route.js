import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';

// Initialize Google Gen AI
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || '',
});

// Constants
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://kacaps.myshopify.com',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024; // 10MB limit to prevent memory exhaustion

/**
 * Normalizes a URL, safely handling protocol-relative URLs.
 * Converts //cdn.shopify.com... to https://cdn.shopify.com...
 */
function normalizeImageUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) {
    return `https:${url}`;
  }
  return url;
}

/**
 * Strips the base64 prefix safely and converts to Buffer.
 * Supports standard data URIs (e.g., data:image/png;base64,...).
 */
function base64ToBuffer(base64String) {
  const matches = base64String.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
  if (matches && matches.length === 3) {
    return Buffer.from(matches[2], 'base64');
  }
  return Buffer.from(base64String, 'base64');
}

/**
 * Converts a raw image buffer to a base64 Data URL expected by the frontend.
 */
function bufferToDataUrl(buffer, mimeType = 'image/png') {
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/**
 * Composites the design onto the cap using Sharp for deterministic, precise placement.
 * 
 * WHY DETERMINISTIC COMPOSITING IS USED BEFORE AI ENHANCEMENT:
 * Generative AI models can sometimes hallucinate structural changes or alter exact positioning.
 * By using Sharp first, we ensure a pixel-perfect baseline where the sticker is exactly 
 * where the user placed it on the 2D canvas. The AI is then only used for "finishing touches" 
 * (lighting, shadows, realism) rather than structural composition.
 */
async function compositeImages(capImageUrl, canvasBase64) {
  // Download product image
  const response = await fetch(capImageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download product image: ${response.statusText}`);
  }
  const capBuffer = await response.arrayBuffer();
  const stickerBuffer = base64ToBuffer(canvasBase64);

  // Composite the sticker layer onto the cap image
  const compositedBuffer = await sharp(Buffer.from(capBuffer))
    .composite([{ input: stickerBuffer }])
    .png()
    .toBuffer();

  return compositedBuffer;
}

/**
 * Optionally enhances the composited image using Imagen 4.0 for realism.
 * 
 * GEMINI ENHANCEMENT FALLBACK:
 * This function attempts to invoke the Google Gen AI (Imagen) model to enhance shadows, lighting, and depth.
 * If the API times out, encounters a network error, or if the model does not return 
 * a valid image, the function safely catches the error and falls back to the original 
 * deterministic Sharp composite.
 */
async function enhanceWithGemini(compositedBuffer, promptText) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set. Falling back to Sharp composite.');
    return compositedBuffer;
  }

  try {
    const base64Image = compositedBuffer.toString('base64');
    
    const defaultPrompt = `
      Make this cap mockup photorealistic.
      Improve lighting, shadows, fabric texture,
      and depth.

      Preserve sticker positions exactly.
      Do not add or remove stickers.
    `;

    // Ensure we explicitly add the strict constraint to any custom prompt
    const finalPrompt = promptText 
      ? `${promptText}\n\nPreserve sticker positions exactly. Do not add or remove stickers.` 
      : defaultPrompt.trim();

    // Set up the API call
    const responsePromise = ai.models.generateImages({
      model: "imagen-4.0-generate-001",
      prompt: finalPrompt,
      image: {
        imageBytes: base64Image,
        mimeType: "image/png",
      },
      config: {
        numberOfImages: 1,
      },
    });

    // Enforce a timeout (15 seconds, image generation can take slightly longer)
    const response = await Promise.race([
      responsePromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Imagen API timeout')), 15000))
    ]);

    const generatedImage = response.generatedImages?.[0];
    
    // Extract base64 based on typical @google/genai response structures
    const outputBase64 = generatedImage?.image?.imageBytes || generatedImage?.imageBytes;

    if (outputBase64) {
      return Buffer.from(outputBase64, 'base64');
    } else {
      console.warn('Imagen did not return a valid base64 image. Falling back to Sharp composite.');
      return compositedBuffer;
    }
  } catch (error) {
    console.warn('Imagen enhancement failed, falling back to Sharp composite:', error.message);
    return compositedBuffer;
  }
}

/**
 * Handle OPTIONS requests for CORS support
 */
export async function OPTIONS() {
  return new NextResponse(null, { headers: CORS_HEADERS, status: 200 });
}

/**
 * Main POST handler for the gemini-merge route
 */
export async function POST(req) {
  try {
    // 1. Max payload size validation
    const contentLength = req.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_PAYLOAD_SIZE) {
      return NextResponse.json(
        { success: false, error: 'Payload too large' },
        { status: 413, headers: CORS_HEADERS }
      );
    }

    // 2. Parse JSON body
    const body = await req.json();
    const { canvas_image, product_image, prompt } = body;

    // 3. Validate payloads
    if (!canvas_image || !product_image) {
      return NextResponse.json(
        { success: false, error: 'Missing canvas_image or product_image' },
        { status: 400, headers: CORS_HEADERS }
      );
    }

    // 4. Normalize product image URL
    const normalizedProductUrl = normalizeImageUrl(product_image);

    // 5. Composite sticker layer onto cap image using Sharp
    const compositedBuffer = await compositeImages(normalizedProductUrl, canvas_image);

    // 6. Optionally enhance realism using Imagen 4.0 via @google/genai
    const finalBuffer = await enhanceWithGemini(compositedBuffer, prompt);

    // 7. Format the response data URL
    const finalDataUrl = bufferToDataUrl(finalBuffer, 'image/png');

    return NextResponse.json(
      { success: true, image: finalDataUrl },
      { status: 200, headers: CORS_HEADERS }
    );

  } catch (error) {
    // Safe error logging, no secret exposure
    console.error('Error processing gemini-merge request:', error.message);
    return NextResponse.json(
      { success: false, error: 'Failed to process image merge' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
