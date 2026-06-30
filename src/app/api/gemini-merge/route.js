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

async function loadImageBuffer(imageInput, label = 'image') {
  if (!imageInput) {
    return null;
  }

  if (typeof imageInput === 'string' && imageInput.startsWith('data:')) {
    return base64ToBuffer(imageInput);
  }

  const response = await fetch(normalizeImageUrl(imageInput));

  if (!response.ok) {
    throw new Error(`Unable to download ${label}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

/**
 * Composites the guide image onto the product image using Sharp.
 * The guide image is treated as the placement reference and the product image is the base.
 */
async function compositeImages(productImageUrl, guideImageUrl) {
  const productBuffer = await loadImageBuffer(productImageUrl, 'product image');

  if (!productBuffer) {
    throw new Error('Missing product image');
  }

  if (!guideImageUrl) {
    return productBuffer;
  }

  const guideBuffer = await loadImageBuffer(guideImageUrl, 'guide image');

  if (!guideBuffer) {
    return productBuffer;
  }

  const productMeta = await sharp(productBuffer).metadata();

const resizedGuideBuffer = await sharp(guideBuffer)
  .resize(
      productMeta.width,
      productMeta.height
  )
  .png()
  .toBuffer();

return sharp(productBuffer)
    .composite([
        {
            input: resizedGuideBuffer
        }
    ])
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
async function enhanceWithGemini(productBuffer, guideBuffer, promptText = '') {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set.');
    return null;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const prompt =
      promptText ||
      `You are given two images.

Image 1:
The original cap product photo.

Image 2:
A transparent placement guide.

Apply Image 2 onto Image 1 exactly.

Requirements:
- Keep the original cap photo.
- Preserve lighting.
- Preserve stitching.
- Preserve shadows.
- Preserve perspective.
- Preserve texture.
- Do not modify background.
- Do not invent new graphics.
- Use Image 2 only as placement reference.

Return only the final edited image.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-image-preview",
      contents: [
        {
          role: "user",
          parts: [
            {
              text: prompt,
            },
            {
              inlineData: {
                mimeType: "image/webp",
                data: productBuffer.toString("base64"),
              },
            },
            {
              inlineData: {
                mimeType: "image/png",
                data: guideBuffer.toString("base64"),
              },
            },
          ],
        },
      ],
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData?.data) {
        return Buffer.from(part.inlineData.data, "base64");
      }
    }

    return null;
  } catch (err) {
    console.error(err);
    return null;
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
      sticker,
      guide_image,
      guideImage,
      sticker_image,
      images,
      stickers,
    } = body;

    const guideImageInput =
      sticker ??
      guide_image ??
      guideImage ??
      sticker_image ??
      (typeof stickers === 'string' ? stickers : null) ??
      (Array.isArray(images) ? images[0] : null) ??
      (Array.isArray(stickers) && stickers[0]?.image ? stickers[0].image : null);

    const productImageInput =
      product_image ??
      (Array.isArray(images) ? images[1] : null);

    // 3. Validate payloads
    if (!productImageInput || !guideImageInput) {
      return NextResponse.json(
        {
          success: false,
          error: 'Invalid payload',
        },
        {
          status: 400,
          headers: CORS_HEADERS,
        }
      );
    }

    // 4. Normalize image URLs
    const normalizedProductUrl = normalizeImageUrl(productImageInput);
    const normalizedGuideUrl = normalizeImageUrl(guideImageInput);

  const productBuffer = await loadImageBuffer(
  normalizedProductUrl,
  "product image"
);

const guideBuffer = await loadImageBuffer(
  normalizedGuideUrl,
  "guide image"
);

const aiResult = await enhanceWithGemini(
  productBuffer,
  guideBuffer
);

const finalBuffer =
  aiResult ||
  (await compositeImages(
    normalizedProductUrl,
    normalizedGuideUrl
  ));

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
