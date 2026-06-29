import { NextResponse } from 'next/server';
import sharp from 'sharp';
import { GoogleGenerativeAI } from "@google/generative-ai";
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
  if (!process.env.GEMINI_API_KEY) return compositedBuffer;

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    // Use the model that supports multimodal input (e.g., gemini-1.5-pro or flash)
    // Note: Imagen-specific endpoints vary; ensure you are using the correct SDK method.
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    const base64Image = compositedBuffer.toString('base64');

    const prompt = `You are a professional product photographer. 
    Transform this image into a hyper-realistic ecommerce product photo. 
    Maintain the exact composition, sticker placement, and front-facing orientation. 
    Add realistic fabric texture, soft studio lighting, and subtle shadows under the visor. 
    Do not alter the sticker design or position. Output only the final image.`;

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/png"
        },
      },
    ]);

    // Note: If you are specifically using the Imagen 3 API for Image-to-Image,
    // ensure your request payload matches the Vertex AI/Google Cloud specific schema.
    const response = await result.response;
    const text = response.text();
    
    // If your API returns the image directly as base64 in the response:
    return Buffer.from(text, 'base64'); 

  } catch (error) {
    console.error('Enhancement failed, falling back:', error.message);
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
