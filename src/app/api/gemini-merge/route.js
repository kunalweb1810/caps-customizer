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
 * Composites the guide image onto the product image using Sharp.
 * The guide image is treated as the placement reference and the product image is the base.
 */
async function compositeImages(productImageUrl, guideImageUrl) {
  const productResponse = await fetch(productImageUrl);

  if (!productResponse.ok) {
    throw new Error('Unable to download product image');
  }

  const productBuffer = Buffer.from(await productResponse.arrayBuffer());

  if (!guideImageUrl) {
    return productBuffer;
  }

  const guideResponse = await fetch(guideImageUrl);

  if (!guideResponse.ok) {
    throw new Error('Unable to download guide image');
  }

  const guideBuffer = Buffer.from(await guideResponse.arrayBuffer());
  const productMetadata = await sharp(productBuffer).metadata();

  const resizedGuideBuffer = await sharp(guideBuffer)
    .resize({
      width: productMetadata.width || undefined,
      height: productMetadata.height || undefined,
      fit: 'contain',
      background: {
        r: 0,
        g: 0,
        b: 0,
        alpha: 0,
      },
    })
    .png()
    .toBuffer();

  return await sharp(productBuffer)
    .composite([{ input: resizedGuideBuffer, left: 0, top: 0 }])
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
async function enhanceWithGemini(compositedBuffer, promptText = '') {
  if (!process.env.GEMINI_API_KEY) {
    console.warn('GEMINI_API_KEY not set. Falling back to Sharp composite.');
    return compositedBuffer;
  }

  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
    });

    const base64Image = compositedBuffer.toString('base64');
    
   const defaultPrompt = `You are given two images:

Image 1: The original product photo of the cap.
Image 2: A placement guide image showing the intended design placement.

Task:
Use Image 2 as the placement guide and apply it to Image 1 to create a realistic final preview of the cap.

Requirements:
- Keep the original cap photo as the base.
- Preserve the cap shape, fabric, stitching, texture, color, shadows, lighting, folds, branding, and perspective.
- Preserve the exact camera angle, framing, crop, and resolution.
- Use the guide image only as the placement reference and do not redesign or reinterpret it.
- Keep every visible element from the guide image in the correct position relative to the cap.
- Do not add or remove design elements.
- Do not change the background.
- Return only the final composited product image.

Goal:
Produce a photorealistic preview of the original cap with the guide design applied exactly where specified.`;

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

    // 5. Composite the guide image onto the product image using Sharp
    const compositedBuffer = await compositeImages(normalizedProductUrl, normalizedGuideUrl);

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
