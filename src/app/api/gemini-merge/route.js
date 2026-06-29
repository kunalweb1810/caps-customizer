import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { GoogleGenAI } from '@google/genai';

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
async function compositeImages(productImageUrl, stickers) {

    const response = await fetch(productImageUrl);

    if (!response.ok) {
        throw new Error("Unable to download cap image");
    }

    const capBuffer = Buffer.from(await response.arrayBuffer());

    const composites = [];

    for (const sticker of stickers) {

        const stickerResponse = await fetch(sticker.image);

        if (!stickerResponse.ok) continue;

        const stickerBuffer = Buffer.from(
            await stickerResponse.arrayBuffer()
        );

        const transformed = await sharp(stickerBuffer)
            .resize(sticker.width, sticker.height)
            .rotate(sticker.rotation, {
                background: {
                    r:0,
                    g:0,
                    b:0,
                    alpha:0
                }
            })
            .png()
            .toBuffer();

        composites.push({

            input: transformed,

            left: sticker.x,

            top: sticker.y

        });

    }

    return await sharp(capBuffer)
        .composite(composites)
        .png()
        .toBuffer();

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
async function enhanceWithGemini(compositedBuffer) {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set. Falling back to Sharp composite.');
    return compositedBuffer;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const base64Image = compositedBuffer.toString('base64');
    
   const defaultPrompt = `You are editing an existing product photograph.

The uploaded image already contains the correct sticker positions.

Do NOT move, resize, rotate, replace, remove or duplicate any sticker.

Treat every sticker as if it has already been printed onto the cap.

Improve only:

• lighting
• fabric texture
• soft shadow beneath each sticker
• realistic print blending
• natural perspective
• stitching visibility

Do not change the cap angle.

Do not change the background.

Do not crop.

Do not generate a new cap.

Only make the printed stickers look professionally applied.`;

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
      new Promise((_, reject) => setTimeout(() => reject(new Error('Imagen API timeout')), 45000))
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
    const {
    product_image,
    stickers
} = body;

    // 3. Validate payloads
    if(
    !product_image ||
    !Array.isArray(stickers)
){
    return NextResponse.json(
    {
        success:false,
        error:"Invalid payload"
    },
    {
        status:400,
        headers:CORS_HEADERS
    });
}

    // 4. Normalize product image URL
    const normalizedProductUrl = normalizeImageUrl(product_image);

    // 5. Composite sticker layer onto cap image using Sharp
    const compositedBuffer =
await compositeImages(
    normalizedProductUrl,
    stickers
);

    // 6. Optionally enhance realism using Imagen 4.0 via @google/genai
    const finalBuffer = await enhanceWithGemini(compositedBuffer);

    // 7. Format the response data URL
    const finalDataUrl = bufferToDataUrl(finalBuffer, 'image/png');

    return NextResponse.json(
      { success: true, image: finalDataUrl },
      { status: 200, headers: CORS_HEADERS }
    );

  } catch (error) {
    // Safe error logging, no secret exposure
    console.error('Error processing gemini-merge request:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to process image merge', details: error.message },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
